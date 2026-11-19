// An HTTP API over dpdp-kit, without any framework: the routes a privacy centre, a consent screen
// or a mobile app needs. `dpdp-kit/express`, `dpdp-kit/hono` and `dpdp-kit/next` mount it.
import type { Dpdp } from "./dpdp.js";
import { DpdpError, type DpdpErrorCode } from "./errors.js";
import type { NoticeLanguage } from "./languages.js";
import type { NoticeKind } from "./notice.js";
import { REQUEST_TYPES, type RequestType, type RightsRequest } from "./records.js";

/** One request, as the adapters hand it over. */
export interface HttpRequest {
  method: string;
  /** The path below where the API is mounted, e.g. `"/consents"`. */
  path: string;
  query?: Readonly<Record<string, string | undefined>>;
  /** The parsed JSON body, if any. */
  body?: unknown;
  /** The `Content-Type` header. POST requests must be `application/json`. */
  contentType?: string;
  /** The signed-in person, from your own authentication. Never from the request itself. */
  subjectId?: string;
  /** The signed-in staff member, for `/admin` routes, from your own authentication. */
  actor?: string;
  ip?: string;
  userAgent?: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface HttpOptions {
  /** Whether `/admin` routes exist. The adapters set this when you pass `admin`. */
  admin?: boolean;
  /**
   * Called before each change a person makes (consents, objections, requests, nominees). Return
   * false to refuse it with 429, e.g. to stop a script flooding someone's consent record.
   */
  limitWrites?: (subjectId: string) => boolean | Promise<boolean>;
  /** Recorded as the consent event's `channel`. Default `"web"`. */
  channel?: string;
  /** Unexpected errors (not `DpdpError`). Default `console.error`. They answer 500 `{ error: "internal" }`. */
  onError?: (err: unknown) => void;
}

/** Statuses for error codes; every other `DpdpError` is 400. */
const STATUS: Partial<Record<DpdpErrorCode | string, number>> = {
  "request-not-found": 404,
  "nominee-not-found": 404,
  "notice-not-configured": 404,
  "notice-language-unavailable": 404,
  "request-closed": 409,
  "write-conflict": 409,
  "notice-version-conflict": 409,
  "request-not-verified": 403,
  "store-unsupported": 501,
  "no-data-access": 501,
  "data-access-unsupported": 501,
};

const fail = (status: number, error: string): HttpResponse => ({ status, body: { error } });
const ok = (body: unknown, status = 200): HttpResponse => ({ status, body });

class HttpError extends Error {
  constructor(readonly response: HttpResponse) {
    super(String((response.body as { error: string }).error));
  }
}
const refuse = (status: number, error: string): never => {
  throw new HttpError(fail(status, error));
};

const isJson = (contentType: string | undefined) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? "");

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    refuse(400, `invalid-${name}`);
  }
  return value as string[];
}
const text = (value: unknown, name: string): string => (typeof value === "string" && value.trim() ? value : refuse(400, `invalid-${name}`));
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A request as the person sees it: without who on your staff handled it. */
function forPerson(r: RightsRequest) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    openedAt: r.openedAt,
    dueAt: r.dueAt,
    ...(r.closedAt ? { closedAt: r.closedAt } : {}),
    ...(r.details ? { details: r.details } : {}),
    history: r.history.map(({ by: _by, method: _method, ...entry }) => entry),
  };
}

/**
 * Answer one request. Person routes need `subjectId`; `/admin` routes need `actor` and
 * `options.admin`. Errors answer `{ error: code }` with no message, so nothing internal leaks.
 */
export async function handle<P extends string>(dpdp: Dpdp<P>, req: HttpRequest, options: HttpOptions = {}): Promise<HttpResponse> {
  try {
    return await route(dpdp, req, options);
  } catch (err) {
    if (err instanceof HttpError) return err.response;
    if (err instanceof DpdpError) return fail(STATUS[err.code] ?? 400, err.code);
    (options.onError ?? console.error)(err);
    return fail(500, "internal");
  }
}

