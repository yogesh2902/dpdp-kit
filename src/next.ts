// The dpdp-kit HTTP API for Next.js route handlers, or any server built on Web Request and
// Response (Bun, Deno, Cloudflare Workers). Nothing here imports Next.js.
import type { Dpdp } from "./dpdp.js";
import { type ApiOptions, handleWeb } from "./http.js";

export type { ApiOptions } from "./http.js";

/**
 * Route handlers for `app/api/privacy/[...path]/route.ts`:
 *
 * ```ts
 * import { createHandlers } from "dpdp-kit/next";
 * export const { GET, POST, DELETE } = createHandlers(dpdp, {
 *   base: "/api/privacy",
 *   subject: async () => (await auth())?.user?.id,
 * });
 * ```
 *
 * `subject` and `admin` get the Web `Request`. Pass `ip` to record the client address with
 * consent; behind a proxy, read it from the header your proxy sets.
 */
export function createHandlers<P extends string>(
  dpdp: Dpdp<P>,
  options: ApiOptions<Request> & { base: string; ip?: (req: Request) => string | undefined },
) {
  const handler = (req: Request) => handleWeb(dpdp, req, req, options);
  return { GET: handler, POST: handler, DELETE: handler };
}
