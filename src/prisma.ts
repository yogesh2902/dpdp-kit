// dpdp-kit on Prisma: the store and data access run plain SQL through `$queryRawUnsafe` (with
// parameters, never interpolated values). Tested on Prisma 7 with @prisma/adapter-pg; every
// parameter is cast explicitly, so earlier versions should work too.
// Postgres only. The dpdp-kit tables come from PRISMA_MODELS, added to schema.prisma.
import type { AccessLogStore } from "./access.js";
import type { BreachStore } from "./breach.js";
import type { DataAccess } from "./data-access.js";
import { postgresData, postgresStore, type SqlQuery } from "./postgres.js";
import type { Schema, SchemaColumn, SchemaReference, SchemaTable } from "./schema-check.js";
import type { DpdpStore } from "./store.js";

export { castType, DPDP_DDL, isUniqueViolation, type SqlQuery } from "./postgres.js";

/** The one method dpdp-kit needs from a PrismaClient (or a transaction client). */
export interface PrismaLike {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/** Run SQL through a PrismaClient. */
export const prismaQuery =
  (prisma: PrismaLike): SqlQuery =>
  async (text, params) =>
    (await prisma.$queryRawUnsafe(text, ...params)) as Record<string, unknown>[];

/**
 * Store on Postgres through Prisma: consent events, rights requests, erasure tasks, the access
 * log and breaches. Add `PRISMA_MODELS` to your schema.prisma and run `prisma migrate dev`.
 *
 * ```ts
 * const dpdp = createDpdp({ config, store: prismaStore(prisma), data: prismaData(prisma, { schema }) });
 * ```
 */
export function prismaStore(prisma: PrismaLike): DpdpStore & AccessLogStore & BreachStore {
  return postgresStore(prismaQuery(prisma));
}

/**
 * Data access for your own tables through Prisma, for access summaries and erasure. Pass the
 * schema (`prismaSchema(text)`) so the data map can use model and field names (`User`,
 * `phoneNumber`) where the database has others (`users`, `phone_number`).
 */
export function prismaData(prisma: PrismaLike, options: { schema?: Schema } = {}): DataAccess {
  return postgresData(prismaQuery(prisma), options);
}

const SCALAR: Record<string, { type: NonNullable<SchemaColumn["type"]>; sqlType: string }> = {
  String: { type: "string", sqlType: "text" },
  Boolean: { type: "boolean", sqlType: "boolean" },
  Int: { type: "number", sqlType: "integer" },
  BigInt: { type: "number", sqlType: "bigint" },
  Float: { type: "number", sqlType: "double precision" },
  Decimal: { type: "number", sqlType: "numeric" },
  DateTime: { type: "other", sqlType: "timestamp(3)" },
  Json: { type: "other", sqlType: "jsonb" },
  Bytes: { type: "other", sqlType: "bytea" },
};

/** Postgres native types (`@db.VarChar(255)`) by their Prisma names. */
const NATIVE: Record<string, string> = {
  Text: "text", VarChar: "varchar", Char: "char", Uuid: "uuid", Citext: "citext", Inet: "inet", Xml: "xml", Bit: "bit", VarBit: "varbit",
  SmallInt: "smallint", Integer: "integer", Oid: "oid", BigInt: "bigint", Real: "real", DoublePrecision: "double precision",
  Decimal: "numeric", Money: "money", Timestamp: "timestamp", Timestamptz: "timestamptz", Date: "date", Time: "time", Timetz: "timetz",
  Boolean: "boolean", Json: "json", JsonB: "jsonb", ByteA: "bytea",
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The line without its `//` comment, leaving `//` inside strings alone. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inString) i++;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** `@map("x")`, `@@map(name: "x")` */
const mapName = (attrs: string, prefix: "@" | "@@") => {
  const m = new RegExp(`(?:^|\\s)${prefix === "@" ? "@" : "@@"}map\\(\\s*(?:name\\s*:\\s*)?"((?:[^"\\\\]|\\\\.)*)"`).exec(attrs);
  return m ? m[1]!.replace(/\\(.)/g, "$1") : undefined;
};

interface Block {
  kind: "model" | "view" | "enum" | "type";
  name: string;
  lines: string[];
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let current: Block | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (!current) {
      const m = /^(model|view|enum|type)\s+(\w+)\s*\{\s*$/.exec(line);
      if (m) current = { kind: m[1] as Block["kind"], name: m[2]!, lines: [] };
      continue;
    }
    if (line === "}") {
      out.push(current);
      current = undefined;
    } else current.lines.push(line);
  }
  return out;
}

/**
 * Read a Prisma schema (the text of schema.prisma, or of several .prisma files joined) into the
 * neutral shape `dpdp-kit audit --schema` and `prismaData()` use. Each model and view becomes a
 * table named as in the database (`@@map`), with the model name as its `key`; each scalar field
 * becomes a column (`@map`), with the field name as its `key`. Relation fields are skipped.
 */
export function prismaSchema(text: string): Schema {
  const all = blocks(text);
  const enums = new Map(all.filter((b) => b.kind === "enum").map((b) => [b.name, mapName(b.lines.join(" "), "@@") ?? b.name]));
  const composites = new Set(all.filter((b) => b.kind === "type").map((b) => b.name));
  const models = new Set(all.filter((b) => b.kind === "model" || b.kind === "view").map((b) => b.name));

  const tables: SchemaTable[] = [];
  const tableOf = new Map<string, string>(); // model name -> table name
  const relations: Array<{ model: string; fields: string[]; target: string; onDelete: SchemaReference["onDelete"] }> = [];
  for (const block of all) {
    if (block.kind !== "model" && block.kind !== "view") continue;
    const columns: SchemaColumn[] = [];
    let tableName = block.name;
    for (const line of block.lines) {
      if (line.startsWith("@@")) {
        tableName = mapName(line, "@@") ?? tableName;
        continue;
      }
      const m = /^(\w+)\s+(Unsupported\(\s*"(?:[^"\\]|\\.)*"\s*\)|[\w.]+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!m) continue;
      const [, field, typeName, list, optional, attrs = ""] = m as unknown as [string, string, string, string?, string?, string?];
      if (models.has(typeName) || composites.has(typeName)) {
        // A relation, not a column. The side with `fields:` holds the foreign key.
        const relation = /@relation\(([^)]*(?:\[[^\]]*\][^)]*)*)\)/.exec(attrs)?.[1] ?? "";
        const fields = /fields\s*:\s*\[([^\]]*)\]/.exec(relation)?.[1];
        if (fields && models.has(typeName)) {
          const action = /onDelete\s*:\s*(\w+)/.exec(relation)?.[1];
          relations.push({
            model: block.name,
            fields: fields.split(",").map((f) => f.trim()).filter(Boolean),
            target: typeName,
            // Prisma's defaults: SetNull for an optional relation, Restrict for a required one.
            onDelete: PRISMA_ACTIONS[action ?? (optional ? "SetNull" : "Restrict")] ?? "no action",
          });
        }
        continue;
      }
      const name = mapName(attrs, "@") ?? field;
      const native = /@db\.(\w+)(\(([^)]*)\))?/.exec(attrs);
      let sqlType: string | undefined;
      let type: NonNullable<SchemaColumn["type"]> = "other";
      const unsupported = /^Unsupported\(\s*"((?:[^"\\]|\\.)*)"/.exec(typeName);
      if (unsupported) sqlType = unsupported[1];
      else if (enums.has(typeName)) sqlType = quote(enums.get(typeName)!);
      else if (SCALAR[typeName]) {
        type = SCALAR[typeName].type;
        sqlType = SCALAR[typeName].sqlType;
      }
      if (native && NATIVE[native[1]!]) sqlType = `${NATIVE[native[1]!]}${native[2] ?? ""}`;
      if (sqlType && list) sqlType += "[]";
      columns.push({
        name,
        ...(name === field ? {} : { key: field }),
        notNull: !optional && !list,
        type: list ? "other" : type,
        ...(sqlType ? { sqlType } : {}),
      });
    }
    tableOf.set(block.name, tableName);
    tables.push({ name: tableName, ...(tableName === block.name ? {} : { key: block.name }), columns });
  }
  for (const r of relations) {
    const table = tables.find((t) => (t.key ?? t.name) === r.model);
    if (!table) continue;
    const columnName = (field: string) => table.columns.find((c) => (c.key ?? c.name) === field)?.name ?? field;
    const reference: SchemaReference = { columns: r.fields.map(columnName), table: tableOf.get(r.target) ?? r.target, ...(r.onDelete ? { onDelete: r.onDelete } : {}) };
    Object.assign(table, { references: [...(table.references ?? []), reference] });
  }
  return { tables };
}

