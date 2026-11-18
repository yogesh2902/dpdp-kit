// dpdp-kit on MongoDB: the store, data access for your own collections, and a Mongoose schema
// reader for `dpdp-kit audit --schema`. Works with the official driver's `Db` (`client.db()`) or
// Mongoose's (`mongoose.connection.db`). Typed by shape, so any driver version from 5 on fits.
import type { AccessEntry, AccessLogStore } from "./access.js";
import type { Breach, BreachNotice, BreachStore, NoticeCounts } from "./breach.js";
import type { ErasedValue } from "./config.js";
import type { DataAccess } from "./data-access.js";
import { SeqConflictError } from "./errors.js";
import type { ErasureTask, RightsRequest } from "./records.js";
import type { Schema, SchemaColumn, SchemaTable } from "./schema-check.js";
import type { ConsentEvent, DpdpStore } from "./store.js";

type Doc = Record<string, any>;

/** The collection methods dpdp-kit uses, as the official driver has them. */
export interface MongoCollectionLike {
  insertOne(doc: Doc): Promise<unknown>;
  insertMany(docs: Doc[], options?: Doc): Promise<{ insertedCount: number }>;
  findOne(filter: Doc, options?: Doc): Promise<Doc | null>;
  find(filter: Doc, options?: Doc): { toArray(): Promise<Doc[]> };
  replaceOne(filter: Doc, doc: Doc): Promise<{ matchedCount: number }>;
  updateOne(filter: Doc, update: Doc): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(filter: Doc, update: Doc): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(filter: Doc): Promise<{ deletedCount: number }>;
  aggregate(pipeline: Doc[]): { toArray(): Promise<Doc[]> };
  createIndexes(indexes: Doc[]): Promise<unknown>;
}

/** A MongoDB database: the driver's `Db`, or Mongoose's `mongoose.connection.db`. */
export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
}

/** A database, or a function returning one, for Mongoose apps that create dpdp before connecting. */
export type MongoDbSource = MongoDbLike | (() => MongoDbLike | undefined);

const COLLECTIONS = {
  events: "dpdp_consent_events",
  requests: "dpdp_requests",
  tasks: "dpdp_erasure_tasks",
  access: "dpdp_access_log",
  breaches: "dpdp_breaches",
  notices: "dpdp_breach_notices",
} as const;

const INDEXES: Record<keyof typeof COLLECTIONS, Doc[]> = {
  // The unique key keeps each person's consent chain from forking (see SeqConflictError).
  events: [{ key: { subjectId: 1, seq: 1 }, name: "dpdp_subject_seq", unique: true }],
  requests: [
    { key: { subjectId: 1 }, name: "dpdp_subject" },
    { key: { status: 1, dueAt: 1 }, name: "dpdp_status_due" },
  ],
  tasks: [
    { key: { subjectId: 1 }, name: "dpdp_subject" },
    { key: { status: 1, dueAt: 1 }, name: "dpdp_status_due" },
  ],
  access: [
    { key: { at: 1, _id: 1 }, name: "dpdp_at" },
    { key: { subjectId: 1, at: 1 }, name: "dpdp_subject_at" },
    { key: { actor: 1, at: 1 }, name: "dpdp_actor_at" },
  ],
  breaches: [{ key: { status: 1, awareAt: -1 }, name: "dpdp_status_aware" }],
  notices: [
    { key: { breachId: 1, subjectId: 1 }, name: "dpdp_breach_subject", unique: true },
    { key: { breachId: 1, status: 1, addedAt: 1, subjectId: 1 }, name: "dpdp_breach_status" },
  ],
};

const resolveDb = (source: MongoDbSource): MongoDbLike => {
  const db = typeof source === "function" ? source() : source;
  if (!db) throw new Error("dpdp-kit/mongodb: the database isn't connected yet (mongoose.connection.db is undefined).");
  return db;
};

