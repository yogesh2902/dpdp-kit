import { describe, expect, it, vi } from "vitest";
import { type ConsentStore, createDpdp, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

const HOUR = 60 * 60 * 1000;

function setup() {
  let t = Date.parse("2027-06-01T10:00:00.000Z");
  const store = memoryStore();
  const dpdp = createDpdp({ config, store, now: () => new Date(t) });
  return { dpdp, store, advance: (ms: number) => (t += ms) };
}

const base = { description: "A misconfigured storage bucket exposed order exports.", fields: ["users.phone", "orders"] };

describe("breach records (Section 8(6), Rule 7)", () => {
  it("opens a breach with the 72-hour clock running from when you became aware", async () => {
    const { dpdp } = setup();
    const opened = vi.fn();
    dpdp.on("breach.opened", opened);
    const breach = await dpdp.breach.open({ ...base, awareAt: "2027-06-01T08:00:00Z", occurredAt: "2027-05-30T22:00:00Z", location: "ap-south-1" });
    expect(breach).toMatchObject({
      awareAt: "2027-06-01T08:00:00.000Z",
      reportDueAt: "2027-06-04T08:00:00.000Z",
      fields: ["users.phone", "orders.address"],
      status: "open",
      location: "ap-south-1",
    });
    await new Promise((r) => setImmediate(r));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("rejects a breach without a description, with unknown fields or bad dates", async () => {
    const { dpdp } = setup();
    await expect(dpdp.breach.open({ description: " " })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(dpdp.breach.open({ ...base, fields: ["users.salary"] })).rejects.toMatchObject({ code: "unknown-field" });
    await expect(dpdp.breach.open({ ...base, awareAt: "yesterday" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("says what's left to do, and when the report is overdue", async () => {
    const { dpdp, advance } = setup();
    const { id } = await dpdp.breach.open(base);
    let status = await dpdp.breach.status(id);
    expect(status.boardNotified).toBe(false);
    expect(status.report).toMatchObject({ sent: false, overdue: false, hoursLeft: 72, missing: ["details", "facts", "mitigation", "findings", "remedial"] });
    expect(status.todo).toEqual([
      expect.stringContaining("Tell the Board without delay"),
      expect.stringContaining("Record who is affected"),
      expect.stringContaining("within 72 hours"),
    ]);

    await dpdp.breach.boardNotified(id);
    advance(73 * HOUR);
    status = await dpdp.breach.status(id);
    expect(status.boardNotified).toBe(true);
    expect(status.report.overdue).toBe(true);
    expect(status.todo).toContainEqual(expect.stringContaining("was due 1 hours ago"));

    await dpdp.breach.extend(id, { until: "2027-06-06T10:00:00Z", reference: "Board letter DPB/2027/118" });
    status = await dpdp.breach.status(id);
    expect(status.report).toMatchObject({ dueAt: "2027-06-06T10:00:00.000Z", overdue: false });

    const reported = vi.fn();
    dpdp.on("breach.reported", reported);
    await dpdp.breach.reportSent(id);
    expect((await dpdp.breach.status(id)).report).toMatchObject({ sent: true, overdue: false });
    await new Promise((r) => setImmediate(r));
    expect(reported).toHaveBeenCalledOnce();
  });

  it("records the people affected, including from the access log, and who has been told", async () => {
    const { dpdp, advance } = setup();
    for (const id of ["u1", "u2", "u3"]) await dpdp.access.log({ actor: "support:ravi", subjectId: id, purpose: "account" });
    await dpdp.access.log({ actor: "support:priya", subjectId: "u9", purpose: "account" });
    const breach = await dpdp.breach.open({ ...base, description: "support:ravi's account was taken over." });

    expect(await dpdp.breach.addAffectedFromAccessLog(breach.id, { actor: "support:ravi" })).toBe(3);
    expect(await dpdp.breach.addAffected(breach.id, ["u3", "u4", "u4"])).toBe(1); // u3 was already recorded
    expect((await dpdp.breach.pending(breach.id)).map((n) => n.subjectId)).toEqual(["u1", "u2", "u3", "u4"]);

    advance(HOUR);
    expect(await dpdp.breach.markNotified(breach.id, ["u1", "u2", "u2", "nobody"], { channel: "email" })).toBe(2);
    advance(HOUR);
    await dpdp.breach.markNotified(breach.id, ["u3"], { channel: "sms" });
    expect(await dpdp.breach.markNotified(breach.id, ["u1"])).toBe(0); // already told

    expect((await dpdp.breach.status(breach.id)).people).toEqual({ total: 4, sent: 3, pending: 1 });
    expect((await dpdp.breach.pending(breach.id)).map((n) => n.subjectId)).toEqual(["u4"]);

    const report = await dpdp.breach.boardReport(breach.id);
    expect(report.intimations).toEqual({ total: 4, sent: 3, pending: 1, firstSentAt: "2027-06-01T11:00:00.000Z", lastSentAt: "2027-06-01T12:00:00.000Z" });
  });

  it("drafts the notice for each person, Rule 7(1)(a)-(e), and says what's missing", async () => {
    const { dpdp } = setup();
    const { id } = await dpdp.breach.open({ ...base, occurredAt: "2027-05-30T22:00:00Z", extent: "About 1,200 customers' phone numbers and addresses." });
    let notice = await dpdp.breach.notice(id);
    expect(notice.missing).toEqual(["consequences", "measures", "safetySteps"]);
    expect(notice.contact).toContain("Meera Iyer");

    await dpdp.breach.update(id, {
      consequences: "You may receive unwanted calls or messages.",
      measures: "We closed the bucket and are reviewing all storage permissions.",
      safetySteps: "Be careful with calls asking for OTPs; we never ask for them.",
    });
    notice = await dpdp.breach.notice(id);
    expect(notice.missing).toEqual([]);
    expect(notice.text).toContain("What happened: A misconfigured storage bucket exposed order exports. About 1,200 customers' phone numbers and addresses. It happened on 2027-05-30.");
    expect(notice.text).toContain("What you can do: Be careful with calls asking for OTPs");

    const noContact = createDpdp({ config: { ...config, fiduciary: { name: "Acme" } }, store: memoryStore() });
    const other = await noContact.breach.open(base);
    expect((await noContact.breach.notice(other.id)).missing).toContain("contact");
  });

  it("builds the detailed report for the Board, Rule 7(2)(b)(i)-(vi)", async () => {
    const { dpdp } = setup();
    const { id } = await dpdp.breach.open(base);
    await dpdp.breach.updateReport(id, { details: "Bucket public for 41 hours.", facts: "A deploy script reset the policy." });
    await dpdp.breach.updateReport(id, { remedial: "Policy checks in CI." });
    const report = await dpdp.breach.boardReport(id);
    expect(report).toMatchObject({ details: "Bucket public for 41 hours.", facts: "A deploy script reset the policy.", remedial: "Policy checks in CI.", missing: ["mitigation", "findings"] });
  });

  it("closes a breach, after which it can't change, and daily() lists only open ones", async () => {
    const { dpdp } = setup();
    const open = await dpdp.breach.open(base);
    const done = await dpdp.breach.open({ ...base, description: "A lost laptop, encrypted." });
    await dpdp.breach.close(done.id, "No personal data was readable");
    await expect(dpdp.breach.addAffected(done.id, ["u1"])).rejects.toMatchObject({ code: "breach-closed" });
    await expect(dpdp.breach.status("nope")).rejects.toMatchObject({ code: "breach-not-found" });

    expect((await dpdp.breach.list({ status: "closed" })).map((b) => b.id)).toEqual([done.id]);
    const report = await dpdp.daily();
    expect(report.breaches!.map((b) => b.id)).toEqual([open.id]);
    expect(report.breaches![0]!.todo.length).toBeGreaterThan(0);
  });

  it("needs a store that keeps breaches", async () => {
    const { lastEvent, insert, events } = memoryStore();
    const store: ConsentStore = { lastEvent, insert, events };
    await expect(createDpdp({ config, store }).breach.open(base)).rejects.toMatchObject({ code: "store-unsupported" });
  });
});
