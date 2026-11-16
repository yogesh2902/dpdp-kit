export { audit, hasErrors, type Issue, type IssueLevel } from "./audit.js";
export {
  type Basis,
  type Category,
  type DpdpConfig,
  defineConfig,
  type FiduciaryDef,
  type LegalHold,
  type PersonalField,
  type ProcessorDef,
  type PurposeDef,
  type PurposeOf,
  purposeNames,
  type Retention,
  type TableDef,
} from "./config.js";
export {
  type ConsentMeta,
  createDpdp,
  type Dpdp,
  type DpdpOptions,
  hashEvent,
  type VerifyResult,
} from "./dpdp.js";
export { type Duration, durationMs, isDuration } from "./duration.js";
export {
  type ErasurePlan,
  type ErasureReason,
  type FieldPlan,
  type PlanInput,
  type ProcessorPlan,
  planErasure,
  type TablePlan,
} from "./erasure.js";
export { DpdpError, type DpdpErrorCode, SeqConflictError } from "./errors.js";
export { CONSENT_REQUIRED_BODY, type GuardOptions } from "./guard.js";
export { isNoticeLanguage, NOTICE_LANGUAGES, type NoticeLanguage } from "./languages.js";
export { type Confidence, guessPersonal, type PersonalGuess, tokenize } from "./personal.js";
export { checkSchema, type Schema, type SchemaColumn, type SchemaTable } from "./schema-check.js";
export { type ConsentAction, type ConsentEvent, type ConsentStore, memoryStore } from "./store.js";