async function route<P extends string>(dpdp: Dpdp<P>, req: HttpRequest, options: HttpOptions): Promise<HttpResponse> {
  const method = req.method.toUpperCase();
  const parts = req.path.split("/").filter(Boolean).map(decodeURIComponent);
  const query = req.query ?? {};
  if (method === "POST" && !isJson(req.contentType)) return fail(415, "unsupported-media-type");
  const body = object(req.body);
  const is = (m: string, ...pattern: string[]) =>
    method === m && parts.length === pattern.length && pattern.every((p, i) => p.startsWith(":") || p === parts[i]);

  // ---- Public: what anyone may read before signing in ----
  if (is("GET", "notice")) {
    const language = query.language as NoticeLanguage | undefined;
    return ok(await dpdp.notice.show({ ...(language ? { language } : {}), ...(query.kind ? { kind: query.kind as NoticeKind } : {}) }));
  }
  if (is("GET", "rights")) return ok(dpdp.rights.how());

  if (parts[0] === "admin") return admin(dpdp, req, parts.slice(1), method, body, options);

  // ---- The signed-in person ----
  const subjectId = req.subjectId;
  if (!subjectId) return fail(401, "unauthenticated");
  const write = method !== "GET";
  if (write && options.limitWrites && !(await options.limitWrites(subjectId))) return fail(429, "too-many-requests");
  const meta = {
    channel: options.channel ?? "web",
    ...(req.ip || req.userAgent ? { evidence: { ...(req.ip ? { ip: req.ip } : {}), ...(req.userAgent ? { userAgent: req.userAgent } : {}) } } : {}),
  };
  const purposes = () => strings(body.purposes, "purposes") as P[];

  if (is("GET", "consents")) {
    const [consents, objections] = await Promise.all([dpdp.consent.active(subjectId), dpdp.consent.objections(subjectId)]);
    const list = Object.entries(dpdp.config.purposes as Record<string, { basis: string; description?: string; legitimateUse?: string }>).map(
      ([purpose, def]) => ({
        purpose,
        basis: def.basis,
        ...(def.description ? { description: def.description } : {}),
        ...(def.legitimateUse ? { legitimateUse: def.legitimateUse } : {}),
        active: def.basis === "consent" ? (consents as string[]).includes(purpose) : !(objections as string[]).includes(purpose),
      }),
    );
    return ok({ consents, objections, purposes: list });
  }
  if (is("POST", "consents")) {
    const language = typeof body.language === "string" ? body.language : undefined;
    const event = await dpdp.consent.grant(subjectId, purposes(), { ...meta, ...(language ? { language: language as NoticeLanguage } : {}) });
    return ok({ event }, 201);
  }
  if (is("POST", "consents", "withdraw")) {
    const { event, tasks } = await dpdp.consent.withdraw(subjectId, purposes(), meta);
    return ok({ event, scheduled: tasks.length });
  }
  if (is("POST", "objections")) {
    const { event, tasks } = await dpdp.consent.object(subjectId, purposes(), meta);
    return ok({ event, scheduled: tasks.length }, 201);
  }
  if (is("DELETE", "objections")) {
    // DELETE bodies don't survive every client and proxy, so ?purposes=a,b works too.
    const list = body.purposes ?? query.purposes?.split(",").filter(Boolean);
    const { event, cancelled } = await dpdp.consent.liftObjection(subjectId, strings(list, "purposes") as P[], meta);
    return ok({ event, cancelled: cancelled.length });
  }
  if (is("GET", "data")) return ok(await dpdp.rights.summary(subjectId));
  if (is("GET", "requests")) return ok({ requests: (await dpdp.rights.list({ subjectId })).map(forPerson) });
  if (is("GET", "requests", ":id")) {
    const r = await dpdp.rights.get(parts[1]!);
    return r && r.subjectId === subjectId ? ok(forPerson(r)) : fail(404, "request-not-found");
  }
  if (is("POST", "requests")) {
    const type = body.type as RequestType;
    if (!REQUEST_TYPES.includes(type)) return fail(400, "invalid-request-type");
    const details = body.details === undefined ? undefined : object(body.details);
    const request = await dpdp.rights.open(subjectId, type, details);
    return ok({ request: forPerson(request), acknowledgement: await dpdp.rights.acknowledgement(request.id) }, 201);
  }
  if (is("GET", "nominees")) return ok({ nominees: await dpdp.rights.nominees(subjectId) });
  if (is("POST", "nominees")) {
    const nominee = await dpdp.rights.nominate(subjectId, {
      name: text(body.name, "name"),
      contact: text(body.contact, "contact"),
      ...(typeof body.relation === "string" ? { relation: body.relation } : {}),
    });
    return ok({ nominee }, 201);
  }
  if (is("DELETE", "nominees", ":id")) {
    await dpdp.rights.revokeNominee(subjectId, parts[1]!);
    return ok({ revoked: true });
  }
  return fail(404, "not-found");
}