/**
 * Create the indexes dpdp-kit's collections need. The store does this itself before its first
 * write; call it from a migration or deploy script if your app user can't create indexes.
 */
export async function createMongoIndexes(source: MongoDbSource): Promise<void> {
  const db = resolveDb(source);
  await Promise.all(Object.entries(INDEXES).map(([k, specs]) => db.collection(COLLECTIONS[k as keyof typeof COLLECTIONS]).createIndexes(specs)));
}

/** Duplicate key errors: code 11000, on the error or in the server's response. */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: unknown; errorResponse?: { code?: unknown }; writeErrors?: Array<{ code?: unknown }> } | undefined;
  return e?.code === 11000 || e?.errorResponse?.code === 11000;
}

const toDate = (v: string | undefined) => (v === undefined ? undefined : new Date(v));
const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? undefined : new Date(v as string).toISOString());

/** A copy without undefined values, which the driver would otherwise store as null. */
const clean = (o: Doc): Doc => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A stored document back as a dpdp-kit record: `_id` as `id` (when asked), dates as ISO text, nulls dropped. */
function fromDoc<T>(doc: Doc, dates: readonly string[], idField?: string, keepNull: readonly string[] = []): T {
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id") {
      if (idField) out[idField] = v;
      continue;
    }
    if (v === null || v === undefined) {
      if (keepNull.includes(k)) out[k] = null;
      continue;
    }
    out[k] = dates.includes(k) ? toIso(v) : v;
  }
  return out as T;
}

const EVENT_DATES = ["at"];
const REQUEST_DATES = ["openedAt", "dueAt", "closedAt"];
const TASK_DATES = ["createdAt", "dueAt", "claimedAt", "doneAt"];
const ACCESS_DATES = ["at"];
const NOTICE_DATES = ["addedAt", "sentAt"];

const requestDoc = (r: RightsRequest) => {
  const { id, ...rest } = r;
  return clean({ _id: id, ...rest, openedAt: toDate(r.openedAt), dueAt: toDate(r.dueAt), closedAt: toDate(r.closedAt) });
};
const taskDoc = (t: ErasureTask) => {
  const { id, ...rest } = t;
  return clean({ _id: id, ...rest, createdAt: toDate(t.createdAt), dueAt: toDate(t.dueAt), claimedAt: toDate(t.claimedAt), doneAt: toDate(t.doneAt) });
};
const breachDoc = (b: Breach) => ({ _id: b.id, status: b.status, awareAt: new Date(b.awareAt), reportDueAt: new Date(b.reportDueAt), data: b });

/** Tasks a runner may pick up now (see `TaskStore.dueTasks`). */
const runnable = (now: string, staleBefore: string, maxAttempts: number): Doc => ({
  dueAt: { $lte: new Date(now) },
  $or: [{ status: "pending" }, { status: "failed", attempts: { $lt: maxAttempts } }, { status: "running", claimedAt: { $lt: new Date(staleBefore) } }],
});

const BATCH = 1000;

/**
 * Store on MongoDB: consent events, rights requests, erasure tasks, the access log and breaches,
 * in `dpdp_*` collections. Creates its indexes before the first write.
 *
 * ```ts
 * const store = mongoStore(client.db());                  // the official driver
 * const store = mongoStore(() => mongoose.connection.db); // Mongoose, before or after connecting
 * ```
 */
