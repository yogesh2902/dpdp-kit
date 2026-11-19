// Sample project config for testing the GitHub Action. Imports dpdp-kit like a real app.
import { defineConfig } from "dpdp-kit";

export default defineConfig({
  fiduciary: { name: "Sample Shop", grievanceUrl: "https://shop.example/grievance" },
  purposes: {
    account: { basis: "legitimate-use", legitimateUse: "7(a)", retain: "while-active" },
    promo: { basis: "consent", retain: { afterWithdrawal: "0d" } },
  },
  data: {
    users: {
      table: "users",
      subject: "id",
      fields: {
        phone: { category: "contact", purposes: ["account", "promo"] },
        fullName: { category: "identity", purposes: ["account"] },
      },
    },
  },
  minimumRetention: "1y",
});
