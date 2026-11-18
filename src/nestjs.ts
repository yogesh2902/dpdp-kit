import type { Dpdp } from "./dpdp.js";
import { DpdpError } from "./errors.js";
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

interface RequestOption<Req> {
  /**
   * Where to find the request. Default: `context.switchToHttp().getRequest()`, for HTTP routes. For
   * GraphQL, pass e.g. `(ctx) => GqlExecutionContext.create(ctx).getContext().req`.
   */
  request?: (context: ExecutionContextLike) => Req | undefined;
}

function requestOf<Req>(context: ExecutionContextLike, options: RequestOption<Req>, guard: string): Req {
  const request = options.request ? options.request(context) : context.switchToHttp().getRequest<Req>();
  if (request === undefined || request === null) {
    throw new DpdpError(
      "invalid-input",
      `${guard} found no request. It reads HTTP requests by default; for GraphQL or other contexts, pass request: (context) => ….`,
    );
  }
  return request;
}

export interface NestGuardOptions<Req> extends GuardOptions<Req>, RequestOption<Req> {
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
      const request = requestOf(context, options, "consentGuard");
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
export function accessLogGuard<P extends string, Req = any>(
  dpdp: Dpdp<P>,
  options: AccessLogOptions<Req, P> & RequestOption<Req>,
): CanActivateLike {
  return {
    async canActivate(context) {
      await recordAccess(dpdp, options, requestOf(context, options, "accessLogGuard"));
      return true;
    },
  };
}
