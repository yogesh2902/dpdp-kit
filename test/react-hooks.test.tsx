// @vitest-environment jsdom
// dpdp-kit/react hooks in a browser-like DOM, against the real HTTP API through the Next.js handlers.
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { createDpdp, defineConfig, memoryData, memoryStore } from "../src/index.js";
import { createHandlers } from "../src/next.js";
import {
  DpdpProvider,
  useConsents,
  useMyData,
  useNominees,
  useNotice,
  useNoticeLanguages,
  useRequests,
  useRights,
} from "../src/react/index.js";

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
  processors: { msg91: { purposes: ["offers"], contract: "DPA", countries: ["IN"] } },
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
  rights: { how: "Settings → Privacy" },
  minimumRetention: "1y",
  security: { accessControl: "SSO", backups: "Daily", measures: "Training" },
});
type Purpose = keyof typeof config.purposes;

/** A provider whose client reaches the real API as u1; `hold` delays answers, `refuse` turns writes away. */
function setup() {
  const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData({ users: [{ id: "u1", name: "Asha", phone: "98xxxxxx01" }] }) });
  const control = { refuse: false, hold: undefined as Promise<void> | undefined, calls: [] as string[] };
  const handlers = createHandlers(dpdp, { base: "/privacy", subject: () => "u1", limitWrites: () => !control.refuse });
  const client = createClient({
    base: "http://shop.test/privacy",
    fetch: (async (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      control.calls.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
      if (control.hold) await control.hold;
      return handlers[req.method as "GET" | "POST" | "DELETE"](req);
    }) as typeof fetch,
  });
  const wrapper = ({ children }: { children: ReactNode }) => <DpdpProvider client={client}>{children}</DpdpProvider>;
  return { dpdp, control, wrapper };
}

describe("dpdp-kit/react hooks", () => {
  it("needs a provider", () => {
    expect(() => renderHook(() => useRights())).toThrow(/wrap your component in <DpdpProvider>/);
  });

  it("switches consents on and off, and reloads the data summary that depends on them", async () => {
    const { dpdp, wrapper } = setup();
    const { result } = renderHook(() => ({ consents: useConsents<Purpose>(), data: useMyData() }), { wrapper });
    await waitFor(() => expect(result.current.consents.loading).toBe(false));
    expect(result.current.consents.purposes.map((p) => [p.purpose, p.active])).toEqual([
      ["account", true],
      ["receipts", true],
      ["offers", false],
    ]);
    await waitFor(() => expect(result.current.data.data?.sharedWith).toEqual([]));

    await act(() => result.current.consents.set("offers", true));
    expect(await dpdp.consent.active("u1")).toEqual(["offers"]);
    // Granting offers shares the phone with msg91, so the summary reloads to say so.
    await waitFor(() => expect(result.current.data.data?.sharedWith.map((s) => s.name)).toEqual(["msg91"]));

    await act(() => result.current.consents.set("receipts", false)); // a 7(a) use: an objection
    expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]);
    expect(result.current.consents.data?.objections).toEqual(["receipts"]);
    await expect(result.current.consents.set("account", false)).rejects.toThrow(/can't be switched off/);
  });

  it("shows a change at once, and undoes it when the server refuses", async () => {
    const { control, wrapper } = setup();
    const { result } = renderHook(() => useConsents<Purpose>(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let release!: () => void;
    control.hold = new Promise((r) => (release = r));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.set("offers", true);
    });
    expect(result.current.purposes.find((p) => p.purpose === "offers")?.active).toBe(true); // before the server answers
    expect(result.current.saving.has("offers")).toBe(true);
    control.refuse = true;
    control.hold = undefined;
    release();
    await act(() => expect(saving).rejects.toMatchObject({ status: 429, code: "too-many-requests" }));
    expect(result.current.purposes.find((p) => p.purpose === "offers")?.active).toBe(false);
    expect(result.current.error).toMatchObject({ code: "too-many-requests" });
    expect(result.current.saving.size).toBe(0);
  });

  it("loads the notice in the language asked for, keeping only the latest answer", async () => {
    const { control, wrapper } = setup();
    const { result: langs } = renderHook(() => useNoticeLanguages(), { wrapper });
    await waitFor(() => expect(langs.current.data).toEqual(["en", "hi"]));

    let release!: () => void;
    control.hold = new Promise((r) => (release = r));
    const { result, rerender } = renderHook(({ language }: { language: "en" | "hi" }) => useNotice({ language }), { wrapper, initialProps: { language: "en" } });
    control.hold = undefined;
    rerender({ language: "hi" }); // asked before the English answer arrives
    await waitFor(() => expect(result.current.data?.language).toBe("hi"));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.data?.language).toBe("hi"); // the late English answer is ignored
    expect(result.current.data?.items[0]?.description).toBe("एसएमएस से ऑफ़र");
  });

  it("opens requests and keeps nominees, reloading the lists", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => ({ requests: useRequests(), nominees: useNominees(), rights: useRights() }), { wrapper });
    await waitFor(() => expect(result.current.requests.loading).toBe(false));
    expect(result.current.rights.data?.how).toBe("Settings → Privacy");

    let ack = "";
    await act(async () => {
      ack = (await result.current.requests.open("access")).acknowledgement.text;
    });
    expect(ack).toMatch(/Your reference is/);
    await waitFor(() => expect(result.current.requests.requests.map((r) => r.type)).toEqual(["access"]));

    await act(async () => {
      await result.current.nominees.nominate({ name: "Ravi", contact: "ravi@example.in" });
    });
    await waitFor(() => expect(result.current.nominees.nominees.map((n) => n.name)).toEqual(["Ravi"]));
    // A nomination is recorded as a (resolved) request, so the requests list reloads too.
    await waitFor(() => expect(result.current.requests.requests.map((r) => r.type)).toEqual(["access", "nomination"]));
    await act(() => result.current.nominees.revoke(result.current.nominees.nominees[0]!.id));
    await waitFor(() => expect(result.current.nominees.nominees).toEqual([]));
  });
});
