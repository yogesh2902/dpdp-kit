import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone"),
  fullName: text("full_name"),
  createdAt: timestamp("created_at"),
});
