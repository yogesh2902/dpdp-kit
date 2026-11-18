import type { Dpdp } from "./dpdp.js";
import { type AccessLogOptions, CONSENT_REQUIRED_BODY, checkConsent, type GuardOptions, recordAccess } from "./guard.js";

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
        res.status(403).json(CONSENT_REQUIRED_BODY(purpose));
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
