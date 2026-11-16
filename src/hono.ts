import type { Dpdp } from "./dpdp.js";
import { CONSENT_REQUIRED_BODY, checkConsent, type GuardOptions } from "./guard.js";

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
    return c.json(CONSENT_REQUIRED_BODY(purpose), 403);
  };
}
