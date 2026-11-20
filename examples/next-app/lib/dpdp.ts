import { createDpdp, type Dpdp } from "dpdp-kit";
import { sqliteData, sqliteStore } from "dpdp-kit/sqlite";
import config from "../dpdp.config";
import { query } from "./db";

type Purpose = keyof typeof config.purposes;

// One instance per process, however often Next.js loads this module.
const g = globalThis as unknown as { chai?: { dpdp: Dpdp<Purpose>; processorCalls: string[]; offset: { ms: number } } };

function make() {
  /** What the SMS vendor was asked to do. A real app calls MSG91's API here. */
  const processorCalls: string[] = [];
  /** DEMO_CLOCK=1 lets the journey script move time forward; leave it off in production. */
  const offset = { ms: 0 };
  const dpdp = createDpdp({
    config,
    store: sqliteStore(query), // consent, rights requests, erasure tasks, access log, breaches, notices
    data: sqliteData(query), // reads, corrects and erases personal data in the shop's own tables
    processors: {
      msg91: {
        stop: async ({ subjectId, purposes }) => {
          processorCalls.push(`stop:msg91:${subjectId}:${purposes.join(",")}`);
        },
        erase: async ({ subjectId, purposes }) => {
          processorCalls.push(`erase:msg91:${subjectId}:${purposes.join(",")}`);
        },
      },
    },
    ...(process.env.DEMO_CLOCK === "1" ? { now: () => new Date(Date.now() + offset.ms) } : {}),
  });
  return { dpdp, processorCalls, offset };
}

export const { dpdp, processorCalls, offset } = (g.chai ??= make());
