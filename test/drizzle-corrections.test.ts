// Corrections through Drizzle keep array columns as arrays, and write other objects as JSON.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { drizzleData } from "../src/drizzle.js";

it("drizzle updateFields writes arrays to array columns", async () => {
  const client = new PGlite();
  await client.exec(`CREATE TABLE people (id text, user_id text, phones text[], prefs jsonb)`);
  await client.exec(`INSERT INTO people VALUES ('p1', 'u1', ARRAY['1'], '{}')`);
  const people = pgTable("people", { id: text("id"), userId: text("user_id"), phones: text("phones").array(), prefs: text("prefs") });
  const data = drizzleData(drizzle(client), { schema: { people } });
  expect(await data.updateFields!("people", "userId", "u1", { phones: ["98", "99"], prefs: { sms: false } })).toBe(1);
  const { rows } = await client.query(`SELECT phones, prefs FROM people`);
  expect(rows).toEqual([{ phones: ["98", "99"], prefs: { sms: false } }]);
});
