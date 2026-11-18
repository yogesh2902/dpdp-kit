import type { Dpdp } from "./dpdp.js";
import { type AccessLogOptions, checkConsent, type GuardOptions, recordAccess } from "./guard.js";

/**
 * The part of NestJS's `ExecutionContext` these guards use, so dpdp-kit doesn't depend on
 * `@nestjs/common`. For HTTP routes, `switchToHttp().getRequest()` is the Express or Fastify request.
 */
export interface ExecutionContextLike {
  switchToHttp(): { getRequest<T = any>(): T };
}

/** What NestJS calls on a guard. `@UseGuards()` accepts any object with this method. */
export interface CanActivateLike {
  canActivate(context: ExecutionContextLike): Promise<boolean>;
}

export interface NestGuardOptions<Req> extends GuardOptions<Req> {
  /**
   * Throw your own exception when consent is missing, for example
   * `(purpose) => new ForbiddenException(CONSENT_REQUIRED_BODY(purpose))`. Default: the guard
   * returns `false`, and NestJS answers 403 Forbidden.
   */
  onDenied?: (purpose: string, request: Req) => Error;
}

/**
 * A NestJS guard that lets the request through only if the person may be processed for `purpose`.
 *
 * ```ts
 * import { ForbiddenException, UseGuards } from "@nestjs/common";
 * import { CONSENT_REQUIRED_BODY } from "dpdp-kit";
 *
 * @UseGuards(consentGuard(dpdp, "marketing_sms", {
 *   subject: (req) => req.user?.id,
 *   onDenied: (purpose) => new ForbiddenException(CONSENT_REQUIRED_BODY(purpose)),
 * }))
 * @Post("promo")
 * sendPromo() { … }
 * ```
 */
export function consentGuard<P extends string, Req = any>(dpdp: Dpdp<P>, purpose: P, options: NestGuardOptions<Req>): CanActivateLike {
  return {
    async canActivate(context) {
      const request = context.switchToHttp().getRequest<Req>();
      if (await checkConsent(dpdp, purpose, options, request)) return true;
      if (options.onDenied) throw options.onDenied(purpose, request);
      return false;
    },
  };
}

/**
 * A NestJS guard that records each request in the access log (Rule 6(1)(c)) and lets it through.
 * If logging fails, or the fields aren't held for the purpose and the instance was created with
 * `access: { outOfPurpose: "throw" }`, the error reaches NestJS's exception filters and the
 * handler doesn't run.
 *
 * ```ts
 * @UseGuards(accessLogGuard(dpdp, {
 *   purpose: "account",
 *   fields: ["users"],
 *   actor: (req) => req.user?.staffId,
 *   subject: (req) => req.params.id,
 * }))
 * @Get("admin/users/:id")
 * getUser() { … }
 * ```
 */
export function accessLogGuard<P extends string, Req = any>(dpdp: Dpdp<P>, options: AccessLogOptions<Req, P>): CanActivateLike {
  return {
    async canActivate(context) {
      await recordAccess(dpdp, options, context.switchToHttp().getRequest<Req>());
      return true;
    },
  };
}