/** Staff routes: answering requests. Exists only with `options.admin`; needs `actor`. */
async function admin<P extends string>(
  dpdp: Dpdp<P>,
  req: HttpRequest,
  parts: string[],
  method: string,
  body: Record<string, unknown>,
  options: HttpOptions,
): Promise<HttpResponse> {
  if (!options.admin) return fail(404, "not-found");
  const by = req.actor;
  if (!by) return fail(403, "forbidden");
  const is = (m: string, ...pattern: string[]) =>
    method === m && parts.length === pattern.length && pattern.every((p, i) => p.startsWith(":") || p === parts[i]);
  const id = parts[1]!;
  const query = req.query ?? {};

  if (is("GET", "requests")) {
    const status = query.status as RightsRequest["status"] | undefined;
    return ok({
      requests: await dpdp.rights.list({
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(status ? { status } : {}),
        ...(query.overdue === "true" ? { overdue: true } : {}),
      }),
    });
  }
  if (is("GET", "requests", ":id")) {
    const r = await dpdp.rights.get(id);
    return r ? ok(r) : fail(404, "request-not-found");
  }
  if (is("GET", "requests", ":id", "data")) {
    const r = (await dpdp.rights.get(id)) ?? refuse(404, "request-not-found");
    return ok(await dpdp.rights.summary(r.subjectId, { requestId: id }));
  }
  if (is("POST", "requests", ":id", "verify")) return ok(await dpdp.rights.verifyIdentity(id, { method: text(body.method, "method"), by }));
  if (is("POST", "requests", ":id", "resolve")) return ok(await dpdp.rights.resolve(id, typeof body.note === "string" ? body.note : undefined, { by }));
  if (is("POST", "requests", ":id", "reject")) return ok(await dpdp.rights.reject(id, text(body.reason, "reason"), { by }));
  if (is("POST", "requests", ":id", "correct")) {
    const where = body.where === undefined ? undefined : object(body.where);
    const result = await dpdp.rights.correct(id, object(body.changes), { by, ...(where ? { where } : {}), ...(body.resolve === false ? { resolve: false } : {}) });
    return ok(result);
  }
  if (is("POST", "requests", ":id", "erase")) {
    const r = (await dpdp.rights.get(id)) ?? refuse(404, "request-not-found");
    const keepFor = body.keepFor === undefined ? [] : strings(body.keepFor, "keepFor");
    const { tasks } = await dpdp.rights.erase(r.subjectId, { requestId: id, keepFor: keepFor as P[], by });
    return ok({ scheduled: tasks.length });
  }
  return fail(404, "not-found");
}

/** Read a body of at most `limit` bytes as JSON. An empty body is `undefined`. */
export function parseJsonBody(raw: string, limit: number): unknown {
  if (new TextEncoder().encode(raw).length > limit) throw new HttpError(fail(413, "payload-too-large"));
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(fail(400, "invalid-json"));
  }
}

/** The default body limit: 16 KiB, plenty for consents and requests. */
export const DEFAULT_BODY_LIMIT = 16 * 1024;

/** `parseJsonBody` as a response when it fails. */
export function bodyOrResponse(raw: string, limit: number): { body: unknown } | { response: HttpResponse } {
  try {
    return { body: parseJsonBody(raw, limit) };
  } catch (err) {
    if (err instanceof HttpError) return { response: err.response };
    throw err;
  }
}

/** Options shared by the framework adapters. `Req` is the framework's request or context. */
export interface ApiOptions<Req> extends Omit<HttpOptions, "admin"> {
  /** The signed-in person's id, from your authentication. `undefined` answers 401. */
  subject: (req: Req) => string | undefined | Promise<string | undefined>;
  /**
   * The signed-in staff member's id, for `/admin` routes, or `undefined` for anyone else (403).
   * Without this option the `/admin` routes don't exist.
   */
  admin?: (req: Req) => string | undefined | Promise<string | undefined>;
  /** Largest body accepted, in bytes. Default 16 KiB. */
  bodyLimit?: number;
}

/**
 * The API over Web `Request` and `Response`, for Hono, Next.js route handlers and other
 * fetch-style servers. `base` is the path the API is mounted at, e.g. `"/api/privacy"`.
 */
export async function handleWeb<P extends string, Req>(
  dpdp: Dpdp<P>,
  request: Request,
  ctx: Req,
  options: ApiOptions<Req> & { base?: string; ip?: (req: Req) => string | undefined; readBody?: () => Promise<string> },
): Promise<Response> {
  const url = new URL(request.url);
  const base = (options.base ?? "").replace(/\/+$/, "");
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
  const json = (r: HttpResponse) => Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });

  let body: unknown;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    const limit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
    if (declared > limit) return json(fail(413, "payload-too-large"));
    const parsed = bodyOrResponse(await (options.readBody ? options.readBody() : request.text()), limit);
    if ("response" in parsed) return json(parsed.response);
    body = parsed.body;
  }
  const [subjectId, actor] = await Promise.all([options.subject(ctx), options.admin?.(ctx)]);
  const ip = options.ip?.(ctx);
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const contentType = request.headers.get("content-type") ?? undefined;
  return json(
    await handle(
      dpdp,
      {
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams),
        body,
        ...(contentType ? { contentType } : {}),
        ...(subjectId ? { subjectId } : {}),
        ...(actor ? { actor } : {}),
        ...(ip ? { ip } : {}),
        ...(userAgent ? { userAgent } : {}),
      },
      { ...options, admin: options.admin !== undefined },
    ),
  );
}
