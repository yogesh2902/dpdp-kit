// A Drizzle schema that matches test/fixtures/config.ts exactly.
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone"),
  name: text("name"),
  interests: text("interests"),
  emailVerifiedAt: timestamp("email_verified_at"), // describes data, isn't personal itself
  createdAt: timestamp("created_at"),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  address: text("address"),
  total: integer("total"),
});

export const analyticsEvents = pgTable("analytics_events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  device: text("device"),
});

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name"), // listed in notPersonal
});

// dpdp-kit's own table is skipped by the check.
export { consentEvents } from "../../src/drizzle.js";
