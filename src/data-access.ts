import type { ErasedValue } from "./config.js";

/**
 * How dpdp-kit reaches the personal data in your own tables: to show a person what you hold
 * (Section 11) and to carry out erasure (Section 8(7)). Names are as written in the data map
 * (`config.data[...].table`, `subject` and field names); an implementation maps them to columns.
 */
export interface DataAccess {
  /** The person's rows, with only the listed columns. */
  read(table: string, subjectColumn: string, subjectId: string, columns: readonly string[]): Promise<Record<string, unknown>[]>;
  /**
   * Erase the listed columns in the person's rows: set each to its value in `values`, or to null
   * when it has none (the field's `erase` setting in the config). Returns rows changed.
   */
  eraseFields(
    table: string,
    subjectColumn: string,
    subjectId: string,
    columns: readonly string[],
    values?: Readonly<Record<string, ErasedValue>>,
  ): Promise<number>;
  /** Delete the person's rows. Returns rows deleted. */
  deleteRows(table: string, subjectColumn: string, subjectId: string): Promise<number>;
  /**
   * Write new values to the person's rows, for corrections (Section 12(2)). `where` narrows it to
   * some rows, e.g. `{ id: 42 }` for one address of several. Returns rows changed. Optional:
   * without it, `rights.correct()` isn't available. The built-in data access all have it.
   */
  updateFields?(
    table: string,
    subjectColumn: string,
    subjectId: string,
    values: Readonly<Record<string, unknown>>,
    where?: Readonly<Record<string, unknown>>,
  ): Promise<number>;
}

/** A value written to a database column: objects and arrays as JSON text. */
export const columnValue = (v: unknown) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);

type Row = Record<string, unknown>;

/** Data access over plain arrays, for tests and examples. */
export function memoryData(tables: Record<string, Row[]>): DataAccess & { readonly tables: Record<string, Row[]> } {
  const rowsOf = (table: string) => (tables[table] ??= []);
  const mine = (subjectColumn: string, subjectId: string) => (row: Row) => String(row[subjectColumn]) === subjectId;
  return {
    tables,
    async read(table, subjectColumn, subjectId, columns) {
      return rowsOf(table)
        .filter(mine(subjectColumn, subjectId))
        .map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
    },
    async eraseFields(table, subjectColumn, subjectId, columns, values = {}) {
      const rows = rowsOf(table).filter(mine(subjectColumn, subjectId));
      for (const row of rows) for (const c of columns) row[c] = Object.hasOwn(values, c) ? values[c] : null;
      return rows.length;
    },
    async updateFields(table, subjectColumn, subjectId, values, where = {}) {
      const rows = rowsOf(table).filter(
        (row) => mine(subjectColumn, subjectId)(row) && Object.entries(where).every(([k, v]) => String(row[k]) === String(v)),
      );
      for (const row of rows) Object.assign(row, structuredClone(values));
      return rows.length;
    },
    async deleteRows(table, subjectColumn, subjectId) {
      const before = rowsOf(table).length;
      tables[table] = rowsOf(table).filter((row) => !mine(subjectColumn, subjectId)(row));
      return before - tables[table]!.length;
    },
  };
}
