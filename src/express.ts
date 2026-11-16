import type { Dpdp } from "./dpdp.js";
import { CONSENT_REQUIRED_BODY, checkConsent, type GuardOptions } from "./guard.js";

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
