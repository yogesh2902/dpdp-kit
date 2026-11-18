import type { Issue } from "./audit.js";
import { type DpdpConfig, type EraseWith, REDACTED } from "./config.js";
import { guessPersonal, type PersonalGuess } from "./personal.js";

/** A column as your ORM sees it: its database name, and the property name in code if different. */
export interface SchemaColumn {
  name: string;
  key?: string;
  /** The column rejects NULL. Used to check each field's `erase` setting. */
  notNull?: boolean;
  /** Kind of value the column holds, when known. Used to check each field's `erase` setting. */
  type?: "string" | "number" | "boolean" | "other";
  /** The column's SQL type (`integer`, `uuid`, `varchar(255)`…), when known. SQL data access casts parameters to it. */
  sqlType?: string;
}

export interface SchemaTable {
  /** The table's name in the database. */
  name: string;
  /** The name in code, if different: a Prisma model name (`User` for `@@map("users")`). The data map may use either. */
  key?: string;
  columns: readonly SchemaColumn[];
}

/** Your database schema in a neutral shape. `drizzleSchema()` and `prismaSchema()` build one. */
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
/**
 * An erase setting that the column can't take fails only when the task runs, which is often a year
 * after the withdrawal (Rule 8(3)). Catch it now, from the schema.
 */
function checkEraseAgainstColumn(erase: EraseWith | undefined, column: SchemaColumn, path: string, where: string, issues: Issue[]) {
  const fixed = erase === undefined || erase === "null" ? null : erase === "redact" ? REDACTED : typeof erase.value === "function" ? undefined : erase.value;
  if (fixed === undefined) return; // a function: checked when it runs
  if (fixed === null) {
    if (column.notNull) {
      issues.push({
        level: "error",
        code: "erase-not-null",
        path,
        message: `${where} is NOT NULL, so erasing it to NULL will fail. Set erase: "redact" for text, or erase: { value: … } with something the column accepts.`,
      });
    }
    return;
  }
  const kind = typeof fixed as "string" | "number" | "boolean";
  if (column.type && column.type !== "other" && column.type !== kind) {
    issues.push({
      level: "error",
      code: "erase-type-mismatch",
      path,
      message: `${where} holds ${column.type} values, but erase writes a ${kind} (${JSON.stringify(fixed)}). Use erase: { value: … } with a ${column.type}.`,
    });
  }
}

export function checkSchema(config: DpdpConfig<string>, schema: Schema): Issue[] {
  const issues: Issue[] = [];
  const byName = new Map<string, SchemaTable>();
  for (const table of schema.tables) if (!byName.has(table.name)) byName.set(table.name, table);
  for (const table of schema.tables) if (table.key && !byName.has(table.key)) byName.set(table.key, table);

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
    for (const [field, fieldDef] of Object.entries(def.fields ?? {})) {
      const column = table.columns.find((c) => matches(c, field));
      if (column) {
        list.push(column);
        checkEraseAgainstColumn(fieldDef.erase, column, `data.${key}.fields.${field}.erase`, `${table.name}.${column.name}`, issues);
      } else {
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
  for (const table of new Set(byName.values())) {
    const tableNames = table.key ? [table.name, table.key] : [table.name];
    if (table.name.startsWith(OWN_TABLE_PREFIX) || tableNames.some((t) => ignore.tables.has(t))) continue;
    const known = mapped.get(table.name) ?? [];
    for (const column of table.columns) {
      if (known.includes(column)) continue;
      const columnNames = column.key ? [column.name, column.key] : [column.name];
      if (tableNames.some((t) => columnNames.some((c) => ignore.columns.has(`${t}.${c}`)))) continue;
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
