// Stand-ins for your own authentication: the browser pages sign in with a cookie, the mobile app
// (examples/expo-app) sends a Bearer token, and the journey script sends x-user-id and x-staff-id.
// The demo's token is simply the user's id; check a real session or token here.
export function userId(req: Request): string | undefined {
  const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  return bearer || req.headers.get("x-user-id") || cookie(req, "chai_user");
}
export function staffId(req: Request): string | undefined {
  return req.headers.get("x-staff-id") ?? undefined;
}
function cookie(req: Request, name: string): string | undefined {
  const match = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}
