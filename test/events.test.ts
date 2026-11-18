import { describe, expect, it, vi } from "vitest";
import { createDpdp, type DpdpEventName, memoryData, memoryStore } from "../src/index.js";
import { config } from "./fixtures/config.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(onListenerError?: (err: unknown, event: DpdpEventName) => void) {
  let t = Date.parse("2027-06-01T10:00:00.000Z");
  const data = memoryData({ users: [{ id: "u1", phone: "98xxxxxx01", name: "Asha", interests: "cricket" }] });
  const dpdp = createDpdp({ config, store: memoryStore(), data, now: () => new Date(t), ...(onListenerError ? { onListenerError } : {}) });
  return { dpdp, advance: (ms: number) => (t += ms) };
}

describe("events", () => {
  it("fires each event once, after the change is saved", async () => {
    const { dpdp, advance } = setup();
    const seen: string[] = [];
    const names: DpdpEventName[] = [
      "consent.granted",
      "consent.withdrawn",
      "erasure.scheduled",
      "retention.ran",
      "rights.opened",
      "rights.closed",
      "access.logged",
    ];
    for (const name of names) dpdp.on(name, () => void seen.push(name));

    await dpdp.consent.grant("u1", ["marketing_sms"]);
    await dpdp.consent.withdraw("u1", ["marketing_sms"]); // schedules erasure too
    const request = await dpdp.rights.open("u1", "grievance");
    await dpdp.rights.resolve(request.id, "done");
    await dpdp.access.log({ actor: "support", subjectId: "u1", purpose: "account" });
    advance(400 * 24 * 60 * 60 * 1000);
    await dpdp.retention.run();
    await settle();

    expect(seen).toEqual([
      "consent.granted",
      "erasure.scheduled",
      "consent.withdrawn",
      "rights.opened",
      "rights.closed",
      "access.logged",
      "retention.ran",
    ]);
  });

  it("passes what happened to the listener", async () => {
    const { dpdp } = setup();
    const withdrawn = vi.fn();
    dpdp.on("consent.withdrawn", withdrawn);
    const result = await dpdp.consent.withdraw("u1", ["analytics"]);
    await settle();
    expect(withdrawn).toHaveBeenCalledWith({ event: result.event, erasure: result.erasure, tasks: result.tasks });
  });

  it("runs listeners after the call returns, and never lets them break it", async () => {
    const errors: string[] = [];
    const { dpdp } = setup((_err, event) => errors.push(event));
    const order: string[] = [];
    dpdp.on("consent.granted", () => {
      order.push("listener");
      throw new Error("analytics down");
    });
    dpdp.on("consent.granted", async () => {
      throw new Error("webhook timed out");
    });

    await dpdp.consent.grant("u1", ["marketing_sms"]);
    order.push("returned");
    await settle();

    expect(order).toEqual(["returned", "listener"]);
    expect(errors).toEqual(["consent.granted", "consent.granted"]);
    expect(await dpdp.consent.has("u1", "marketing_sms")).toBe(true);
  });

  it("stops calling a listener once it's removed", async () => {
    const { dpdp } = setup();
    const listener = vi.fn();
    const off = dpdp.on("rights.opened", listener);
    await dpdp.rights.open("u1", "access");
    off();
    await dpdp.rights.open("u1", "access");
    await settle();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("reports listener errors to the console by default", async () => {
    const { dpdp } = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dpdp.on("access.logged", () => {
      throw new Error("boom");
    });
    await dpdp.access.log({ actor: "a", subjectId: "u1", purpose: "account" });
    await settle();
    expect(spy).toHaveBeenCalledWith('dpdp-kit: a "access.logged" listener failed', expect.any(Error));
    spy.mockRestore();
  });

  it("fires access.logged even when an out-of-purpose read is refused", async () => {
    const dpdp = createDpdp({ config, store: memoryStore(), access: { outOfPurpose: "throw" } });
    const logged = vi.fn();
    dpdp.on("access.logged", logged);
    await expect(dpdp.access.log({ actor: "growth", subjectId: "u1", purpose: "analytics", fields: ["users.phone"] })).rejects.toThrow();
    await settle();
    expect(logged).toHaveBeenCalledWith({ entries: [expect.objectContaining({ outOfPurpose: ["users.phone"] })] });
  });
});