export function mongoStore(source: MongoDbSource): DpdpStore & AccessLogStore & BreachStore {
  let ready: Promise<void> | undefined;
  const col = async (name: keyof typeof COLLECTIONS) => {
    ready ??= createMongoIndexes(source).catch((err: unknown) => {
      ready = undefined; // try again next time
      throw err;
    });
    await ready;
    return resolveDb(source).collection(COLLECTIONS[name]);
  };

  return {
    async lastEvent(subjectId) {
      const [doc] = await (await col("events")).find({ subjectId }, { sort: { seq: -1 }, limit: 1 }).toArray();
      return doc ? fromDoc<ConsentEvent>(doc, EVENT_DATES, undefined, ["prevHash"]) : undefined;
    },
    async insert(e) {
      try {
        await (await col("events")).insertOne(clean({ ...e, at: new Date(e.at) }));
      } catch (err) {
        if (isDuplicateKey(err)) throw new SeqConflictError(e.subjectId, e.seq);
        throw err;
      }
    },
    async events(subjectId) {
      const docs = await (await col("events")).find({ subjectId }, { sort: { seq: 1 } }).toArray();
      return docs.map((d) => fromDoc<ConsentEvent>(d, EVENT_DATES, undefined, ["prevHash"]));
    },

    async insertRequest(r) {
      await (await col("requests")).insertOne(requestDoc(r));
    },
    async getRequest(id) {
      const doc = await (await col("requests")).findOne({ _id: id });
      return doc ? fromDoc<RightsRequest>(doc, REQUEST_DATES, "id") : undefined;
    },
    async updateRequest(r) {
      await (await col("requests")).replaceOne({ _id: r.id }, requestDoc(r));
    },
    async listRequests(filter) {
      const docs = await (await col("requests"))
        .find(clean({ subjectId: filter.subjectId, status: filter.status }), { sort: { openedAt: 1, _id: 1 } })
        .toArray();
      return docs.map((d) => fromDoc<RightsRequest>(d, REQUEST_DATES, "id"));
    },

    async insertTasks(tasks) {
      if (tasks.length > 0) await (await col("tasks")).insertMany(tasks.map(taskDoc));
    },
    async dueTasks({ limit, now, staleBefore, maxAttempts }) {
      const docs = await (await col("tasks")).find(runnable(now, staleBefore, maxAttempts), { sort: { dueAt: 1, _id: 1 }, limit }).toArray();
      return docs.map((d) => fromDoc<ErasureTask>(d, TASK_DATES, "id"));
    },
    async claimTask({ id, now, staleBefore, maxAttempts }) {
      // One document's update is atomic, so only one runner sees modifiedCount 1.
      const result = await (await col("tasks")).updateOne(
        { _id: id, ...runnable(now, staleBefore, maxAttempts) },
        { $set: { status: "running", claimedAt: new Date(now) } },
      );
      return result.modifiedCount === 1;
    },
    async updateTask(t) {
      await (await col("tasks")).replaceOne({ _id: t.id }, taskDoc(t));
    },
    async getTask(id) {
      const doc = await (await col("tasks")).findOne({ _id: id });
      return doc ? fromDoc<ErasureTask>(doc, TASK_DATES, "id") : undefined;
    },
    async listTasks(filter) {
      const docs = await (await col("tasks")).find(clean({ subjectId: filter.subjectId, status: filter.status }), { sort: { dueAt: 1, _id: 1 } }).toArray();
      return docs.map((d) => fromDoc<ErasureTask>(d, TASK_DATES, "id"));
    },

    async insertAccess(entries) {
      if (entries.length === 0) return;
      await (await col("access")).insertMany(entries.map(({ id, ...e }) => clean({ _id: id, ...e, at: new Date(e.at) })));
    },
    async listAccess(f) {
      const at = clean({ $gte: toDate(f.from), $lt: toDate(f.to) });
      const filter = clean({ subjectId: f.subjectId, actor: f.actor, purpose: f.purpose, at: Object.keys(at).length ? at : undefined });
      const docs = await (await col("access")).find(filter, clean({ sort: { at: 1, _id: 1 }, limit: f.limit })).toArray();
      return docs.map((d) => fromDoc<AccessEntry>(d, ACCESS_DATES, "id"));
    },
    async pruneAccess(before) {
      return (await (await col("access")).deleteMany({ at: { $lt: new Date(before) } })).deletedCount;
    },
    async accessSubjects(f) {
      const at = clean({ $gte: toDate(f.from), $lt: toDate(f.to) });
      const filter = clean({ subjectId: f.subjectId, actor: f.actor, purpose: f.purpose, at: Object.keys(at).length ? at : undefined });
      const groups = await (await col("access")).aggregate([{ $match: filter }, { $group: { _id: "$subjectId" } }]).toArray();
      return groups.map((g) => String(g._id));
    },

    async insertBreach(b) {
      await (await col("breaches")).insertOne(breachDoc(b));
    },
    async getBreach(id) {
      const doc = await (await col("breaches")).findOne({ _id: id });
      return doc ? (doc.data as Breach) : undefined;
    },
    async updateBreach(b) {
      // Only if no one saved it since it was read: each change adds one history entry.
      const unchanged = { "data.history": { $size: b.history.length - 1 } };
      return (await (await col("breaches")).replaceOne({ _id: b.id, ...unchanged }, breachDoc(b))).matchedCount === 1;
    },
    async listBreaches(filter) {
      const docs = await (await col("breaches")).find(clean({ status: filter.status }), { sort: { awareAt: -1, _id: 1 } }).toArray();
      return docs.map((d) => d.data as Breach);
    },
    async addNotices(list) {
      const notices = await col("notices");
      let added = 0;
      for (let i = 0; i < list.length; i += BATCH) {
        const docs = list.slice(i, i + BATCH).map((n) => clean({ ...n, addedAt: new Date(n.addedAt), sentAt: toDate(n.sentAt) }));
        try {
          added += (await notices.insertMany(docs, { ordered: false })).insertedCount;
        } catch (err) {
          // People already on the breach fail the unique index; the rest are still inserted.
          const e = err as { insertedCount?: number; result?: { insertedCount?: number }; writeErrors?: Array<{ code?: number }> | { code?: number } };
          const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : e.writeErrors ? [e.writeErrors] : [];
          if (writeErrors.length === 0 || writeErrors.some((w) => w.code !== 11000)) throw err;
          added += e.insertedCount ?? e.result?.insertedCount ?? 0;
        }
      }
      return added;
    },
    async markNotices(breachId, subjectIds, sentAt, channel) {
      const notices = await col("notices");
      const update = channel === undefined ? { $set: { status: "sent", sentAt: new Date(sentAt) }, $unset: { channel: "" } } : { $set: { status: "sent", sentAt: new Date(sentAt), channel } };
      let changed = 0;
      for (let i = 0; i < subjectIds.length; i += BATCH) {
        const result = await notices.updateMany({ breachId, status: "pending", subjectId: { $in: subjectIds.slice(i, i + BATCH) } }, update);
        changed += result.modifiedCount;
      }
      return changed;
    },
    async listNotices(breachId, filter) {
      const docs = await (await col("notices"))
        .find(clean({ breachId, status: filter.status }), clean({ sort: { addedAt: 1, subjectId: 1 }, limit: filter.limit, projection: { _id: 0 } }))
        .toArray();
      return docs.map((d) => fromDoc<BreachNotice>(d, NOTICE_DATES));
    },
    async countNotices(breachId) {
      const [r] = await (await col("notices"))
        .aggregate([
          { $match: { breachId } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
              first: { $min: "$sentAt" },
              last: { $max: "$sentAt" },
            },
          },
        ])
        .toArray();
      return clean({ total: r?.total ?? 0, sent: r?.sent ?? 0, firstSentAt: toIso(r?.first), lastSentAt: toIso(r?.last) }) as NoticeCounts;
    },
  };
}

