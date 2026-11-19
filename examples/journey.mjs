// A year in the life of a small Indian shop, over HTTP, against either example app.
//
//   node ../journey.mjs                 # the app must be running on BASE_URL (default :3000)
//
// It plays a customer, a support agent and the privacy team, and checks what the law asks for at
// each step. The app must run with DEMO_CLOCK=1 so the journey can move time forward a year.
import assert from "node:assert/strict";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const DAY = 24 * 60 * 60 * 1000;

async function call(method, path, { user, staff, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers["x-user-id"] = user;
  if (staff) headers["x-staff-id"] = staff;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const ok = async (method, path, options) => {
  const res = await call(method, path, options);
  assert.ok(res.status < 300, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const step = (n, text) => console.log(`\n${n}. ${text}`);
const startedAt = new Date().toISOString();
const check = (text) => console.log(`   ✔ ${text}`);

// 1. Two people read the notice and sign up. Asha agrees to promotional SMS; Ravi doesn't.
step(1, "Sign-up, with consent recorded against the notice they saw (Section 5, Rule 3)");
const notice = await ok("GET", "/privacy/notice");
assert.deepEqual(notice.items.map((i) => i.purpose), ["marketing_sms"]);
assert.deepEqual(notice.items[0].data.map((d) => d.label), ["Mobile number", "The teas you like"]);
assert.ok(notice.text.includes("withdraw your consent at any time"));
const signup = await ok("POST", "/signup", {
  body: { name: "Asha Kulkarni", phone: "9876500001", email: "asha@example.in", city: "Pune", interests: "masala chai, cardamom", consents: ["marketing_sms"] },
});
const asha = signup.id;
assert.equal(signup.noticeVersion, notice.version);
const ravi = (await ok("POST", "/signup", {
  body: { name: "Ravi Menon", phone: "9876500002", email: "ravi@example.in", city: "Kochi", interests: "green tea", consents: [] },
})).id;
await ok("POST", "/orders", { user: asha, body: { address: "12 FC Road, Pune 411004", total: 450 } });
await ok("POST", "/orders", { user: ravi, body: { address: "7 MG Road, Kochi 682016", total: 300 } });
assert.deepEqual((await ok("GET", "/privacy/consents", { user: asha })).consents, ["marketing_sms"]);
assert.deepEqual((await ok("GET", "/privacy/consents", { user: ravi })).consents, []);
check(`Asha consented to marketing_sms against notice ${notice.version}, kept as proof; Ravi to nothing`);

// 2. A promo campaign: only people who agreed get it.
step(2, "Promo SMS only to people who agreed (Section 6)");
assert.deepEqual(await ok("POST", "/promo", { user: asha }), { sent: true });
const denied = await call("POST", "/promo", { user: ravi });
assert.equal(denied.status, 403);
assert.equal(denied.body.error, "consent_required");
check(`Asha got it; Ravi was refused with 403 "${denied.body.message}"`);

// 3. Support looks up both customers. Each read goes in the access log (Rule 6).
step(3, "Support reads customer records, and each read is logged (Rule 6(1)(c))");
await ok("GET", `/support/users/${asha}`, { staff: "support:priya" });
await ok("GET", `/support/users/${ravi}`, { staff: "support:priya" });
const log = await ok("GET", `/admin/access?actor=support:priya`);
assert.equal(log.entries.length, 2);
check("2 reads by support:priya logged, with purpose and fields");

// 4. Asha asks what data the shop holds on her (Section 11).
step(4, "Asha asks for her data (Section 11)");
const summary = await ok("GET", "/privacy/data", { user: asha });
const users = summary.data.find((d) => d.key === "users");
assert.equal(users.rows[0].phone, "9876500001");
assert.equal(users.rows[0].interests, "masala chai, cardamom");
assert.equal(summary.data.find((d) => d.key === "orders").rows[0].address, "12 FC Road, Pune 411004");
assert.deepEqual(summary.consents, ["marketing_sms"]);
assert.deepEqual(summary.sharedWith.map((s) => s.name), ["msg91"]);
check("summary lists her profile, her order address, her consent, and that msg91 gets her data");

// 4b. Asha changed her number. The privacy team checks it's her, then corrects it (Section 12(2)).
step("4b", "Asha asks to correct her mobile number; identity checked first");
const correction = await ok("POST", "/privacy/requests", { user: asha, body: { type: "correction", details: { field: "phone" } } });
assert.ok(correction.acknowledgement.text.includes(correction.request.id));
await ok("POST", `/privacy/admin/requests/${correction.request.id}/verify`, { staff: "privacy:meera", body: { method: "OTP to the old number" } });
const corrected = await ok("POST", `/privacy/admin/requests/${correction.request.id}/correct`, {
  staff: "privacy:meera",
  body: { changes: { "users.phone": "9876500011" } },
});
assert.equal(corrected.request.status, "resolved");
assert.equal((await ok("GET", "/privacy/data", { user: asha })).data.find((d) => d.key === "users").rows[0].phone, "9876500011");
check("acknowledged with a reference, verified by privacy:meera, corrected and resolved");

// 4c. Asha names her brother as her nominee (Section 14).
step("4c", "Asha nominates someone to act for her (Section 14)");
await ok("POST", "/privacy/nominees", { user: asha, body: { name: "Rohan Kulkarni", contact: "rohan@example.in", relation: "brother" } });
assert.deepEqual((await ok("GET", "/privacy/nominees", { user: asha })).nominees.map((n) => n.name), ["Rohan Kulkarni"]);
check("nominee recorded");

// 5. Asha withdraws consent: promos stop now, the SMS vendor is told, her interests go later.
step(5, "Asha withdraws consent (Section 6(4)): stops now, erased after the retention period");
const withdrawn = await ok("POST", "/privacy/consents/withdraw", { user: asha, body: { purposes: ["marketing_sms"] } });
assert.ok(withdrawn.scheduled >= 2);
assert.equal((await call("POST", "/promo", { user: asha })).status, 403);
await ok("POST", "/admin/daily");
assert.deepEqual((await ok("GET", "/__dev/processor-calls")).calls, [`stop:msg91:${asha}:marketing_sms`]);
check("promo refused at once; msg91 told to stop by the daily run");

// 6. Ravi raises a grievance, and then deletes his account.
step(6, "Ravi objects to order SMS (Section 7(a)), raises a grievance (Section 13) and deletes his account");
await ok("POST", "/privacy/objections", { user: ravi, body: { purposes: ["order_sms"] } });
assert.deepEqual((await ok("GET", "/privacy/consents", { user: ravi })).objections, ["order_sms"]);
const grievance = (await ok("POST", "/privacy/requests", { user: ravi, body: { type: "grievance", details: { text: "Please stop calling me" } } })).request;
assert.equal(Math.round((Date.parse(grievance.dueAt) - Date.parse(grievance.openedAt)) / DAY), 90);
await ok("POST", "/me/delete", { user: ravi });
check("order SMS stopped; grievance due in 90 days (Rule 14(3)); deletion scheduled");

// 7. Ninety-one days later the grievance is overdue, and the daily run says so.
step(7, "Three months on: the overdue grievance shows up in the daily report");
await ok("POST", "/__dev/advance", { body: { days: 91 } });
let daily = await ok("POST", "/admin/daily");
assert.deepEqual(daily.overdueRequests.map((r) => r.id), [grievance.id]);
check("daily() lists it as overdue");

// 8. A support account is compromised. The privacy team records the breach.
step(8, "support:priya's account was compromised: breach recorded (Section 8(6), Rule 7)");
const breach = await ok("POST", "/admin/breaches", {
  body: {
    description: "A support agent's account was used from an unknown device.",
    extent: "Profiles the account opened in the last 30 days.",
    fields: ["users.phone", "users.email"],
    compromisedActor: "support:priya",
  },
});
assert.equal(breach.affected, 2);
let status = await ok("GET", `/admin/breaches/${breach.id}`);
assert.equal(status.status.report.hoursLeft, 72);
assert.ok(status.notice.missing.includes("consequences"));
assert.ok(status.notice.contact.includes("privacy@chai.example"));
await ok("PATCH", `/admin/breaches/${breach.id}`, {
  body: {
    consequences: "You may get calls pretending to be from us.",
    measures: "We locked the account and reset all support passwords.",
    safetySteps: "We never ask for OTPs. Don't share them.",
  },
});
await ok("POST", `/admin/breaches/${breach.id}/board-notified`);
status = await ok("GET", `/admin/breaches/${breach.id}`);
assert.deepEqual(status.notice.missing, []);
await ok("POST", `/admin/breaches/${breach.id}/notified`, { body: { subjectIds: [asha, ravi], channel: "sms" } });
status = await ok("GET", `/admin/breaches/${breach.id}`);
assert.deepEqual(status.status.people, { total: 2, sent: 2, pending: 0 });
check("both people a compromised account read are found from the access log, told, and the Board informed");
daily = await ok("POST", "/admin/daily");
assert.ok(daily.breaches[0].todo.some((t) => t.includes("detailed report")));
check(`daily() reminds: "${daily.breaches[0].todo[0]}"`);

// 9. A year later: the erasure that was scheduled now runs.
step(9, "A year later (Rule 8(3)): erasure runs, the GST-held invoice stays");
await ok("POST", "/__dev/advance", { body: { days: 366 } });
daily = await ok("POST", "/admin/daily");
assert.deepEqual(daily.retention.failed, [], JSON.stringify(daily.retention.failed));
const ashaNow = await ok("GET", "/privacy/data", { user: asha });
const ashaUser = ashaNow.data.find((d) => d.key === "users").rows[0];
assert.equal(ashaUser.interests ?? null, null, "Asha's interests are erased");
assert.equal(ashaUser.phone, "9876500011", "her corrected phone stays: the account still needs it");
const raviNow = await ok("GET", "/privacy/data", { user: ravi });
assert.equal(raviNow.data.find((d) => d.key === "users")?.rows.length ?? 0, 0, "Ravi's profile is gone");
assert.equal(raviNow.data.find((d) => d.key === "orders").rows[0].address, "7 MG Road, Kochi 682016", "his invoice is held for GST");
assert.ok((await ok("GET", "/__dev/processor-calls")).calls.includes(`erase:msg91:${asha}:marketing_sms`));
check("Asha's interests erased, phone kept; Ravi's profile deleted, invoice held 8 years; msg91 told to erase");

// 10. Consent records are kept and still prove themselves.
step(10, "Consent records survive erasure and still verify (Section 6(10))");
for (const id of [asha, ravi]) assert.equal((await ok("GET", `/admin/consents/${id}/verify`)).ok, true);
check("both hash chains verify");

// 11. The evidence report for the whole year, for an auditor or the Board.
step(11, "The evidence report for the year");
const evidence = await (await fetch(`${base}/admin/evidence?from=${encodeURIComponent(startedAt)}`)).text();
assert.ok(evidence.startsWith("# DPDP Act evidence: Chai & Co"));
for (const part of ["## Notices shown", "## Consent (Section 6)", "## Rights requests", "## Erasure", "## Breaches", "## What needs attention"]) {
  assert.ok(evidence.includes(part), `the report has "${part}"`);
}
assert.match(evidence, /consent event\(s\) from 2 person\(s\)/);
check(`${evidence.split("\n").length} lines of Markdown, from the notice to the breach`);

console.log("\nThe whole journey passed.");
