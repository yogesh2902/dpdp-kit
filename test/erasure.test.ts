import { describe, expect, it } from "vitest";
import { createDpdp, memoryStore, planErasure } from "../src/index.js";
import { config } from "./fixtures/config.js";

describe("erasure plan", () => {
  it("on withdrawal, erases only fields with no purpose left", async () => {
    const dpdp = createDpdp({ config, store: memoryStore() });
    await dpdp.consent.grant("u1", ["order_updates", "marketing_sms", "analytics"]);

    const { erasure } = await dpdp.consent.withdraw("u1", ["marketing_sms"]);
    expect(erasure.reason).toBe("withdrawal");
    expect(erasure.tables).toEqual([
      {
        key: "users",
        table: "users",
        subject: "id",
        action: "keep",
        fields: [
          { field: "phone", action: "keep", keptFor: ["account", "order_updates"] },
          { field: "interests", action: "keep", keptFor: ["analytics"] },
        ],
      },
    ]);
    expect(erasure.processors).toEqual([{ name: "msg91", action: "restrict", ended: ["marketing_sms"] }]);

    const second = await dpdp.consent.withdraw("u1", ["analytics"]);
    expect(second.erasure.tables).toEqual([
      {
        key: "users",
        table: "users",
        subject: "id",
        action: "erase-fields",
        fields: [{ field: "interests", action: "erase", after: "30d" }],
      },
      {
        key: "events",
        table: "analytics_events",
        subject: "user_id",
        action: "erase-fields",
        fields: [{ field: "device", action: "erase", after: "30d" }],
      },
    ]);
    expect(second.erasure.processors).toEqual([{ name: "posthog", action: "erase", ended: ["analytics"] }]);
  });

  it("on account deletion, deletes rows but respects legal holds", async () => {
    const dpdp = createDpdp({ config, store: memoryStore() });
    const plan = await dpdp.erasure.plan("u1", { reason: "account-deletion" });

    expect(plan.tables.map((t) => [t.key, t.action])).toEqual([
      ["users", "delete-rows"],
      ["orders", "hold"],
      ["events", "delete-rows"],
    ]);
    expect(plan.tables[1]).toMatchObject({
      fields: [{ field: "address", action: "hold" }],
      hold: { reason: "GST records", keep: "8y", then: "anonymise" },
    });
    expect(plan.processors.map((p) => [p.name, p.action])).toEqual([
      ["msg91", "erase"],
      ["posthog", "erase"],
    ]);
  });

  it("is a pure function of the config", () => {
    const plan = planErasure(config, {
      subjectId: "u9",
      reason: "withdrawal",
      ended: ["order_updates"],
      remaining: ["account"],
    });
    expect(plan.tables).toEqual([
      {
        key: "users",
        table: "users",
        subject: "id",
        action: "keep",
        fields: [{ field: "phone", action: "keep", keptFor: ["account"] }],
      },
    ]);
    expect(plan.processors).toEqual([{ name: "msg91", action: "erase", ended: ["order_updates"] }]);
  });
});