/** Builds the driver's ObjectId from a hex string: `mongodb`'s `ObjectId`, or `mongoose.Types.ObjectId`. */
export type ObjectIdClass = new (hex: string) => unknown;

export interface MongoDataOptions {
  /** From `mongooseSchema()`: lets the data map use model names (`User`) for collections (`users`). */
  schema?: Schema;
  /**
   * Pass `ObjectId` when subjects are found by an ObjectId field (`subject: "_id"`), so a 24-digit
   * hex subject id matches it. Ids that look like numbers also match number fields.
   */
  ObjectId?: ObjectIdClass;
  /** Full control over how a subject id is matched: return the value (or values) to look for. */
  subjectValues?: (subjectId: string, collection: string, field: string) => unknown[];
}

const HEX24 = /^[0-9a-f]{24}$/i;

/**
 * Data access for your own collections, for access summaries and erasure. Each data map entry's
 * `table` is a collection (or a Mongoose model name, with `schema`), its fields are document
 * fields (`"address.city"` reaches into nested documents), and `subject` is the field holding the
 * person's id. Erasure sets a field to its `erase` replacement, or removes it ($unset).
 */
export function mongoData(source: MongoDbSource, options: MongoDataOptions = {}): DataAccess {
  const collections = new Map<string, string>();
  const fields = new Map<string, Map<string, string>>();
  const arrays = new Map<string, Set<string>>();
  for (const t of options.schema?.tables ?? []) {
    const byKey = new Map(t.columns.filter((c) => c.key).map((c) => [c.key!, c.name]));
    const arrayPaths = new Set(t.columns.filter((c) => c.sqlType === "array").map((c) => c.name));
    for (const name of t.key ? [t.name, t.key] : [t.name]) {
      if (!collections.has(name)) collections.set(name, t.name);
      if (!fields.has(name)) fields.set(name, byKey);
      if (!arrays.has(name)) arrays.set(name, arrayPaths);
    }
  }
  /** The path to write: `addresses.$[].phone` when `addresses` is an array, so every element is erased. */
  const writePath = (table: string, path: string) => {
    const inArrays = arrays.get(table);
    if (!inArrays?.size) return path;
    const parts = path.split(".");
    return parts.map((part, i) => (i < parts.length - 1 && inArrays.has(parts.slice(0, i + 1).join(".")) ? `${part}.$[]` : part)).join(".");
  };
  const collection = (table: string) => resolveDb(source).collection(collections.get(table) ?? table);
  /** The stored field for a data map name: `_id` for `id`, with a Mongoose schema. */
  const field = (table: string, name: string) => fields.get(table)?.get(name) ?? name;
  const values = (subjectId: string, table: string, field: string): unknown[] => {
    if (options.subjectValues) return options.subjectValues(subjectId, collections.get(table) ?? table, field);
    const out: unknown[] = [subjectId];
    if (/^-?\d+$/.test(subjectId) && Number.isSafeInteger(Number(subjectId))) out.push(Number(subjectId));
    if (options.ObjectId && HEX24.test(subjectId)) out.push(new options.ObjectId(subjectId));
    return out;
  };
  const filter = (table: string, subject: string, subjectId: string) => {
    const stored = field(table, subject);
    return { [stored]: { $in: values(subjectId, table, stored) } };
  };

  return {
    async read(table, subjectColumn, subjectId, columns) {
      if (columns.length === 0) return [];
      const stored = columns.map((c) => field(table, c));
      const projection: Doc = Object.fromEntries(stored.map((c) => [c, 1]));
      if (!stored.includes("_id")) projection._id = 0;
      const docs = await collection(table).find(filter(table, subjectColumn, subjectId), { projection }).toArray();
      // Back under the data map's names.
      return docs.map((doc) => {
        const out: Doc = { ...doc };
        columns.forEach((c, i) => {
          const s = stored[i]!;
          if (s === c) return;
          out[c] = doc[s];
          if (!columns.includes(s)) delete out[s];
        });
        return out;
      });
    },
    async eraseFields(table, subjectColumn, subjectId, columns, replacements: Readonly<Record<string, ErasedValue>> = {}) {
      if (columns.length === 0) return 0;
      const $set: Doc = {};
      const $unset: Doc = {};
      for (const c of columns) {
        const path = writePath(table, field(table, c));
        if (Object.hasOwn(replacements, c) && replacements[c] !== null) $set[path] = replacements[c];
        else $unset[path] = "";
      }
      const result = await collection(table).updateMany(filter(table, subjectColumn, subjectId), clean({ $set: Object.keys($set).length ? $set : undefined, $unset: Object.keys($unset).length ? $unset : undefined }));
      return result.matchedCount;
    },
    async deleteRows(table, subjectColumn, subjectId) {
      return (await collection(table).deleteMany(filter(table, subjectColumn, subjectId))).deletedCount;
    },
  };
}

