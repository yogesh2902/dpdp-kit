import { createDpdp } from "dpdp-kit";
import { mongoData, mongooseSchema, mongoStore } from "dpdp-kit/mongodb";
import mongoose from "mongoose";
import config from "../dpdp.config.js";
import "./models.js";

/** What the SMS vendor was asked to do. A real app calls MSG91's API here. */
export const processorCalls: string[] = [];

/** DEMO_CLOCK=1 lets the journey script move time forward; leave it off in production. */
let offsetMs = 0;
export const advanceClock = (ms: number) => {
  offsetMs += ms;
};

// A function, so dpdp can be created before mongoose.connect() has finished.
const db = () => mongoose.connection.db;

export const dpdp = createDpdp({
  config,
  store: mongoStore(db), // consent, rights requests, erasure tasks, access log, breaches
  // The models let the data map use model names (User) and `id`; ObjectId matches _id.
  data: mongoData(db, { schema: mongooseSchema(mongoose), ObjectId: mongoose.Types.ObjectId }),
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
