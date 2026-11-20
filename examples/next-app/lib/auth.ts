// Stand-ins for your own authentication: the browser pages sign in with a cookie, and the journey
// script (like a mobile app or another service) sends x-user-id and x-staff-id headers.
export function userId(req: Request): string | undefined {
  return req.headers.get("x-user-id") ?? cookie(req, "chai_user");
}
export function staffId(req: Request): string | undefined {
  return req.headers.get("x-staff-id") ?? undefined;
}
function cookie(req: Request, name: string): string | undefined {
  const match = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}
