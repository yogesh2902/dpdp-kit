// The shop's own API, the same as the Express examples: sign-up, orders, a promo that needs
// consent, account deletion, support reads that are logged, and the privacy team's tools.
import { randomUUID } from "node:crypto";
import { CONSENT_REQUIRED_BODY, DpdpError, formatEvidence } from "dpdp-kit";
import { staffId, userId } from "../../lib/auth";
import { db } from "../../lib/db";
import { dpdp, offset, processorCalls } from "../../lib/dpdp";

type Params = { params: Promise<{ path: string[] }> };
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function route(req: Request, parts: string[]): Promise<Response> {
  const method = req.method;
  const is = (m: string, ...pattern: string[]) => m === method && pattern.length === parts.length && pattern.every((p, i) => p.startsWith(":") || p === parts[i]);
  const body = method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>);

  // ---- Customers ----
  if (is("POST", "signup")) {
    const { name, phone, email, city, interests, consents = [] } = body;
    const id = randomUUID();
    db().prepare("INSERT INTO users (id, name, phone, email, city, interests) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, phone, email, city || null, interests || null); // an empty field holds nothing
    // Section 6: record what they agreed to, against the notice they saw (kept as proof).
    const event = consents.length > 0 ? await dpdp.consent.grant(id, consents, { channel: "web", evidence: { userAgent: req.headers.get("user-agent") ?? "" } }) : undefined;
    const res = json({ id, noticeVersion: event?.noticeVersion }, 201);
    res.headers.append("set-cookie", `chai_user=${id}; Path=/; HttpOnly; SameSite=Lax`); // the demo's sign-in
    return res;
  }
  if (is("POST", "orders")) {
    const result = db().prepare("INSERT INTO orders (user_id, address, total) VALUES (?, ?, ?) RETURNING id").get(userId(req)!, body.address, body.total);
    return json(result, 201);
  }
  // Only people who agreed to marketing get promotions; everyone else gets a plain 403.
  if (is("POST", "promo")) {
    const who = userId(req);
    if (!who || !(await dpdp.consent.has(who, "marketing_sms"))) return json(CONSENT_REQUIRED_BODY("marketing_sms"), 403);
    return json({ sent: true });
  }
  if (is("POST", "me", "delete")) return json({ scheduled: (await dpdp.erasure.deleteAccount(userId(req)!)).tasks.length });

  // ---- Support and the privacy team ----
  // Rule 6(1)(c): every read of a customer's record is logged with who, why and what.
  if (is("GET", "support", "users", ":id")) {
    await dpdp.access.log({ actor: staffId(req)!, subjectId: parts[2]!, purpose: "account", fields: ["users.phone", "users.email", "orders"] });
    return json(db().prepare("SELECT * FROM users WHERE id = ?").get(parts[2]!) ?? null);
  }
  if (is("GET", "admin", "access")) return json({ entries: await dpdp.access.list({ actor: new URL(req.url).searchParams.get("actor") ?? undefined }) });
  if (is("POST", "admin", "breaches")) {
    const { compromisedActor, ...input } = body;
    const breach = await dpdp.breach.open(input as never);
    // Everyone the compromised account read is affected.
    const affected = compromisedActor ? await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: compromisedActor }) : 0;
    return json({ id: breach.id, affected }, 201);
  }
  if (is("GET", "admin", "breaches", ":id")) return json({ status: await dpdp.breach.status(parts[2]!), notice: await dpdp.breach.notice(parts[2]!) });
  if (is("PATCH", "admin", "breaches", ":id")) return json(await dpdp.breach.update(parts[2]!, body as never));
  if (is("POST", "admin", "breaches", ":id", "board-notified")) return json(await dpdp.breach.boardNotified(parts[2]!));
  if (is("POST", "admin", "breaches", ":id", "notified")) return json({ marked: await dpdp.breach.markNotified(parts[2]!, body.subjectIds, { channel: body.channel }) });
  if (is("GET", "admin", "consents", ":id", "verify")) return json(await dpdp.consent.verify(parts[2]!));
  // The evidence report, as Markdown: what the config declares and what the records show.
  if (is("GET", "admin", "evidence")) {
    const from = new URL(req.url).searchParams.get("from");
    return new Response(formatEvidence(await dpdp.evidence(from ? { from } : {})), { headers: { "content-type": "text/markdown" } });
  }
  // Once a day in production: startDaily(dpdp) from dpdp-kit/schedule, or a cron calling this.
  if (is("POST", "admin", "daily")) return json(await dpdp.daily());

  // ---- For the journey script only ----
  if (process.env.DEMO_CLOCK === "1") {
    if (is("POST", "__dev", "advance")) {
      offset.ms += Number(body.days) * 24 * 60 * 60 * 1000;
      return json({ ok: true });
    }
    if (is("GET", "__dev", "processor-calls")) return json({ calls: processorCalls });
  }
  return json({ error: "not-found" }, 404);
}

async function handler(req: Request, { params }: Params) {
  try {
    return await route(req, (await params).path);
  } catch (err) {
    if (err instanceof DpdpError) return json({ error: err.code, message: err.message }, 400);
    console.error(err);
    return json({ error: "internal" }, 500);
  }
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST };
