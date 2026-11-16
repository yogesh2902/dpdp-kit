import { defineConfig } from "../../src/index.js";

/** A small e-commerce app, used across the tests. */
export const config = defineConfig({
  fiduciary: { name: "Acme Pvt Ltd", grievanceUrl: "https://acme.example/privacy/grievance" },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active" },
    order_updates: { basis: "consent", retain: "while-active" },
    marketing_sms: { basis: "consent", retain: { afterWithdrawal: "0d" } },
    analytics: { basis: "consent", retain: { afterWithdrawal: "30d" } },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        phone: { category: "contact", purposes: ["account", "order_updates", "marketing_sms"] },
        name: { category: "identity", purposes: ["account"] },
        interests: { category: "behavioural", purposes: ["marketing_sms", "analytics"] },
      },
    },
    orders: {
      table: "orders",
      subject: "user_id",
      fields: { address: { category: "contact", purposes: ["account"] } },
      legalHold: { reason: "GST records", keep: "8y", then: "anonymise" },
    },
    events: {
      table: "analytics_events",
      subject: "user_id",
      fields: { device: { category: "device", purposes: ["analytics"] } },
    },
  },
  processors: {
    msg91: { purposes: ["order_updates", "marketing_sms"] },
    posthog: { purposes: ["analytics"] },
  },
  minimumRetention: "1y",
  notPersonal: ["products.name"],
});

export default config;
