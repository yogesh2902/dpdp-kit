import { describe, expect, it } from "vitest";
import { type ConsentStore, createDpdp, DpdpError, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

function setup(store: ConsentStore = memoryStore()) {
  let t = Date.parse("2026-11-16T10:00:00.000Z");
  return createDpdp({ config, store, now: () => new Date((t += 1000)) });
}

describe("consent records", () => {
  it("grants, checks and withdraws", async () => {
    const dpdp = setup();
    expect(await dpdp.consent.has("u1", "marketing_sms")).toBe(false);

    const event = await dpdp.consent.grant("u1", ["marketing_sms", "analytics"], {
      noticeVersion: "2026-11",
      language: "hi",
      channel: "web",
      evidence: { ip: "203.0.113.7" },
    });
    expect(event).toMatchObject({ subjectId: "u1", seq: 1, action: "grant", prevHash: null, language: "hi" });
    expect(await dpdp.consent.has("u1", "marketing_sms")).toBe(true);
    expect((await dpdp.consent.active("u1")).sort()).toEqual(["analytics", "marketing_sms"]);

    const { event: withdrawal } = await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    expect(withdrawal).toMatchObject({ seq: 2, action: "withdraw", prevHash: event.hash });
    expect(await dpdp.consent.has("u1", "marketing_sms")).toBe(false);
    expect(await dpdp.consent.active("u1")).toEqual(["analytics"]);
    expect(await dpdp.consent.has("u2", "analytics")).toBe(false);
  });

  it("treats legitimate-use purposes as always allowed, and refuses consent calls for them", async () => {
    const dpdp = setup();
    expect(await dpdp.consent.has("u1", "account")).toBe(true);
    await expect(dpdp.consent.grant("u1", ["account"])).rejects.toMatchObject({ code: "not-a-consent-purpose" });
  });

  it("validates its inputs", async () => {
    const dpdp = setup();
    await expect(dpdp.consent.grant("", ["analytics"])).rejects.toBeInstanceOf(DpdpError);
    await expect(dpdp.consent.grant("u1", [])).rejects.toMatchObject({ code: "no-purposes" });
    // @ts-expect-error unknown purpose
    await expect(dpdp.consent.grant("u1", ["nope"])).rejects.toMatchObject({ code: "unknown-purpose" });
    // @ts-expect-error unknown language
    await expect(dpdp.consent.grant("u1", ["analytics"], { language: "xx" })).rejects.toMatchObject({
      code: "invalid-language",
    });
  });

  it("refuses to start with a broken config", () => {
    const broken = { ...config, minimumRetention: "30d" as const };
    expect(() => createDpdp({ config: broken, store: memoryStore() })).toThrow(/Rule 8\(3\)/);
  });

  it("keeps one unbroken chain when writes for the same person race", async () => {
    const dpdp = setup();
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => dpdp.consent.grant("u1", [i % 2 ? "analytics" : "marketing_sms"])),
    );
    const history = await dpdp.consent.history("u1");
    expect(history.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 4 });
  });

  it("detects an edited, removed or reordered event", async () => {
    const store = memoryStore();
    const dpdp = setup(store);
    await dpdp.consent.grant("u1", ["analytics"]);
    await dpdp.consent.withdraw("u1", ["analytics"]);
    await dpdp.consent.grant("u1", ["marketing_sms"]);
    expect(await dpdp.consent.verify("u1")).toEqual({ ok: true, events: 3 });

    const list = store.all.get("u1")!;
    const original = list[1]!;

    list[1] = { ...original, action: "grant" }; // someone flips a withdrawal into a grant
    expect(await dpdp.consent.verify("u1")).toMatchObject({ ok: false, brokenAt: 2, reason: "hash-mismatch" });

    list.splice(1, 1); // someone deletes the withdrawal
    expect(await dpdp.consent.verify("u1")).toMatchObject({ ok: false, brokenAt: 3, reason: "seq-gap" });
  });
});
