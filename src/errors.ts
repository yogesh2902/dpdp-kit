import type { Issue } from "./audit.js";

export type DpdpErrorCode =
  | "invalid-config"
  | "invalid-subject"
  | "unknown-purpose"
  | "not-a-consent-purpose"
  | "no-purposes"
  | "invalid-language"
  | "write-conflict";

/** Thrown for mistakes in how the library is called. Messages are for developers, not end users. */
export class DpdpError extends Error {
  override readonly name = "DpdpError";
  constructor(
    readonly code: DpdpErrorCode,
    message: string,
    readonly issues?: readonly Issue[],
  ) {
    super(message);
  }
}

/**
 * A store throws this when an event with the same (subjectId, seq) already exists. The ledger
 * catches it and retries, so two writes for the same person never fork the chain.
 */
export class SeqConflictError extends Error {
  override readonly name = "SeqConflictError";
  constructor(
    readonly subjectId: string,
    readonly seq: number,
  ) {
    super(`A consent event for this subject with seq ${seq} already exists`);
  }
}
