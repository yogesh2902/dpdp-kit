// Section 5 and Rule 3: the notice is built from the config, versioned by its content, recorded
// with each consent, and saved as proof of what the person was shown (Section 6(10)).
import { PGlite } from "@electric-sql/pglite";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DPDP_DDL } from "../src/drizzle.js";
import {
  audit,
  buildNotice,
  createDpdp,
  defineConfig,
  type DpdpConfig,
  ENGLISH_WORDING,
  memoryStore,
  type NoticeStore,
  type NoticeWording,
} from "../src/index.js";
import { mongoStore } from "../src/mongodb.js";
import { backends } from "./pg-backends.js";

const HINDI_WORDING: NoticeWording = {
  title: "गोपनीयता सूचना: {fiduciary}",
  introConsent: "{fiduciary} नीचे दिए गए उद्देश्यों के लिए आपके व्यक्तिगत डेटा के उपयोग की सहमति माँगता है।",
  introExisting: "आपने अधिनियम लागू होने से पहले {fiduciary} को सहमति दी थी।",
  data: "उपयोग किया गया डेटा:",
  withdraw: "आप कभी भी उतनी ही आसानी से सहमति वापस ले सकते हैं: {withdraw}",
  rights: "अपने अधिकारों का उपयोग करें: {rights}",
  contact: "प्रश्न: {contact}",
  complaint: "आप डेटा संरक्षण बोर्ड से शिकायत कर सकते हैं।",
  complaintWithLink: "आप डेटा संरक्षण बोर्ड से शिकायत कर सकते हैं: {complaint}",
  website: "अधिक जानकारी: {website}",
};

const notice = {
  links: { website: "https://chai.example/privacy", withdraw: "Settings → Privacy in the app", rights: "https://chai.example/privacy/requests" },
  translations: {
    hi: {
      purposes: { offers: "SMS से ऑफ़र और छूट", analytics: "ऐप को बेहतर बनाने के लिए उसके उपयोग को समझना" },
      fields: { "users.phoneNumber": "मोबाइल नंबर", "users.city": "शहर", "orders.phone": "मोबाइल नंबर", "events.screen_name": "आप कौन-सी स्क्रीन खोलते हैं" },
      wording: HINDI_WORDING,
    },
  },
};

const config = defineConfig({
  fiduciary: { name: "Chai & Co", grievanceUrl: "https://chai.example/grievance", dpo: "Meera Iyer, privacy@chai.example" },
  purposes: {
    account: { basis: "legitimate-use", legitimateUse: "7(b)", retain: "while-active" },
    offers: { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers and discounts by SMS" },
    analytics: { basis: "consent", retain: { afterWithdrawal: "7d" }, description: "Understanding how the app is used, to improve it" },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        name: { category: "identity", purposes: ["account"] },
        phoneNumber: { category: "contact", purposes: ["account", "offers"], label: "Mobile number" },
        city: { category: "location", purposes: ["offers", "analytics"] },
      },
    },
    orders: { table: "orders", subject: "user_id", fields: { phone: { category: "contact", purposes: ["offers"], label: "Mobile number" } } },
    events: { table: "app_events", subject: "user_id", fields: { screen_name: { category: "behavioural", purposes: ["analytics"], label: "Screens you open" } } },
  },
  notice,
  minimumRetention: "1y",
  rights: { how: "In the app: Settings → Privacy, or email privacy@example.in" },
  security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
});

function setup(c: DpdpConfig<string> = config, store: ReturnType<typeof memoryStore> = memoryStore()) {
  let t = Date.parse("2026-12-01T10:00:00.000Z");
  return { dpdp: createDpdp({ config: c, store, now: () => new Date((t += 1000)) }), store };
}

