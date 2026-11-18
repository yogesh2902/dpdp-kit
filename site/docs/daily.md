---
title: Daily upkeep
description: One call for the jobs the law needs done on time, and four ways to schedule it.
---

Erasure is due on dates, access logs must be kept a year and then pruned, and someone should look at yesterday's access. `daily()` does all of it:

```ts
const report = await dpdp.daily();
// {
//   retention: { done, failed, manual },   // erasure tasks carried out (Section 8(7), Rule 8(3))
//   accessPruned: 1240,                     // access log entries past a year (Rule 6(1)(e))
//   review: { findings: [...] },            // yesterday's access, reviewed (Rule 6(1)(c))
//   overdueRequests: [...],                 // rights requests past their due date (Rule 14)
//   skipped: [],
// }
```

Each step runs even if another fails: failures are listed in `report.errors` (with the step and message), so a missing table or a timeout in one part never stops erasure.

It's safe to run from several servers at once: erasure tasks are claimed atomically, and pruning is idempotent. A part your store can't do (a custom store without the access log, say) is listed in `skipped`. It also fires the `daily.ran` [event](../events/).

Pass review options through:

```ts
await dpdp.daily({ review: { maxSubjects: 200, ignoreActors: ["job:crm-sync"] } });
```

## Schedule it

### In-process, no dependencies

```ts
import { startDaily } from "dpdp-kit/schedule";

const schedule = startDaily(dpdp, {
  at: "03:00", // local time
  onReport: (report) => {
    if (report.retention?.failed.length || report.review?.findings.length) alert(report);
  },
});
// schedule.runNow(), schedule.nextRunAt(), schedule.stop()
```

Runs never overlap, a failed run or step is reported to `onError` (default `console.error`) and the next day's still happens, each access review starts where the last successful one ended (up to a week back), and the timer doesn't keep the process alive on its own. Each server that calls it runs the job; that's safe, but you get one report per server.

### node-cron

```ts
import cron from "node-cron";
cron.schedule("0 3 * * *", () => dpdp.daily().then(handleReport), { timezone: "Asia/Kolkata" });
```

### BullMQ (runs once across all your servers)

```ts
import { Queue, Worker } from "bullmq";

await new Queue("dpdp", { connection }).upsertJobScheduler("daily", { pattern: "0 3 * * *", tz: "Asia/Kolkata" });
new Worker("dpdp", async () => dpdp.daily(), { connection });
```

### Serverless cron (Vercel, Cloudflare, GitHub Actions)

Expose a protected route and point your platform's cron at it:

```ts
app.post("/internal/dpdp-daily", requireCronSecret, async (req, res) => res.json(await dpdp.daily()));
```