interface MongooseSchemaTypeLike {
  instance?: string;
  isRequired?: boolean;
  /** Subdocuments (`home: addressSchema`) and arrays of them (`addresses: [addressSchema]`). */
  schema?: { paths: Record<string, MongooseSchemaTypeLike> };
}
interface MongooseModelLike {
  modelName: string;
  collection: { collectionName: string };
  schema: { paths: Record<string, MongooseSchemaTypeLike>; virtuals?: Record<string, unknown> };
}

const isModel = (v: unknown): v is MongooseModelLike => {
  const m = v as Partial<MongooseModelLike> | null;
  return (
    (typeof v === "function" || typeof v === "object") &&
    m !== null &&
    typeof m?.modelName === "string" &&
    typeof m.collection?.collectionName === "string" &&
    typeof m.schema?.paths === "object"
  );
};

const MONGOOSE_TYPES: Record<string, SchemaColumn["type"]> = { String: "string", Number: "number", Boolean: "boolean" };

/**
 * Read Mongoose models into the neutral shape `dpdp-kit audit --schema` and `mongoData()` use.
 * Pass the Mongoose instance, `mongoose.models`, an array of models, or a module that exports
 * them. Each model becomes a table named after its collection, with the model name as its `key`;
 * each schema path becomes a column, including fields in nested objects and subdocuments
 * (`address.city`, `addresses.phone`), and `_id` has the key `id`. `__v` is skipped.
 */