const PRISMA_ACTIONS: Record<string, SchemaReference["onDelete"]> = {
  Cascade: "cascade",
  SetNull: "set null",
  SetDefault: "set default",
  Restrict: "restrict",
  NoAction: "no action",
};

/**
 * Prisma models for dpdp-kit's own tables. Paste them into schema.prisma (or save as
 * `prisma/schema/dpdp.prisma` with a multi-file schema) and run `prisma migrate dev`. They match
 * `DPDP_DDL` from `dpdp-kit/drizzle`, so either can create the tables.
 */
export const PRISMA_MODELS = `/// dpdp-kit: consent events, a hash chain per person (Section 6).
model DpdpConsentEvent {
  subjectId     String   @map("subject_id")
  seq           Int
  action        String
  purposes      Json
  noticeVersion String?  @map("notice_version")
  language      String?
  channel       String?
  evidence      Json?
  at            DateTime @db.Timestamptz(6)
  prevHash      String?  @map("prev_hash")
  hash          String

  @@id([subjectId, seq])
  @@map("dpdp_consent_events")
}

/// dpdp-kit: rights requests and grievances (Sections 11 to 14).
model DpdpRequest {
  id        String    @id
  subjectId String    @map("subject_id")
  type      String
  status    String
  openedAt  DateTime  @map("opened_at") @db.Timestamptz(6)
  dueAt     DateTime  @map("due_at") @db.Timestamptz(6)
  closedAt  DateTime? @map("closed_at") @db.Timestamptz(6)
  details   Json?
  history   Json

  @@index([subjectId], map: "dpdp_requests_subject_idx")
  @@index([status, dueAt], map: "dpdp_requests_status_due_idx")
  @@map("dpdp_requests")
}

/// dpdp-kit: erasure and processor tasks (Section 8(7), Rule 8).
model DpdpErasureTask {
  id        String    @id
  subjectId String    @map("subject_id")
  reason    String
  kind      String
  tableKey  String?   @map("table_key")
  fields    Json?
  processor String?
  purposes  Json?
  createdAt DateTime  @map("created_at") @db.Timestamptz(6)
  dueAt     DateTime  @map("due_at") @db.Timestamptz(6)
  status    String
  attempts  Int
  claimedAt DateTime? @map("claimed_at") @db.Timestamptz(6)
  doneAt    DateTime? @map("done_at") @db.Timestamptz(6)
  affected  Int?
  lastError String?   @map("last_error")
  note      String?

  @@index([subjectId], map: "dpdp_erasure_tasks_subject_idx")
  @@index([status, dueAt], map: "dpdp_erasure_tasks_status_due_idx")
  @@map("dpdp_erasure_tasks")
}

/// dpdp-kit: who accessed whose data, and why (Rule 6(1)(c), (e)).
model DpdpAccessLog {
  id           String   @id
  at           DateTime @db.Timestamptz(6)
  actor        String
  subjectId    String   @map("subject_id")
  action       String
  purpose      String
  fields       Json?
  outOfPurpose Json?    @map("out_of_purpose")
  reason       String?
  evidence     Json?

  @@index([at], map: "dpdp_access_log_at_idx")
  @@index([subjectId, at], map: "dpdp_access_log_subject_idx")
  @@index([actor, at], map: "dpdp_access_log_actor_idx")
  @@map("dpdp_access_log")
}

/// dpdp-kit: personal data breaches (Section 8(6), Rule 7).
model DpdpBreach {
  id          String   @id
  status      String
  awareAt     DateTime @map("aware_at") @db.Timestamptz(6)
  reportDueAt DateTime @map("report_due_at") @db.Timestamptz(6)
  data        Json

  @@index([status, awareAt], map: "dpdp_breaches_status_idx")
  @@map("dpdp_breaches")
}

/// dpdp-kit: each person affected by a breach, and whether they've been told (Rule 7(1)).
model DpdpBreachNotice {
  breachId  String    @map("breach_id")
  subjectId String    @map("subject_id")
  status    String
  addedAt   DateTime  @map("added_at") @db.Timestamptz(6)
  sentAt    DateTime? @map("sent_at") @db.Timestamptz(6)
  channel   String?

  @@id([breachId, subjectId])
  @@index([breachId, status, addedAt], map: "dpdp_breach_notices_status_idx")
  @@map("dpdp_breach_notices")
}
`;
