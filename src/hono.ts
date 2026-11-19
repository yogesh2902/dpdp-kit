import type { Dpdp } from "./dpdp.js";
import { type AccessLogOptions, checkConsent, consentDeniedBody, type GuardOptions, recordAccess } from "./guard.js";

/** The parts of Hono's context this middleware uses. */
interface ContextLike {
  json(body: unknown, status?: number): Response;
}

export interface HonoGuardOptions<C> extends GuardOptions<C> {
  /** Return your own response when consent is missing. Default: 403 with a JSON body. */
  onDenied?: (c: C, purpose: string) => Response | Promise<Response>;
}

/**
 * Hono middleware that lets the request through only if the person may be processed for
 * `purpose`.
 *
 * ```ts
 * app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: (c) => c.get("userId") }), handler);
 * ```
 */
export function requireConsent<P extends string, C extends ContextLike = any>(
  dpdp: Dpdp<P>,
  purpose: P,
  options: HonoGuardOptions<C>,
) {
  return async (c: C, next: () => Promise<void>): Promise<Response | void> => {
    if (await checkConsent(dpdp, purpose, options, c)) return next();
    if (options.onDenied) return options.onDenied(c, purpose);
    return c.json(consentDeniedBody(dpdp, purpose), 403);
  };
}

/**
 * Hono middleware that records each request in the access log (Rule 6(1)(c)) before the handler
 * runs. Errors (a failed write, or out-of-purpose fields with `access: { outOfPurpose: "throw" }`)
 * are thrown to Hono's error handler and the handler doesn't run.
 *
 * ```ts
 * app.get("/admin/users/:id", logAccess(dpdp, {
 *   purpose: "account",
 *   fields: ["users"],
 *   actor: (c) => c.get("staffId"),
 *   subject: (c) => c.req.param("id"),
 * }), handler);
 * ```
 */
export function logAccess<P extends string, C = any>(dpdp: Dpdp<P>, options: AccessLogOptions<C, P>) {
  return async (c: C, next: () => Promise<void>): Promise<void> => {
    await recordAccess(dpdp, options, c);
    await next();
  };
}
