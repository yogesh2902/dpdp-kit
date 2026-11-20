---
title: Client
description: A typed client for the HTTP API, for browsers, React Native and other servers, with nothing from Node.js in your bundle.
---

> New in 0.6.

`dpdp-kit/client` calls the [HTTP API](../http/) for you: one typed method per route, errors as `DpdpClientError`. It imports types only, so a frontend bundle gets a few kilobytes and nothing from Node.js. The React and React Native components in 0.6 are built on it.

```ts
import { createClient, DpdpClientError } from "dpdp-kit/client";

const privacy = createClient<"marketing_sms" | "analytics">({ base: "/privacy" });

const notice = await privacy.notice({ language: "hi" });     // shown and saved as proof
await privacy.grant(["marketing_sms"], { language: "hi" });  // records that notice's version
const { purposes } = await privacy.consents();               // every purpose, active or not

try {
  await privacy.withdraw(["marketing_sms"]);
} catch (err) {
  if (err instanceof DpdpClientError) console.log(err.status, err.code); // e.g. 401 "unauthenticated"
}
```

The type parameter is your purposes, so a misspelt purpose is a type error, as on the server.

## Options

| Option | |
|---|---|
| `base` | Where the API is mounted. Default `"/privacy"` on the same site; a full URL such as `"https://api.example.in/privacy"` for another origin or React Native |
| `headers` | Sent with every request, or a function called each time: `() => ({ authorization: \`Bearer ${token}\` })` for a mobile app |
| `credentials` | `"include"` to send cookies to an API on another origin (set up CORS for that origin only) |
| `fetch` | A `fetch` to use instead of the global one, e.g. in tests |

## Methods

| Method | Route |
|---|---|
| `notice({ language, kind })` | `GET /notice` |
| `languages()` | `GET /notice/languages` |
| `rights()` | `GET /rights` |
| `consents()` | `GET /consents` |
| `grant(purposes, { language })`, `withdraw(purposes)` | `POST /consents`, `POST /consents/withdraw` |
| `object(purposes)`, `liftObjection(purposes)` | `POST /objections`, `DELETE /objections` |
| `data()` | `GET /data` |
| `requests()`, `request(id)`, `openRequest(type, details)` | `GET /requests`, `GET /requests/:id`, `POST /requests` |
| `nominees()`, `nominate(nominee)`, `revokeNominee(id)` | `/nominees` |
| `admin.requests(filter)`, `admin.request(id)`, `admin.data(id)` | `GET /admin/requests…` |
| `admin.verify`, `admin.correct`, `admin.erase`, `admin.resolve`, `admin.reject` | `POST /admin/requests/:id/…` |

The response types (`ConsentsResponse`, `PersonRequest`, `OpenRequestResponse`…) are exported from `dpdp-kit/client` and from `dpdp-kit`, and the server is checked against them, so the two can't drift apart.
