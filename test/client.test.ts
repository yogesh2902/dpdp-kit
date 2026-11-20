// dpdp-kit/client against the real HTTP API (the Next.js handlers, which use Web Request and
// Response), and a check that it bundles for the browser without anything from Node.js.
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { createClient, DpdpClientError } from "../src/client.js";
import { createDpdp, defineConfig, memoryData, memoryStore } from "../src/index.js";
import { createHandlers } from "../src/next.js";

const config = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "https://chai.example/grievance", dpo: "privacy@chai.example" },
  purposes: {
    account: { basis: "legitimate-use", legitimateUse: "7(i)", retain: "while-active" },
    receipts: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active", description: "SMS receipts" },
    offers: { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers by SMS" },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        name: { category: "identity", purposes: ["account"], label: "Name" },
        phone: { category: "contact", purposes: ["account", "receipts", "offers"], label: "Mobile number" },
      },
    },
  },
  notice: {
    links: { website: "https://chai.example/privacy", withdraw: "Settings → Privacy", rights: "https://chai.example/privacy" },
    translations: {
      hi: {
        purposes: { offers: "एसएमएस से ऑफ़र" },
        fields: { "users.phone": "मोबाइल नंबर" },
        wording: {
          title: "{fiduciary} की गोपनीयता सूचना",
          introConsent: "हम आपकी सहमति से यह डेटा उपयोग करना चाहते हैं:",
          introExisting: "आपने पहले सहमति दी थी, इसलिए हम यह डेटा उपयोग करते हैं:",
          data: "डेटा: {data}",
          withdraw: "सहमति वापस लेने के लिए: {withdraw}",
          rights: "अपने अधिकारों के लिए: {rights}",
          contact: "संपर्क: {contact}",
          complaint: "आप डेटा संरक्षण बोर्ड से शिकायत कर सकते हैं।",
          complaintWithLink: "आप डेटा संरक्षण बोर्ड से शिकायत कर सकते हैं: {complaint}",
          website: "वेबसाइट: {website}",
        },
      },
    },
  },
  rights: { how: "Settings → Privacy, or email privacy@chai.example" },
  minimumRetention: "1y",
  security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
});
type Purpose = keyof typeof config.purposes;

function setup() {
  const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData({ users: [{ id: "u1", name: "Asha", phone: "98xxxxxx01" }] }) });
  const handlers = createHandlers(dpdp, {
    base: "/api/privacy",
    subject: (req) => req.headers.get("authorization")?.replace(/^Bearer /, "") || undefined,
    admin: (req) => req.headers.get("x-staff") ?? undefined,
  });
  const sent: Request[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    sent.push(req.clone());
    return handlers[req.method as "GET" | "POST" | "DELETE"](req);
  }) as typeof globalThis.fetch;
  const as = (user?: string, staff?: string) =>
    createClient<Purpose>({
      base: "https://chai.example/api/privacy/",
      fetch,
      headers: async () => ({ ...(user ? { authorization: `Bearer ${user}` } : {}), ...(staff ? { "x-staff": staff } : {}) }),
    });
  return { dpdp, as, sent };
}

describe("dpdp-kit/client", () => {
  it("does what a consent screen and a privacy centre need, through the real API", async () => {
    const { as, dpdp } = setup();
    const asha = as("u1");

    expect(await asha.languages()).toEqual(["en", "hi"]);
    const notice = await asha.notice({ language: "hi" });
    expect(notice.items.map((i) => i.purpose)).toEqual(["offers"]);
    expect((await asha.rights()).how).toBe("Settings → Privacy, or email privacy@chai.example");

    const { event } = await asha.grant(["offers"], { language: "hi" });
    expect(event).toMatchObject({ action: "grant", noticeVersion: notice.version, language: "hi" });
    expect((await asha.object(["receipts"])).event.action).toBe("object");
    const consents = await asha.consents();
    expect(consents).toMatchObject({ consents: ["offers"], objections: ["receipts"] });
    expect(consents.purposes.find((p) => p.purpose === "receipts")?.active).toBe(false);
    expect((await asha.liftObjection(["receipts"])).event.action).toBe("lift-objection");
    expect((await asha.withdraw(["offers"])).event.action).toBe("withdraw");

    expect((await asha.data()).data[0]!.rows).toEqual([{ name: "Asha", phone: "98xxxxxx01" }]);

    const { request, acknowledgement } = await asha.openRequest("correction", { note: "New number" });
    expect(acknowledgement.reference).toBe(request.id);
    expect((await asha.requests()).map((r) => r.id)).toEqual([request.id]);
    expect((await asha.request(request.id)).status).toBe("open");

    const nominee = await asha.nominate({ name: "Ravi", contact: "ravi@example.in", relation: "brother" });
    expect((await asha.nominees()).map((n) => n.name)).toEqual(["Ravi"]);
    await asha.revokeNominee(nominee.id);
    expect(await asha.nominees()).toEqual([]);

    // The privacy team answers the request.
    const anita = as(undefined, "anita");
    expect((await anita.admin.requests({ status: "open" })).map((r) => r.id)).toEqual([request.id]);
    await anita.admin.verify(request.id, "OTP to registered mobile");
    const fixed = await anita.admin.correct(request.id, { "users.phone": "98xxxxxx02" });
    expect(fixed.changed).toEqual({ users: 1 });
    expect((await asha.request(request.id)).status).toBe("resolved");
    expect((await dpdp.rights.get(request.id))?.history.at(-1)).toMatchObject({ status: "resolved", by: "anita" });
  });

  it("throws the API's error code with the status", async () => {
    const { as } = setup();
    const err = await as().consents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DpdpClientError);
    expect(err).toMatchObject({ status: 401, code: "unauthenticated" });
    await expect(as("u1").grant(["account" as Purpose])).rejects.toMatchObject({ status: 400, code: "not-a-consent-purpose" });
    await expect(as("u1").request("nope")).rejects.toMatchObject({ status: 404, code: "request-not-found" });
    await expect(as("u1").admin.requests()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(as("u1").notice({ language: "ta" })).rejects.toMatchObject({ status: 404, code: "notice-language-unavailable" });
  });

  it("sends JSON only with a body, the purposes of a lifted objection in the query, and encoded ids", async () => {
    const { as, sent } = setup();
    const asha = as("u1");
    await asha.object(["receipts"]);
    await asha.liftObjection(["receipts"]);
    await asha.request("a/b").catch(() => {});
    const [post, del, get] = sent;
    expect(post!.headers.get("content-type")).toBe("application/json");
    expect(del!.method).toBe("DELETE");
    expect(new URL(del!.url).searchParams.get("purposes")).toBe("receipts");
    expect(del!.headers.get("content-type")).toBeNull();
    expect(new URL(get!.url).pathname).toBe("/api/privacy/requests/a%2Fb");
  });

  it("bundles for the browser with nothing from Node.js", async () => {
    const result = await build({
      entryPoints: [new URL("../src/client.ts", import.meta.url).pathname],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toEqual(["src/client.ts"]);
    expect(result.outputFiles[0]!.text).not.toMatch(/node:/);
  });

  it("dpdp-kit/react bundles for the browser with React as its only import", async () => {
    const result = await build({
      entryPoints: [new URL("../src/react/index.ts", import.meta.url).pathname],
      bundle: true,
      platform: "browser",
      format: "esm",
      external: ["react"],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).sort()).toEqual(["src/client.ts", "src/react/hooks.ts", "src/react/index.ts"]);
    expect(result.outputFiles[0]!.text).not.toMatch(/node:/);
  });
});
