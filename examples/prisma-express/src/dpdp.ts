import { readFileSync } from "node:fs";
import { createDpdp } from "dpdp-kit";
import { prismaData, prismaSchema, prismaStore } from "dpdp-kit/prisma";
import config from "../dpdp.config.js";
import { prisma } from "./db.js";

// The schema lets the data map use model and field names, and casts values to each column's type.
const schema = prismaSchema(readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8"));

/** What the SMS vendor was asked to do. A real app calls MSG91's API here. */
export const processorCalls: string[] = [];

/** DEMO_CLOCK=1 lets the journey script move time forward; leave it off in production. */
let offsetMs = 0;
export const advanceClock = (ms: number) => {
  offsetMs += ms;
};

export const dpdp = createDpdp({
  config,
  store: prismaStore(prisma), // consent, rights requests, erasure tasks, access log, breaches
  data: prismaData(prisma, { schema }), // reads and erases personal data in your own tables
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
  ...(process.env.DEMO_CLOCK === "1" ? { now: () => new Date(Date.now() + offsetMs) } : {}),
});
