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
    // Section 7(a): the number they gave for their orders; they can say they don't want these SMS.
    order_sms: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active", description: "SMS updates about your orders" },
    marketing_sms: { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers and new teas by SMS" },
  },
  data: {
    // Mongoose model names (or the collections, users and orders). `id` is the document's _id.
    users: {
      table: "User",
      subject: "id",
      fields: {
        // Required fields say what erasing writes instead of removing them (`npm run audit` checks this).
        name: { category: "identity", purposes: ["account"], erase: "redact" },
        phone: { category: "contact", purposes: ["account", "order_sms", "marketing_sms"], erase: "redact", label: "Mobile number" },
        email: { category: "contact", purposes: ["account"], erase: { value: ({ subjectId }) => `erased-${subjectId}@invalid` } },
        city: { category: "contact", purposes: ["account"] },
        interests: { category: "behavioural", purposes: ["marketing_sms"], label: "The teas you like" },
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
    msg91: { purposes: ["marketing_sms"], contract: "DPA signed 2026-03-01, clause 7", countries: ["IN"] },
  },
  notPersonal: ["users.createdAt", "users.updatedAt", "orders.total", "orders.createdAt", "orders.updatedAt"],
  minimumRetention: "1y",
  // Rule 3: the notice is built from the purposes and fields above, with these links.
  notice: {
    links: {
      website: "https://chai.example/privacy",
      withdraw: "Profile → Privacy in the app, or https://chai.example/privacy/consents",
      rights: "https://chai.example/privacy/requests",
    },
  },
  rights: { how: "In the app: Profile → Privacy, or email privacy@chai.example", identifiers: ["registered mobile number"] },
  security: {
    accessControl: "Google Workspace SSO, least-privilege roles, production through a bastion",
    backups: "Encrypted daily backups, restore tested monthly",
    measures: "Annual security training, quarterly access reviews",
  },
});
