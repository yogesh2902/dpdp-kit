import type { Issue } from "./audit.js";
import type { DpdpConfig } from "./config.js";
import { guessPersonal, type PersonalGuess } from "./personal.js";

/** A column as your ORM sees it: its database name, and the property name in code if different. */
export interface SchemaColumn {
  name: string;
  key?: string;
}

export interface SchemaTable {
  name: string;
  columns: readonly SchemaColumn[];
}

/** Your database schema in a neutral shape. `drizzleSchema()` builds one from a Drizzle schema. */
export interface Schema {
  tables: readonly SchemaTable[];
}

/** dpdp-kit's own tables (`dpdp_consent_events`…) are never checked. */
const OWN_TABLE_PREFIX = "dpdp_";

const matches = (column: SchemaColumn, name: string) => column.name === name || column.key === name;

function parseNotPersonal(entries: readonly string[] | undefined) {
  const columns = new Set<string>();
  const tables = new Set<string>();
  for (const entry of entries ?? []) {
    const dot = entry.lastIndexOf(".");
    if (dot <= 0) continue;
    const table = entry.slice(0, dot);
    const column = entry.slice(dot + 1);
    if (column === "*") tables.add(table);
    else columns.add(`${table}.${column}`);
  }
  return { columns, tables };
}

function strongest(a: PersonalGuess | undefined, b: PersonalGuess | undefined) {
  if (!a) return b;
  if (!b) return a;
  return b.confidence === "strong" && a.confidence === "weak" ? b : a;
}

/**
 * Compare the data map with the real schema, both ways:
 * - columns that look personal but aren't in the data map (strong guesses are errors, weak ones
 *   warnings), so a new `phone` column can't ship without a purpose;
 * - data map entries whose table or column no longer exists, so the map can't go stale.
 */
export function checkSchema(config: DpdpConfig<string>, schema: Schema): Issue[] {
  const issues: Issue[] = [];
  const byName = new Map<string, SchemaTable>();
  for (const table of schema.tables) if (!byName.has(table.name)) byName.set(table.name, table);

  // 1. The data map must point at real tables and columns.
  const mapped = new Map<string, SchemaColumn[]>();
  for (const [key, def] of Object.entries(config.data ?? {})) {
    const table = byName.get(def.table);
    if (!table) {
      issues.push({
        level: "error",
        code: "unknown-table",
        path: `data.${key}.table`,
        message: `Table "${def.table}" isn't in the schema. Fix the name, or remove it from the data map if the table is gone.`,
      });
      continue;
    }
    const list = mapped.get(table.name) ?? [];
    const subject = table.columns.find((c) => matches(c, def.subject));
    if (subject) list.push(subject);
    else {
      issues.push({
        level: "error",
        code: "unknown-column",
        path: `data.${key}.subject`,
        message: `Column "${def.subject}" isn't in table "${table.name}". The subject column must exist to find a person's rows.`,
      });
    }
    for (const field of Object.keys(def.fields ?? {})) {
      const column = table.columns.find((c) => matches(c, field));
      if (column) list.push(column);
      else {
        issues.push({
          level: "error",
          code: "unknown-column",
          path: `data.${key}.fields.${field}`,
          message: `Column "${field}" isn't in table "${table.name}". Fix the name, or remove it if the column was dropped.`,
        });
      }
    }
    mapped.set(table.name, list);
  }

  // 2. notPersonal entries must still point at something.
  const ignore = parseNotPersonal(config.notPersonal);
  for (const entry of config.notPersonal ?? []) {
    const dot = entry.lastIndexOf(".");
    const tableName = entry.slice(0, Math.max(dot, 0));
    const columnName = entry.slice(dot + 1);
    const table = byName.get(tableName);
    const exists = table && (columnName === "*" || table.columns.some((c) => matches(c, columnName)));
    if (!exists) {
      issues.push({
        level: "warning",
        code: "stale-not-personal",
        path: "notPersonal",
        message: `"${entry}" doesn't match any table or column. Use "table.column" or "table.*", or remove it.`,
      });
    }
  }

  // 3. Every column that looks personal must be in the data map or in notPersonal.
  for (const table of byName.values()) {
    if (table.name.startsWith(OWN_TABLE_PREFIX) || ignore.tables.has(table.name)) continue;
    const known = mapped.get(table.name) ?? [];
    for (const column of table.columns) {
      if (known.includes(column)) continue;
      if (ignore.columns.has(`${table.name}.${column.name}`)) continue;
      if (column.key && ignore.columns.has(`${table.name}.${column.key}`)) continue;
      const guess = strongest(guessPersonal(column.name), column.key ? guessPersonal(column.key) : undefined);
      if (!guess) continue;
      issues.push({
        level: guess.confidence === "strong" ? "error" : "warning",
        code: "unmapped-personal-column",
        path: `schema.${table.name}.${column.name}`,
        message:
          `Looks like personal data (${guess.category}, matched "${guess.matched}") but isn't in the data map. ` +
          `Add it under \`data\` with the purposes it's held for, or add "${table.name}.${column.name}" to \`notPersonal\`.`,
      });
    }
  }

  return issues;
}
