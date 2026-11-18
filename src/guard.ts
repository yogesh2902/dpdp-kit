import type { AccessAction } from "./access.js";
import type { Dpdp } from "./dpdp.js";
import { DpdpError } from "./errors.js";

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

type Maybe<T> = T | null | undefined;

export interface AccessLogOptions<Ctx, P extends string> {
  /** Why the route reads the data: one of your purposes. */
  purpose: P;
  /** Who is making the request: the signed-in staff user or service. Required. */
  actor: (ctx: Ctx) => Maybe<string> | Promise<Maybe<string>>;
  /** Whose data the route reads, e.g. the `:userId` route parameter. Nothing is logged if it returns nothing. */
  subject: (ctx: Ctx) => Maybe<string | readonly string[]> | Promise<Maybe<string | readonly string[]>>;
  /** What the route reads, as data map keys: `"users.phone"` or `"users"`. */
  fields?: readonly string[];
  /** Default `"read"`. */
  action?: AccessAction;
  /** Request details to keep with the entry, e.g. IP address and request id. */
  evidence?: (ctx: Ctx) => Maybe<Record<string, string>>;
}

/** Shared by the Express and Hono access-log middleware. */
export async function recordAccess<P extends string, Ctx>(dpdp: Dpdp<P>, options: AccessLogOptions<Ctx, P>, ctx: Ctx): Promise<void> {
  const subject = await options.subject(ctx);
  const subjectIds = typeof subject === "string" ? [subject] : subject ? [...subject] : [];
  if (subjectIds.length === 0) return;
  const actor = await options.actor(ctx);
  if (!actor) throw new DpdpError("invalid-actor", "logAccess: actor() returned nothing; every access to personal data needs a known actor");
  const evidence = options.evidence?.(ctx) ?? undefined;
  await dpdp.access.log({
    actor,
    subjectIds,
    purpose: options.purpose,
    ...(options.fields ? { fields: options.fields } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(evidence ? { evidence } : {}),
  });
}
