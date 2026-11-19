// dpdp-kit's tables as plain SQL, with no dependencies, for any Postgres client.
// `dpdp-kit/drizzle` defines the same tables for drizzle-kit, and `PRISMA_MODELS` for Prisma.

/** The same table as plain SQL, if you don't use drizzle-kit for migrations. */
export const CONSENT_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS dpdp_consent_events (
  subject_id text NOT NULL,
  seq integer NOT NULL,
  action text NOT NULL CONSTRAINT dpdp_consent_events_action_check CHECK (action IN ('grant', 'withdraw', 'object', 'lift-objection')),
  purposes jsonb NOT NULL,
  notice_version text,
  language text,
  channel text,
  evidence jsonb,
  at timestamptz NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  PRIMARY KEY (subject_id, seq)
);`;

/** Rights requests and erasure tasks as plain SQL, if you don't use drizzle-kit for migrations. */
export const RECORDS_DDL = `CREATE TABLE IF NOT EXISTS dpdp_requests (
  id text PRIMARY KEY,
  subject_id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  closed_at timestamptz,
  details jsonb,
  history jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS dpdp_requests_subject_idx ON dpdp_requests (subject_id);
CREATE INDEX IF NOT EXISTS dpdp_requests_status_due_idx ON dpdp_requests (status, due_at);
CREATE TABLE IF NOT EXISTS dpdp_erasure_tasks (
  id text PRIMARY KEY,
  subject_id text NOT NULL,
  reason text NOT NULL,
  kind text NOT NULL,
  table_key text,
  fields jsonb,
  processor text,
  purposes jsonb,
  created_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  claimed_at timestamptz,
  done_at timestamptz,
  affected integer,
  last_error text,
  note text
);
CREATE INDEX IF NOT EXISTS dpdp_erasure_tasks_subject_idx ON dpdp_erasure_tasks (subject_id);
CREATE INDEX IF NOT EXISTS dpdp_erasure_tasks_status_due_idx ON dpdp_erasure_tasks (status, due_at);`;

/** The access log as plain SQL, if you don't use drizzle-kit for migrations. */
export const ACCESS_LOG_DDL = `CREATE TABLE IF NOT EXISTS dpdp_access_log (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  subject_id text NOT NULL,
  action text NOT NULL,
  purpose text NOT NULL,
  fields jsonb,
  out_of_purpose jsonb,
  reason text,
  evidence jsonb
);
CREATE INDEX IF NOT EXISTS dpdp_access_log_at_idx ON dpdp_access_log (at);
CREATE INDEX IF NOT EXISTS dpdp_access_log_subject_idx ON dpdp_access_log (subject_id, at);
CREATE INDEX IF NOT EXISTS dpdp_access_log_actor_idx ON dpdp_access_log (actor, at);`;

/** The breach tables as plain SQL, if you don't use drizzle-kit for migrations. */
export const BREACH_DDL = `CREATE TABLE IF NOT EXISTS dpdp_breaches (
  id text PRIMARY KEY,
  status text NOT NULL,
  aware_at timestamptz NOT NULL,
  report_due_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS dpdp_breaches_status_idx ON dpdp_breaches (status, aware_at);
CREATE TABLE IF NOT EXISTS dpdp_breach_notices (
  breach_id text NOT NULL,
  subject_id text NOT NULL,
  status text NOT NULL,
  added_at timestamptz NOT NULL,
  sent_at timestamptz,
  channel text,
  PRIMARY KEY (breach_id, subject_id)
);
CREATE INDEX IF NOT EXISTS dpdp_breach_notices_status_idx ON dpdp_breach_notices (breach_id, status, added_at);`;

/** Privacy notices as shown, kept as proof (Section 6(10)), as plain SQL. */
export const PRIVACY_NOTICES_DDL = `CREATE TABLE IF NOT EXISTS dpdp_privacy_notices (
  version text NOT NULL,
  language text NOT NULL,
  kind text NOT NULL,
  content jsonb NOT NULL,
  first_shown_at timestamptz NOT NULL,
  PRIMARY KEY (version, language, kind)
);`;

/** Every dpdp-kit table as plain SQL. */
export const DPDP_DDL = `${CONSENT_EVENTS_DDL}\n${RECORDS_DDL}\n${ACCESS_LOG_DDL}\n${BREACH_DDL}\n${PRIVACY_NOTICES_DDL}`;

/**
 * Upgrades tables created by an earlier version to 0.5: consent events may now record objections
 * (`object`, `lift-objection`), and `dpdp_privacy_notices` keeps notice snapshots. Safe to run more than once, and on tables created by drizzle-kit
 * or Prisma, which have no such constraint. The constraint is added NOT VALID and then validated.
 * Sent as one query, all of it is one transaction, which locks `dpdp_consent_events` until the
 * existing rows are checked: fine for most tables. For a very large one, send the statements one
 * at a time (split on `;\n`), so writes only wait for the short `ADD CONSTRAINT`.
 */
export const MIGRATE_0_5_DDL = `ALTER TABLE dpdp_consent_events DROP CONSTRAINT IF EXISTS dpdp_consent_events_action_check;
ALTER TABLE dpdp_consent_events ADD CONSTRAINT dpdp_consent_events_action_check CHECK (action IN ('grant', 'withdraw', 'object', 'lift-objection')) NOT VALID;
ALTER TABLE dpdp_consent_events VALIDATE CONSTRAINT dpdp_consent_events_action_check;
${PRIVACY_NOTICES_DDL}`;
