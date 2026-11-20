// A typed client for the dpdp-kit HTTP API (`dpdpRouter`, `dpdpRoutes`, `dpdp-kit/next`), for
// browsers, React Native and other servers. It imports types only, so it adds nothing that needs
// Node.js to a frontend bundle.
import type {
  AccessSummary,
  AdminRequestsResponse,
  ConsentsResponse,
  CorrectResponse,
  ErrorResponse,
  GrantResponse,
  LiftObjectionResponse,
  NominateResponse,
  NomineesResponse,
  NoticeLanguagesResponse,
  OpenRequestResponse,
  PersonRequest,
  PrivacyNotice,
  RequestsResponse,
  RightsInfo,
  WithdrawResponse,
} from "./http.js";
import type { NoticeLanguage } from "./languages.js";
import type { NoticeKind } from "./notice.js";
import type { Nominee, RequestType, RightsRequest } from "./records.js";

/** An error answer from the API: the HTTP status and the `DpdpError` (or HTTP) code. */
export class DpdpClientError extends Error {
  override readonly name = "DpdpClientError";
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** What `new Headers()` accepts: an object, `[name, value]` pairs or a `Headers`. */
export type HeadersLike = NonNullable<ConstructorParameters<typeof Headers>[0]>;

export interface ClientOptions {
  /**
   * Where the API is mounted: `"/privacy"` (the default) on the same site, or a full URL such as
   * `"https://api.example.in/privacy"`. React Native needs a full URL.
   */
  base?: string;
  /** Headers for every request, e.g. `{ authorization: \`Bearer ${token}\` }` in a mobile app. A function is called each time. */
  headers?: HeadersLike | (() => HeadersLike | Promise<HeadersLike>);
  /** `"include"` to send cookies to an API on another origin. Default: the browser's (`"same-origin"`). */
  credentials?: RequestInit["credentials"];
  /** A `fetch` to use instead of the global one, e.g. in tests. */
  fetch?: typeof fetch;
}

/** The person's side of the API, plus `admin` for your privacy team's screens. */
export interface DpdpClient<P extends string = string> {
  /** The privacy notice (Rule 3), in a language and of a kind. Saved as proof the first time it's shown. */
  notice(options?: { language?: NoticeLanguage; kind?: NoticeKind }): Promise<PrivacyNotice>;
  /** Languages the notice is available in: English, then each translation. */
  languages(): Promise<NoticeLanguage[]>;
  /** How to make a request, identifiers and answer times (Rule 14(1)). */
  rights(): Promise<RightsInfo>;
  /** The person's consents and objections, and every purpose with whether it's active. */
  consents(): Promise<ConsentsResponse<P>>;
  /** Grant consent; the server records the notice version shown in `language`. */
  grant(purposes: readonly P[], options?: { language?: NoticeLanguage }): Promise<GrantResponse>;
  withdraw(purposes: readonly P[]): Promise<WithdrawResponse>;
  /** Object to Section 7(a) uses. */
  object(purposes: readonly P[]): Promise<WithdrawResponse>;
  liftObjection(purposes: readonly P[]): Promise<LiftObjectionResponse>;
  /** What you hold about the person, and who it's shared with (Section 11). */
  data(): Promise<AccessSummary>;
  requests(): Promise<PersonRequest[]>;
  request(id: string): Promise<PersonRequest>;
  /** Open a rights request; answers with the request and the acknowledgement to show. */
  openRequest(type: RequestType, details?: Record<string, unknown>): Promise<OpenRequestResponse>;
  nominees(): Promise<Nominee[]>;
  nominate(nominee: { name: string; contact: string; relation?: string }): Promise<Nominee>;
  revokeNominee(id: string): Promise<void>;
  /** Staff routes; the API answers 403 unless your `admin` option says the caller is staff. */
  readonly admin: {
    requests(filter?: { status?: RightsRequest["status"]; overdue?: boolean; subjectId?: string }): Promise<RightsRequest[]>;
    request(id: string): Promise<RightsRequest>;
    data(id: string): Promise<AccessSummary>;
    verify(id: string, method: string): Promise<RightsRequest>;
    resolve(id: string, note?: string): Promise<RightsRequest>;
    reject(id: string, reason: string): Promise<RightsRequest>;
    correct(
      id: string,
      changes: Record<string, unknown>,
      options?: { where?: Record<string, string | number | boolean>; resolve?: boolean },
    ): Promise<CorrectResponse>;
    erase(id: string, options?: { keepFor?: readonly P[] }): Promise<{ scheduled: number }>;
  };
}

/**
 * A client for the dpdp-kit HTTP API.
 *
 * ```ts
 * const privacy = createClient<"marketing_sms" | "analytics">({ base: "/privacy" });
 * const { purposes } = await privacy.consents();
 * await privacy.grant(["marketing_sms"], { language: "hi" });
 * ```
 */
export function createClient<P extends string = string>(options: ClientOptions = {}): DpdpClient<P> {
  const base = (options.base ?? "/privacy").replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, input: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const doFetch = options.fetch ?? globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("No fetch available: pass options.fetch");
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) query.set(k, v);
    const qs = query.toString();
    const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers);
    headers.set("accept", "application/json");
    if (input.body !== undefined) headers.set("content-type", "application/json");
    const res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const code = typeof (body as ErrorResponse | undefined)?.error === "string" ? (body as ErrorResponse).error : `http-${res.status}`;
      throw new DpdpClientError(res.status, code);
    }
    return body as T;
  }
  const id = (value: string) => `/${encodeURIComponent(value)}`;

  return {
    notice: (o = {}) => call<PrivacyNotice>("GET", "/notice", { query: { language: o.language, kind: o.kind } }),
    languages: async () => (await call<NoticeLanguagesResponse>("GET", "/notice/languages")).languages,
    rights: () => call<RightsInfo>("GET", "/rights"),
    consents: () => call<ConsentsResponse<P>>("GET", "/consents"),
    grant: (purposes, o = {}) => call<GrantResponse>("POST", "/consents", { body: { purposes, ...(o.language ? { language: o.language } : {}) } }),
    withdraw: (purposes) => call<WithdrawResponse>("POST", "/consents/withdraw", { body: { purposes } }),
    object: (purposes) => call<WithdrawResponse>("POST", "/objections", { body: { purposes } }),
    // DELETE bodies don't survive every proxy, so the purposes go in the query.
    liftObjection: (purposes) => call<LiftObjectionResponse>("DELETE", "/objections", { query: { purposes: purposes.join(",") } }),
    data: () => call<AccessSummary>("GET", "/data"),
    requests: async () => (await call<RequestsResponse>("GET", "/requests")).requests,
    request: (requestId) => call<PersonRequest>("GET", `/requests${id(requestId)}`),
    openRequest: (type, details) => call<OpenRequestResponse>("POST", "/requests", { body: { type, ...(details ? { details } : {}) } }),
    nominees: async () => (await call<NomineesResponse>("GET", "/nominees")).nominees,
    nominate: async (nominee) => (await call<NominateResponse>("POST", "/nominees", { body: nominee })).nominee,
    revokeNominee: async (nomineeId) => {
      await call("DELETE", `/nominees${id(nomineeId)}`);
    },
    admin: {
      requests: async (f = {}) =>
        (
          await call<AdminRequestsResponse>("GET", "/admin/requests", {
            query: { status: f.status, subjectId: f.subjectId, overdue: f.overdue ? "true" : undefined },
          })
        ).requests,
      request: (requestId) => call<RightsRequest>("GET", `/admin/requests${id(requestId)}`),
      data: (requestId) => call<AccessSummary>("GET", `/admin/requests${id(requestId)}/data`),
      verify: (requestId, method) => call<RightsRequest>("POST", `/admin/requests${id(requestId)}/verify`, { body: { method } }),
      resolve: (requestId, note) => call<RightsRequest>("POST", `/admin/requests${id(requestId)}/resolve`, { body: note === undefined ? {} : { note } }),
      reject: (requestId, reason) => call<RightsRequest>("POST", `/admin/requests${id(requestId)}/reject`, { body: { reason } }),
      correct: (requestId, changes, o = {}) =>
        call<CorrectResponse>("POST", `/admin/requests${id(requestId)}/correct`, {
          body: { changes, ...(o.where ? { where: o.where } : {}), ...(o.resolve === false ? { resolve: false } : {}) },
        }),
      erase: (requestId, o = {}) => call<{ scheduled: number }>("POST", `/admin/requests${id(requestId)}/erase`, { body: o.keepFor ? { keepFor: o.keepFor } : {} }),
    },
  };
}

export type {
  AccessSummary,
  ConsentsResponse,
  GrantResponse,
  LiftObjectionResponse,
  OpenRequestResponse,
  PersonRequest,
  PrivacyNotice,
  RightsInfo,
  WithdrawResponse,
} from "./http.js";
export type { PurposeStatus } from "./http.js";
export type { NoticeLanguage } from "./languages.js";
export type { NoticeKind } from "./notice.js";
export type { Nominee, RequestType, RightsRequest } from "./records.js";
