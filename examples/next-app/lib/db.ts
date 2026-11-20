// One SQLite file holds the shop's tables and dpdp-kit's records. node:sqlite needs Node 22.5+.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, type SqliteQuery, sqliteQuery } from "dpdp-kit/sqlite";

const file = process.env.DB_FILE ?? ".data/chai.db";

function open() {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SQLITE_DDL);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, name text NOT NULL, phone text NOT NULL, email text NOT NULL, city text, interests text,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE IF NOT EXISTS orders (
      id integer PRIMARY KEY, user_id text NOT NULL, address text NOT NULL, total integer NOT NULL,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id);`);
  return db;
}

// Opened on first use, not when Next.js loads the module (its build loads routes in parallel),
// and once per process however often the module is loaded.
const g = globalThis as unknown as { chaiDb?: DatabaseSync };
export const db = () => (g.chaiDb ??= open());

/** For dpdp-kit's store and data access: runs each statement on the shared connection. */
export const query: SqliteQuery = (sql, params) => sqliteQuery(db())(sql, params);
