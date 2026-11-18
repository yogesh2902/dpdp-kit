---
title: Events
description: Listen for consent, erasure, rights and access changes to feed your own audit trail, alerts or analytics.
---

```ts
const off = dpdp.on("consent.withdrawn", ({ event, erasure }) => {
  analytics.forget(event.subjectId, event.purposes);
});

off(); // stop listening
```

## The events

| Event | Fires when | Carries |
|---|---|---|
| `consent.granted` | `consent.grant()` saved | `{ event }` |
| `consent.withdrawn` | `consent.withdraw()` saved | `{ event, erasure, tasks }` |
| `erasure.scheduled` | erasure tasks were saved, from a withdrawal, an account deletion or an erasure request | `{ plan, tasks }` |
| `retention.ran` | `retention.run()` finished | `{ report }` |
| `rights.opened` | `rights.open()` saved | `{ request }` |
| `rights.closed` | a request was resolved or rejected | `{ request }` |
| `access.logged` | `access.log()` saved, including a refused out-of-purpose read | `{ entries }` |

Listeners are typed: the payload matches the event name.

## How listeners run

- **After the change is saved.** An event never fires for something that failed to save.
- **After the call returns.** Listeners run on the next turn of the event loop, so a slow webhook doesn't delay `grant()` or `withdraw()`.
- **They can't break anything.** If a listener throws or rejects, the call that fired it has already succeeded. The error goes to `onListenerError`, which defaults to `console.error`:

```ts
const dpdp = createDpdp({
  config,
  store,
  onListenerError: (error, event) => logger.warn({ error, event }, "dpdp listener failed"),
});
```

Listeners live in memory, in the process that made the change. For something that must happen exactly once, such as telling a vendor to erase, use [processor hooks](../erasure/#processor-hooks) and the retention runner, which retry and record the result.

## Ideas

- Send a Slack alert when `access.logged` has `outOfPurpose` entries.
- Mirror `consent.granted` and `consent.withdrawn` to your analytics tool's consent API.
- Email the person when `rights.opened` fires, acknowledging their request.
- Page someone when `retention.ran` reports failed tasks.
