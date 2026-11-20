---
title: React
description: Hooks for a consent screen and a privacy centre in React and Next.js, on top of the HTTP API.
---

> New in 0.6.

`dpdp-kit/react` gives React and Next.js apps hooks for everything a consent screen and a privacy centre show: the notice, consents and objections, the person's data, rights requests and nominees. They call the [HTTP API](../http/) through the [client](../client/), so mount the API on your server first.

```bash
npm i dpdp-kit react
```

## Set up

Wrap the screens in `DpdpProvider`, pointing at where you mounted the API:

```tsx
import { DpdpProvider } from "dpdp-kit/react";

export default function PrivacyLayout({ children }) {
  return <DpdpProvider options={{ base: "/api/privacy" }}>{children}</DpdpProvider>;
}
```

It works in the Next.js App Router: `dpdp-kit/react` is marked `"use client"`, and renders a loading state on the server without calling the API. For an API on another origin or a mobile app, pass `options={{ base: "https://api.example.in/privacy", headers: () => ({ authorization: \`Bearer ${token}\` }) }}`, or a `client` from `createClient()`.

## Consents

```tsx
import { useConsents } from "dpdp-kit/react";

function ConsentSettings() {
  const { purposes, set, saving, error, loading } = useConsents<"offers" | "analytics">();
  if (loading) return <p>Loading…</p>;
  return (
    <ul>
      {purposes
        .filter((p) => p.basis === "consent" || p.legitimateUse === "7(a)")
        .map((p) => (
          <li key={p.purpose}>
            <label>
              <input type="checkbox" checked={p.active} disabled={saving.has(p.purpose)} onChange={(e) => set(p.purpose, e.target.checked)} />
              {p.description ?? p.purpose}
            </label>
          </li>
        ))}
      {error && <li role="alert">Couldn't save that. Please try again.</li>}
    </ul>
  );
}
```

`set(purpose, on)` does the right thing for the purpose: grant or withdraw a consent purpose, record or lift an objection to a Section 7(a) use. Other legitimate uses can't be switched off. A change shows at once and is undone if the server refuses it; `error` says why, and the promise rejects. `grant`, `withdraw`, `object` and `liftObjection` take several purposes at once, e.g. "Accept selected" on a consent screen.

## Every hook

| Hook | Gives | Reloads when |
|---|---|---|
| `useNotice({ language, kind })` | The privacy notice (Rule 3), saved as proof when shown | `language` or `kind` changes |
| `useNoticeLanguages()` | Languages for a picker | |
| `useConsents()` | Purposes with `active`, `set`, `grant`, `withdraw`, `object`, `liftObjection`, `saving` | |
| `useMyData()` | What you hold and who it's shared with (Section 11) | Consents change |
| `useRequests()` | The person's requests, and `open(type, details)` | A request is opened, a nominee added |
| `useNominees()` | Nominees, `nominate`, `revoke` (Section 14) | |
| `useRights()` | How to make a request and answer times (Rule 14(1)) | |
| `useDpdpClient()` | The client itself, for anything else | |

Each returns `data`, `loading`, `error` and `reload()`. A late answer never replaces a newer one, so switching languages quickly shows the last one picked.

> Ready-made components (`<ConsentNotice>`, `<PrivacyCentre>`) with an optional stylesheet build on these hooks; React Native gets the same.
