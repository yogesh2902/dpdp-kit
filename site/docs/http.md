---
title: HTTP API
description: Mount the routes a privacy centre needs, in Express, Hono or Next.js, and call them from any frontend.
---

> New in 0.5.

Every app needs the same routes: show the notice, record consent, withdraw it, object, show people their data, take requests. dpdp-kit serves them for you. React, Next.js, React Native and plain JavaScript frontends call them with `fetch`.

## Mount it

**Express**

```ts
import { dpdpRouter } from "dpdp-kit/express";

app.use("/privacy", dpdpRouter(dpdp, {
  subject: (req) => req.user?.id,   // who is signed in, from your own auth
  admin: (req) => req.staff?.id,    // optional: turns on /privacy/admin for your privacy team
}));
```

It works with or without `express.json()` in front of it. Paths it doesn't serve go on to your next handler untouched: the body isn't read and no sign-in is checked, so your own routes under `/privacy` keep working.

**Hono**

```ts
import { dpdpRoutes } from "dpdp-kit/hono";

app.all("/privacy/*", dpdpRoutes(dpdp, { base: "/privacy", subject: (c) => c.get("userId") }));
```

**Next.js** (App Router), in `app/api/privacy/[...path]/route.ts`:

```ts
import { createHandlers } from "dpdp-kit/next";

export const { GET, POST, DELETE } = createHandlers(dpdp, {
  base: "/api/privacy",
  subject: async () => (await auth())?.user?.id,
});
```

`dpdp-kit/next` only uses Web `Request` and `Response`, so it also works in Bun, Deno and Cloudflare Workers. It doesn't import Next.js.

## Routes

For the signed-in person (401 without one):

| Route | Does |
|---|---|
| `GET /consents` | Their consents and objections, and every purpose with `active: true/false` |
| `POST /consents` | `{ purposes, language? }`: grant. Records the [notice](../notices/) version, channel, IP and user agent |
| `POST /consents/withdraw` | `{ purposes }`: withdraw, and schedule the erasure |
| `POST /objections` | `{ purposes }`: object to a Section 7(a) use ([Objections](../objections/)) |
| `DELETE /objections?purposes=a,b` | Lift an objection |
| `GET /data` | What you hold about them, and who it's shared with (Section 11) |
| `GET /requests`, `GET /requests/:id` | Their rights requests |
| `POST /requests` | `{ type, details? }`: open a request; answers with the request and an acknowledgement |
| `GET /nominees`, `POST /nominees`, `DELETE /nominees/:id` | Nominees (Section 14) |

For anyone, signed in or not:

| Route | Does |
|---|---|
| `GET /notice?language=hi&kind=consent` | The privacy notice, saved as proof the first time it's shown |
| `GET /rights` | How to make a request, identifiers and answer times (Rule 14(1)) |

For your privacy team, when you pass `admin` (403 for anyone it doesn't return an id for):

| Route | Does |
|---|---|
| `GET /admin/requests?status=open&overdue=true&subjectId=…` | The request inbox |
| `GET /admin/requests/:id`, `GET /admin/requests/:id/data` | One request, and the data summary that answers it |
| `POST /admin/requests/:id/verify` | `{ method }`: record the identity check |
| `POST /admin/requests/:id/correct` | `{ changes, where? }`: apply a correction |
| `POST /admin/requests/:id/erase` | `{ keepFor? }`: schedule the erasure |
| `POST /admin/requests/:id/resolve`, `/reject` | `{ note }` or `{ reason }` |

The staff id is recorded as `by` in each request's history. The person sees their requests without it.

## Calling it from a frontend

```ts
const res = await fetch("/privacy/consents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ purposes: ["marketing_sms"] }),
});
if (!res.ok) console.error((await res.json()).error); // e.g. "not-a-consent-purpose"
```

Errors answer `{ "error": "<code>" }` with a status: 400 for invalid input, 401 not signed in, 403 not allowed, 404 not found, 409 conflicts, 413 body too large, 415 not JSON, 429 limited. Codes are the same as `DpdpError` codes. No messages are sent, so nothing internal leaks; unexpected errors answer 500 `{ "error": "internal" }` and go to `onError` (default `console.error`).

## Safety

- **The person comes only from `subject`**, your own authentication. A `subjectId` in the body or the URL is ignored, and requests by id answer 404 unless they're the person's own.
- **POST must be JSON** (`Content-Type: application/json`, else 415). A form on another site can't send that without a CORS preflight, which blocks cross-site form attacks on consent. Don't open CORS to origins you don't trust.
- **Bodies are limited** to 16 KiB (`bodyLimit`).
- **`limitWrites(subjectId)`**: return `false` to refuse a change with 429, for example to stop a script filling someone's consent record. Use your own rate limiter.
- **The IP** recorded with consent comes from your framework: Express's `req.ip` (set `trust proxy` behind a load balancer), or `ip: (c) => …` for Hono and Next.js.
- Responses are sent with `Cache-Control: no-store`.

## Options

| Option | |
|---|---|
| `subject(req)` | Required. The signed-in person's id, or `undefined` |
| `admin(req)` | The signed-in staff member's id. Without it, `/admin` doesn't exist |
| `limitWrites(subjectId)` | Return `false` to refuse a change |
| `channel` | Recorded on consent events. Default `"web"`; use `"android"`, `"ios"`… per app |
| `bodyLimit` | Bytes. Default 16 KiB |
| `onError(err)` | For unexpected errors |
| `base` | Hono and Next.js: where the API is mounted |
| `ip(req)` | Hono and Next.js: the client's address |

Without a framework, call `handle(dpdp, { method, path, body, contentType, subjectId })` from `dpdp-kit` and send back its `{ status, body }`.

> A ready-made consent screen and privacy centre for React is planned for 0.6, on top of these routes.
