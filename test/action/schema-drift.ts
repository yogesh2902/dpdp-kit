import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Someone added an Aadhaar column without updating the data map.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone"),
  fullName: text("full_name"),
  aadhaarNumber: text("aadhaar_number"),
  createdAt: timestamp("created_at"),
});
