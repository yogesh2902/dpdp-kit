// The same schema after a few months of feature work, without anyone updating the data map.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone"),
  name: text("name"),
  // `interests` was dropped
  aadhaarNumber: text("aadhaar_number"), // new, personal, not in the data map
  gender: text("gender"), // new, maybe personal
  emailVerifiedAt: timestamp("email_verified_at"),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  address: text("address"),
});

// `analytics_events` was replaced by an external analytics tool

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name"),
});

export const leads = pgTable("leads", {
  id: text("id").primaryKey(),
  email: text("email"), // a whole new table of personal data
  companyName: text("company_name"),
});
