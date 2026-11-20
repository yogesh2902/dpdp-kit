// A shop config and a provider wired to the real HTTP API, for the React tests.
import type { ReactNode } from "react";
import { createClient } from "../src/client.js";
import { createDpdp, defineConfig, memoryData, memoryStore } from "../src/index.js";
import { createHandlers } from "../src/next.js";
import { DpdpProvider } from "../src/react/index.js";

export const config = defineConfig({
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
export type Purpose = keyof typeof config.purposes;

/**
 * A provider whose client reaches the real API as u1; `hold` delays every answer, `holdNextWrite`
 * only the next write, and `refuse` turns writes away.
 */
export function setup() {
  const dpdp = createDpdp({ config, store: memoryStore(), data: memoryData({ users: [{ id: "u1", name: "Asha", phone: "98xxxxxx01" }] }) });
  const control = { refuse: false, hold: undefined as Promise<void> | undefined, holdNextWrite: undefined as Promise<void> | undefined, calls: [] as string[] };
  const handlers = createHandlers(dpdp, { base: "/privacy", subject: () => "u1", limitWrites: () => !control.refuse });
  const client = createClient({
    base: "http://shop.test/privacy",
    fetch: (async (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      control.calls.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
      if (control.hold) await control.hold;
      if (req.method !== "GET" && control.holdNextWrite) {
        const wait = control.holdNextWrite;
        control.holdNextWrite = undefined;
        await wait;
      }
      return handlers[req.method as "GET" | "POST" | "DELETE"](req);
    }) as typeof fetch,
  });
  const wrapper = ({ children }: { children: ReactNode }) => <DpdpProvider client={client}>{children}</DpdpProvider>;
  return { dpdp, control, wrapper };
}
