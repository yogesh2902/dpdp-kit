// The privacy centre's API: the notice, consents, objections, the person's data, rights requests
// and nominees, and /privacy/admin for the privacy team. See dpdp-kit.js.org/docs/http/.
import { createHandlers } from "dpdp-kit/next";
import { staffId, userId } from "../../../lib/auth";
import { dpdp } from "../../../lib/dpdp";

export const { GET, POST, DELETE } = createHandlers(dpdp, {
  base: "/privacy",
  subject: userId,
  admin: staffId,
  // Behind a proxy, take the address it reports.
  ip: (req) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
});
