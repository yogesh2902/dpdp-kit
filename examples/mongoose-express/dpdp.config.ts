import { defineConfig } from "dpdp-kit";

/**
 * Chai & Co, a small online tea shop: what personal data it holds, why, and for how long.
 * `npm run audit` checks this file against the Mongoose models in src/models.ts.
 */
export default defineConfig({
  fiduciary: {
    name: "Chai & Co",
    grievanceUrl: "https://chai.example/privacy/grievance",
    dpo: "Meera Iyer, Data Protection Officer, privacy@chai.example, +91 80 4000 1234",
  },
  purposes: {
    account: { basis: "legitimate-use", retain: "while-active", description: "Run your account and deliver your orders" },
    marketing_sms: { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers by SMS" },
  },
  data: {
    // Mongoose model names (or the collections, users and orders). `id` is the document's _id.
    users: {
      table: "User",
      subject: "id",
      fields: {
        // Required fields say what erasing writes instead of removing them (`npm run audit` checks this).
        name: { category: "identity", purposes: ["account"], erase: "redact" },
        phone: { category: "contact", purposes: ["account", "marketing_sms"], erase: "redact" },
        email: { category: "contact", purposes: ["account"], erase: { value: ({ subjectId }) => `erased-${subjectId}@invalid` } },
        city: { category: "contact", purposes: ["account"] },
        interests: { category: "behavioural", purposes: ["marketing_sms"] },
      },
    },
    orders: {
      table: "Order",
      subject: "userId",
      fields: { address: { category: "contact", purposes: ["account"], erase: "redact" } },
      legalHold: { reason: "GST invoices (CGST Act, section 36)", keep: "8y", then: "anonymise" },
    },
  },
  processors: {
    msg91: { purposes: ["marketing_sms"], contract: "DPA signed 2026-03-01, clause 7" },
  },
  notPersonal: ["users.createdAt", "users.updatedAt", "orders.total", "orders.createdAt", "orders.updatedAt"],
  minimumRetention: "1y",
  security: {
    accessControl: "Google Workspace SSO, least-privilege roles, production through a bastion",
    backups: "Encrypted daily backups, restore tested monthly",
    measures: "Annual security training, quarterly access reviews",
  },
});
