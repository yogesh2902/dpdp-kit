import type { Dpdp } from "./dpdp.js";
import { type ApiOptions, bodyOrResponse, DEFAULT_BODY_LIMIT, handle } from "./http.js";
import { type AccessLogOptions, checkConsent, consentDeniedBody, type GuardOptions, recordAccess } from "./guard.js";

/** The parts of Express's response this middleware uses. */
interface ResponseLike {
  status(code: number): { json(body: unknown): unknown };
}
type Next = (err?: unknown) => void;

export interface ExpressGuardOptions<Req, Res> extends GuardOptions<Req> {
  /** Send your own response when consent is missing. Default: 403 with a JSON body. */
  onDenied?: (req: Req, res: Res, purpose: string) => void;
}

/**
 * Express middleware that lets the request through only if the person may be processed for
 * `purpose`.
 *
 * ```ts
 * app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (req) => req.user?.id }), handler);
 * ```
 */
export function requireConsent<P extends string, Req = any, Res extends ResponseLike = any>(
  dpdp: Dpdp<P>,
  purpose: P,
  options: ExpressGuardOptions<Req, Res>,
) {
  return (req: Req, res: Res, next: Next): void => {
    checkConsent(dpdp, purpose, options, req).then(
      (ok) => {
        if (ok) return next();
        if (options.onDenied) return options.onDenied(req, res, purpose);
        res.status(403).json(consentDeniedBody(dpdp, purpose));
      },
      (err) => next(err),
    );
  };
}

/**
 * Express middleware that records each request in the access log (Rule 6(1)(c)) before the
 * handler runs. If logging fails, or the fields aren't held for the purpose and the instance was
 * created with `access: { outOfPurpose: "throw" }`, the error goes to `next(err)` and the handler
 * doesn't run.
 *
 * ```ts
 * app.get("/admin/users/:id", logAccess(dpdp, {
 *   purpose: "account",
 *   fields: ["users"],
 *   actor: (req) => req.staff?.id,
 *   subject: (req) => req.params.id,
 * }), handler);
 * ```
 */
export function logAccess<P extends string, Req = any>(dpdp: Dpdp<P>, options: AccessLogOptions<Req, P>) {
  return (req: Req, _res: unknown, next: Next): void => {
    recordAccess(dpdp, options, req).then(() => next(), (err) => next(err));
  };
}

/** The parts of Express's request the API uses. */
interface ApiRequestLike {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", listener: (err?: unknown) => void): unknown;
}
interface ApiResponseLike {
  status(code: number): { json(body: unknown): unknown };
  setHeader(name: string, value: string): unknown;
}

const header = (req: ApiRequestLike, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The request body as text, or `null` when it's over `limit` bytes, for apps without express.json(). */
function readBody(req: ApiRequestLike, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The dpdp-kit HTTP API as Express middleware: consents, objections, the notice, the person's data,
 * rights requests and nominees, and optional `/admin` routes for your privacy team. The person is
 * whoever `subject` says is signed in; nothing in the request can choose someone else.
 *
 * ```ts
 * app.use("/privacy", dpdpRouter(dpdp, { subject: (req) => req.user?.id, admin: (req) => req.staff?.id }));
 * ```
 *
 * Works with or without `express.json()` before it. Unknown paths go on to your next handler.
 */
export function dpdpRouter<P extends string, Req extends ApiRequestLike = any, Res extends ApiResponseLike = any>(
  dpdp: Dpdp<P>,
  options: ApiOptions<Req>,
) {
  const limit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  return (req: Req, res: Res, next: Next): void => {
    (async () => {
      let body: unknown = req.body;
      if (body === undefined && req.method !== "GET" && req.method !== "HEAD") {
        if (Number(header(req, "content-length") ?? 0) > limit) return { status: 413, body: { error: "payload-too-large" } };
        const raw = await readBody(req, limit);
        if (raw === null) return { status: 413, body: { error: "payload-too-large" } };
        const parsed = bodyOrResponse(raw, limit);
        if ("response" in parsed) return parsed.response;
        body = parsed.body;
      }
      const [subjectId, actor] = await Promise.all([options.subject(req), options.admin?.(req)]);
      const query = Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v)]));
      const contentType = header(req, "content-type");
      const userAgent = header(req, "user-agent");
      return handle(
        dpdp,
        {
          method: req.method,
          path: req.path,
          query,
          body,
          ...(contentType ? { contentType } : {}),
          ...(subjectId ? { subjectId } : {}),
          ...(actor ? { actor } : {}),
          ...(req.ip ? { ip: req.ip } : {}),
          ...(userAgent ? { userAgent } : {}),
        },
        { ...options, admin: options.admin !== undefined },
      );
    })().then(
      (r) => {
        if (r.status === 404 && (r.body as { error?: string }).error === "not-found") return next();
        res.setHeader("cache-control", "no-store");
        res.status(r.status).json(r.body);
      },
      (err) => next(err),
    );
  };
}