export function mongooseSchema(source: unknown): Schema {
  const found = new Map<string, MongooseModelLike>();
  const visit = (v: unknown, depth: number) => {
    if (isModel(v)) {
      if (!found.has(v.collection.collectionName)) found.set(v.collection.collectionName, v);
      return;
    }
    if (depth > 1 || v === null || typeof v !== "object") return;
    const models = (v as { models?: unknown }).models; // the Mongoose instance
    if (models && typeof models === "object" && depth === 0) visit(models, depth + 1);
    for (const value of Array.isArray(v) ? v : Object.values(v)) visit(value, depth + 1);
  };
  visit(source, 0);

  const tables: SchemaTable[] = [];
  for (const model of found.values()) {
    const columns: SchemaColumn[] = [];
    const addPaths = (paths: Record<string, MongooseSchemaTypeLike>, prefix: string) => {
      for (const [path, type] of Object.entries(paths)) {
        if (path === "__v" || (prefix && path === "_id")) continue; // a subdocument's own _id isn't data
        const name = `${prefix}${path}`;
        // Mongoose apps refer to `_id` as `id` (its virtual), so the data map may use either.
        const key = name === "_id" && model.schema.virtuals?.id ? { key: "id" } : {};
        const array = type.instance === "Array" ? { sqlType: "array" } : {};
        columns.push({ name, ...key, notNull: name === "_id" || type.isRequired === true, type: MONGOOSE_TYPES[type.instance ?? ""] ?? "other", ...array });
        if (type.schema?.paths) addPaths(type.schema.paths, `${name}.`); // fields inside subdocuments
      }
    };
    addPaths(model.schema.paths, "");
    const name = model.collection.collectionName;
    tables.push({ name, ...(model.modelName === name ? {} : { key: model.modelName }), columns });
  }
  return { tables };
}