describe("building the notice", () => {
  it("itemises the data for each consent purpose, with every link Rule 3(c) asks for", () => {
    const notice = buildNotice(config);
    expect(notice.items).toEqual([
      {
        purpose: "offers",
        description: "Offers and discounts by SMS",
        data: [
          { label: "Mobile number", category: "contact", fields: ["users.phoneNumber", "orders.phone"] }, // one item, two columns
          { label: "City", category: "location", fields: ["users.city"] }, // label from the field name
        ],
      },
      {
        purpose: "analytics",
        description: "Understanding how the app is used, to improve it",
        data: [
          { label: "City", category: "location", fields: ["users.city"] },
          { label: "Screens you open", category: "behavioural", fields: ["events.screen_name"] },
        ],
      },
    ]);
    expect(notice.text).toBe(
      [
        "Privacy notice: Chai & Co",
        "",
        "Chai & Co asks for your consent to use the personal data below, for the purposes described.",
        "",
        "• Offers and discounts by SMS",
        "  Data used: Mobile number, City",
        "• Understanding how the app is used, to improve it",
        "  Data used: City, Screens you open",
        "",
        "You can withdraw your consent at any time, as easily as you gave it: Settings → Privacy in the app",
        "To access, correct or erase your data, nominate someone to act for you, or raise a grievance: https://chai.example/privacy/requests",
        "Questions about your data: Meera Iyer, privacy@chai.example",
        "If you're not satisfied with how we handle your grievance, you can complain to the Data Protection Board of India.",
        "More about how we use your data: https://chai.example/privacy",
      ].join("\n"),
    );
    expect(notice.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes the version exactly when that language's content changes", () => {
    const en = buildNotice(config).version;
    const hi = buildNotice(config, { language: "hi" }).version;
    expect(buildNotice(config).version).toBe(en);
    expect(hi).not.toBe(en);
    expect(buildNotice(config, { kind: "existing-users" }).version).not.toBe(en);

    const reworded = { ...config, purposes: { ...config.purposes, offers: { ...config.purposes.offers, description: "Offers by SMS" } } };
    expect(buildNotice(reworded).version).not.toBe(en);
    // Editing the Hindi text, or adding a language, leaves the English version alone.
    const tamil = { ...config, notice: { ...notice, translations: { ...notice.translations, ta: notice.translations.hi } } };
    expect(buildNotice(tamil).version).toBe(en);
    expect(buildNotice(tamil, { language: "hi" }).version).toBe(hi);
    // Non-consent purposes and fields aren't in the notice, so they don't change it.
    const moreAccount = { ...config, purposes: { ...config.purposes, account: { ...config.purposes.account, description: "Your account" } } };
    expect(buildNotice(moreAccount).version).toBe(en);
  });

  it("builds the Hindi notice from the company's own text", () => {
    const notice = buildNotice(config, { language: "hi" });
    expect(notice.text.split("\n").slice(0, 6)).toEqual([
      "गोपनीयता सूचना: Chai & Co",
      "",
      "Chai & Co नीचे दिए गए उद्देश्यों के लिए आपके व्यक्तिगत डेटा के उपयोग की सहमति माँगता है।",
      "",
      "• SMS से ऑफ़र और छूट",
      "  उपयोग किया गया डेटा: मोबाइल नंबर, शहर",
    ]);
    expect(() => buildNotice(config, { language: "ta" })).toThrow(expect.objectContaining({ code: "notice-language-unavailable" }));
  });

  it("speaks to existing users differently (Section 5(2))", () => {
    expect(buildNotice(config, { kind: "existing-users" }).text).toContain(
      "You gave Chai & Co consent to use your personal data before the Digital Personal Data Protection Act, 2023 came into force.",
    );
  });

  it("uses the complaint link when there is one", () => {
    const c = { ...config, notice: { ...notice, links: { ...notice.links, complaint: "https://chai.example/privacy/board" } } };
    expect(buildNotice(c).text).toContain("complain to the Data Protection Board of India: https://chai.example/privacy/board");
  });
});

describe("recording the notice with consent", () => {
  it("records the version and language on each grant, and saves the notice once", async () => {
    const { dpdp, store } = setup();
    const first = await dpdp.consent.grant("u1", ["offers"]);
    const second = await dpdp.consent.grant("u2", ["analytics"], { language: "hi" });
    await dpdp.consent.grant("u3", ["offers", "analytics"]);
    expect(first).toMatchObject({ noticeVersion: dpdp.notice.build().version, language: "en" });
    expect(second).toMatchObject({ noticeVersion: dpdp.notice.build({ language: "hi" }).version, language: "hi" });

    const saved = await dpdp.notice.list();
    expect(saved.map((s) => [s.notice.language, s.firstShownAt])).toEqual([
      ["en", "2026-12-01T10:00:01.000Z"],
      ["hi", "2026-12-01T10:00:03.000Z"],
    ]);
    expect(store.privacyNotices.size).toBe(2);
    const proof = await dpdp.notice.get(first.noticeVersion!);
    expect(proof?.notice.text).toBe(dpdp.notice.build().text);
  });

  it("leaves an explicit noticeVersion alone", async () => {
    const { dpdp } = setup();
    const event = await dpdp.consent.grant("u1", ["offers"], { noticeVersion: "paper-form-3" });
    expect(event.noticeVersion).toBe("paper-form-3");
    expect(event.language).toBeUndefined();
    expect(await dpdp.notice.list()).toEqual([]);
  });

  it("changes nothing for configs without notice", async () => {
    const { notice: _, ...without } = config;
    const { dpdp, store } = setup(without as DpdpConfig<string>);
    const event = await dpdp.consent.grant("u1", ["offers"]);
    expect(event.noticeVersion).toBeUndefined();
    expect(store.privacyNotices.size).toBe(0);
    expect(() => dpdp.notice.build()).toThrow(expect.objectContaining({ code: "notice-not-configured" }));
  });

  it("refuses consent in a language there's no notice in, and records nothing", async () => {
    const { dpdp } = setup();
    await expect(dpdp.consent.grant("u1", ["offers"], { language: "ta" })).rejects.toMatchObject({ code: "notice-language-unavailable" });
    await expect(dpdp.consent.grant("u1", ["account" as "offers"])).rejects.toMatchObject({ code: "not-a-consent-purpose" });
    expect(await dpdp.consent.history("u1")).toEqual([]);
    expect(await dpdp.notice.list()).toEqual([]);
  });

  it("saves a notice when it's shown, before anyone consents", async () => {
    const { dpdp } = setup();
    const shown = await dpdp.notice.show({ kind: "existing-users" });
    expect((await dpdp.notice.get(shown.version, { kind: "existing-users" }))?.notice).toEqual(shown);
    expect(dpdp.notice.languages()).toEqual(["en", "hi"]);
  });

  it("refuses to reuse your own version label for a different notice", async () => {
    const store = memoryStore();
    const labelled = { ...config, notice: { ...notice, version: "2026-11" } };
    await setup(labelled, store).dpdp.consent.grant("u1", ["offers"]);
    const edited = { ...labelled, purposes: { ...labelled.purposes, offers: { ...labelled.purposes.offers, description: "Offers by SMS" } } };
    const { dpdp } = setup(edited, store); // e.g. the next deploy, with the text changed but not the label
    await expect(dpdp.consent.grant("u2", ["offers"])).rejects.toMatchObject({ code: "notice-version-conflict" });
    expect(await dpdp.consent.history("u2")).toEqual([]);
    // The same text under the same label is fine, from any number of processes.
    await setup(labelled, store).dpdp.consent.grant("u3", ["offers"]);
  });
});

describe("auditing the notice", () => {
  const codes = (c: DpdpConfig<string>) => audit(c).map((i) => `${i.level}:${i.code}:${i.path}`);

  it("passes a complete notice, and warns about fields without a label", () => {
    expect(codes(config)).toEqual(["warning:notice-label-missing:data.users.fields.city.label"]);
  });

  it("checks nothing about notices when there's no notice config", () => {
    const { notice: _, ...without } = config;
    const c = { ...without, purposes: { ...config.purposes, offers: { basis: "consent", retain: { afterWithdrawal: "0d" } } } };
    expect(codes(c as DpdpConfig<string>)).toEqual([]);
  });

  it("requires the links, the descriptions and complete translations", () => {
    const { wording: _w, ...partial } = notice.translations.hi;
    const bad = {
      ...config,
      purposes: { ...config.purposes, offers: { basis: "consent", retain: { afterWithdrawal: "0d" } } },
      notice: {
        links: { website: "https://chai.example/privacy", withdraw: " " },
        translations: {
          hi: { ...partial, purposes: { analytics: "…" }, wording: { ...HINDI_WORDING, withdraw: "सहमति वापस लें", website: "" } },
          xx: partial,
        },
      },
    } as unknown as DpdpConfig<string>;
    expect(codes(bad).filter((c) => !c.includes("label-missing"))).toEqual([
      "error:notice-link-missing:notice.links.withdraw",
      "error:notice-link-missing:notice.links.rights",
      "error:notice-description-missing:purposes.offers.description",
      "error:notice-translation-incomplete:notice.translations.hi.purposes.offers",
      "error:notice-translation-incomplete:notice.translations.hi.wording.withdraw",
      "error:notice-translation-incomplete:notice.translations.hi.wording.website",
      "error:invalid-notice-language:notice.translations.xx",
    ]);
    expect(audit(bad).find((i) => i.path === "notice.translations.hi.wording.withdraw")?.message).toContain("{withdraw}");
  });

  it("keeps the English wording's placeholders", () => {
    expect(ENGLISH_WORDING.withdraw).toContain("{withdraw}");
    expect(ENGLISH_WORDING.complaintWithLink).toContain("{complaint}");
  });
});

// Each built-in store keeps the snapshots the same way.
async function storeContract(store: NoticeStore) {
  const en = buildNotice(config);
  const hi = buildNotice(config, { language: "hi" });
  expect(await store.savePrivacyNotice(en, "2026-12-01T10:00:00.000Z")).toBe(true);
  expect(await store.savePrivacyNotice(en, "2026-12-02T10:00:00.000Z")).toBe(false); // first shown stays the first
  expect(await store.savePrivacyNotice(hi, "2026-12-03T10:00:00.000Z")).toBe(true);
  expect(await store.getPrivacyNotice(en.version, "en", "consent")).toEqual({ notice: en, firstShownAt: "2026-12-01T10:00:00.000Z" });
  expect(await store.getPrivacyNotice(en.version, "hi", "consent")).toBeUndefined();
  expect((await store.listPrivacyNotices()).map((s) => s.notice.language)).toEqual(["en", "hi"]);
}

describe.each(backends)("$name store keeps notices (Postgres via PGlite)", (backend) => {
  it("saves each notice once and reads it back exactly", async () => {
    const client = new PGlite();
    await client.exec(DPDP_DDL);
    await storeContract(backend.store(client) as unknown as NoticeStore);
    await client.close();
  });
});

describe("mongo store keeps notices", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
  }, 120_000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it("saves each notice once and reads it back exactly", async () => {
    await storeContract(mongoStore(client.db("notices")));
  });
});
