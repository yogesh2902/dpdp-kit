import type { Dpdp } from "./dpdp.js";

export interface GuardOptions<Ctx> {
  /** Read the signed-in person's id from the request. Return nothing when nobody is signed in. */
  subject: (ctx: Ctx) => string | null | undefined | Promise<string | null | undefined>;
}

/** Body sent when consent is missing. Safe to show to end users. */
export const CONSENT_REQUIRED_BODY = (purpose: string) => ({
  error: "consent_required" as const,
  purpose,
  message: "You haven't agreed to this yet. You can turn it on in your privacy settings.",
});

/** Shared by the Express and Hono middleware. */
export async function checkConsent<P extends string, Ctx>(
  dpdp: Dpdp<P>,
  purpose: P,
  options: GuardOptions<Ctx>,
  ctx: Ctx,
): Promise<boolean> {
  const subjectId = await options.subject(ctx);
  if (!subjectId) return false;
  return dpdp.consent.has(subjectId, purpose);
}
