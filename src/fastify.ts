import type { Dpdp } from "./dpdp.js";
import { type AccessLogOptions, checkConsent, consentDeniedBody, type GuardOptions, recordAccess } from "./guard.js";

/** The parts of Fastify's reply these hooks use. */
interface ReplyLike {
  code(statusCode: number): { send(payload: unknown): unknown };
  /** Whether a reply has been sent (Fastify sets it). */
  readonly sent?: boolean;
}

export interface FastifyGuardOptions<Req, Reply> extends GuardOptions<Req> {
  /** Send your own reply when consent is missing. Default (and if it sends nothing): 403 with a JSON body. */
  onDenied?: (request: Req, reply: Reply, purpose: string) => unknown;
}

/**
 * Fastify `preHandler` hook that lets the request through only if the person may be processed for
 * `purpose`.
 *
 * ```ts
 * app.post("/promo", { preHandler: requireConsent(dpdp, "marketing_sms", { subject: (req) => req.user?.id }) }, handler);
 * ```
 */
export function requireConsent<P extends string, Req = any, Reply = any>(
  dpdp: Dpdp<P>,
  purpose: P,
  options: FastifyGuardOptions<Req, Reply>,
) {
  return async (request: Req, reply: ReplyLike): Promise<unknown> => {
    if (await checkConsent(dpdp, purpose, options, request)) return undefined;
    if (options.onDenied) await options.onDenied(request, reply as Reply, purpose);
    // Without a reply the request would hang, so fall back to the default 403.
    if (!reply.sent) reply.code(403).send(consentDeniedBody(dpdp, purpose));
    return reply;
  };
}

/**
 * Fastify `preHandler` hook that records each request in the access log (Rule 6(1)(c)) before the
 * handler runs. Errors (a failed write, or out-of-purpose fields with `access: { outOfPurpose:
 * "throw" }`) go to Fastify's error handler and the handler doesn't run.
 *
 * ```ts
 * app.get("/admin/users/:id", {
 *   preHandler: logAccess(dpdp, {
 *     purpose: "account",
 *     fields: ["users"],
 *     actor: (req) => req.staff?.id,
 *     subject: (req) => req.params.id,
 *   }),
 * }, handler);
 * ```
 */
export function logAccess<P extends string, Req = any>(dpdp: Dpdp<P>, options: AccessLogOptions<Req, P>) {
  return async (request: Req): Promise<void> => {
    await recordAccess(dpdp, options, request);
  };
}
