// Chai & Co's API. The x-user-id and x-staff-id headers stand in for your own authentication.
import { DpdpError } from "dpdp-kit";
import { logAccess, requireConsent } from "dpdp-kit/express";
import express, { type NextFunction, type Request, type Response } from "express";
import { prisma } from "./db.js";
import { advanceClock, dpdp, processorCalls } from "./dpdp.js";

const app = express();
app.use(express.json());
const userId = (req: Request) => req.header("x-user-id");
const staffId = (req: Request) => req.header("x-staff-id");

// ---- Customers ----

app.post("/signup", async (req, res) => {
  const { name, phone, email, city, interests, consents = [], language = "en" } = req.body;
  const user = await prisma.user.create({ data: { name, phone, email, city, interests } });
  if (consents.length > 0) {
    // Section 6: record what they agreed to, against the notice they saw, in their language.
    await dpdp.consent.grant(user.id, consents, {
      noticeVersion: "2026-11",
      language,
      channel: "web",
      evidence: { ip: req.ip ?? "", userAgent: req.header("user-agent") ?? "" },
    });
  }
  res.status(201).json({ id: user.id });
});

app.post("/orders", async (req, res) => {
  const order = await prisma.order.create({ data: { userId: userId(req)!, address: req.body.address, total: req.body.total } });
  res.status(201).json({ id: order.id });
});

app.get("/me/consents", async (req, res) => {
  res.json({ active: await dpdp.consent.active(userId(req)!) });
});

app.post("/me/consents/withdraw", async (req, res) => {
  const { tasks } = await dpdp.consent.withdraw(userId(req)!, req.body.purposes);
  res.json({ scheduled: tasks.length });
});

// Only people who agreed to marketing get promotions; everyone else gets a plain 403.
app.post("/promo", requireConsent(dpdp, "marketing_sms", { subject: userId }), (_req, res) => {
  res.json({ sent: true });
});

// Section 11: what we hold about you, why, and who we share it with.
app.get("/me/data", async (req, res) => {
  res.json(await dpdp.rights.summary(userId(req)!));
});

app.post("/me/grievances", async (req, res) => {
  res.status(201).json(await dpdp.rights.open(userId(req)!, "grievance", { text: req.body.text }));
});

app.post("/me/delete", async (req, res) => {
  const { tasks } = await dpdp.erasure.deleteAccount(userId(req)!);
  res.json({ scheduled: tasks.length });
});

// ---- Support and the privacy team ----

// Rule 6(1)(c): every read of a customer's record is logged with who, why and what.
app.get(
  "/support/users/:id",
  logAccess(dpdp, { purpose: "account", fields: ["users.phone", "users.email", "orders"], actor: staffId, subject: (req) => req.params.id }),
  async (req, res) => {
    res.json(await prisma.user.findUnique({ where: { id: req.params.id as string } }));
  },
);

app.get("/admin/access", async (req, res) => {
  res.json({ entries: await dpdp.access.list({ actor: req.query.actor as string }) });
});

app.post("/admin/breaches", async (req, res) => {
  const { compromisedActor, ...input } = req.body;
  const breach = await dpdp.breach.open(input);
  // Everyone the compromised account read is affected.
  const affected = compromisedActor ? await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: compromisedActor }) : 0;
  res.status(201).json({ id: breach.id, affected });
});

app.get("/admin/breaches/:id", async (req, res) => {
  res.json({ status: await dpdp.breach.status(req.params.id), notice: await dpdp.breach.notice(req.params.id) });
});

app.patch("/admin/breaches/:id", async (req, res) => {
  res.json(await dpdp.breach.update(req.params.id, req.body));
});

app.post("/admin/breaches/:id/board-notified", async (req, res) => {
  res.json(await dpdp.breach.boardNotified(req.params.id));
});

app.post("/admin/breaches/:id/notified", async (req, res) => {
  res.json({ marked: await dpdp.breach.markNotified(req.params.id, req.body.subjectIds, { channel: req.body.channel }) });
});

app.get("/admin/consents/:id/verify", async (req, res) => {
  res.json(await dpdp.consent.verify(req.params.id));
});

// Once a day in production: startDaily(dpdp) from dpdp-kit/schedule, or your own cron.
app.post("/admin/daily", async (_req, res) => {
  res.json(await dpdp.daily());
});

// ---- For the journey script only ----

if (process.env.DEMO_CLOCK === "1") {
  app.post("/__dev/advance", (req, res) => {
    advanceClock(req.body.days * 24 * 60 * 60 * 1000);
    res.json({ ok: true });
  });
  app.get("/__dev/processor-calls", (_req, res) => {
    res.json({ calls: processorCalls });
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DpdpError) return void res.status(400).json({ error: err.code, message: err.message });
  console.error(err);
  res.status(500).json({ error: "internal" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Chai & Co on http://127.0.0.1:${port}`));
