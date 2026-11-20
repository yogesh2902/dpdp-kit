---
title: React
description: A consent screen and a privacy centre for React and Next.js, ready-made or built from hooks, on top of the HTTP API.
---

> New in 0.6.

`dpdp-kit/react` gives React and Next.js apps a ready-made consent screen and privacy centre, and the hooks they're built from: the notice, consents and objections, the person's data, rights requests and nominees. They call the [HTTP API](../http/) through the [client](../client/), so mount the API on your server first.

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

## Ready-made screens

```tsx
import { ConsentNotice, DpdpProvider, PrivacyCentre } from "dpdp-kit/react";
import "dpdp-kit/react/styles.css"; // optional: the default look

// At sign-up
<ConsentNotice language="hi" onDone={({ granted }) => router.push("/welcome")} />

// In settings
<PrivacyCentre />
```

**`<ConsentNotice>`** is the consent request with the notice (Section 5, Rule 3, Section 6):

- It shows the notice's own text, the one the server saves as proof, in the person's language, with a language picker when you have translations.
- Each purpose has a switch, and **every switch starts off**. Consent must be a clear affirmative action.
- "Accept selected" and "Reject all" look the same, so neither is pushed. The server records the grant with the notice's version; "Reject all" records nothing.
- `kind="existing-users"` shows the notice for people whose data you held before asking, with a "Continue" button.

**`<PrivacyCentre>`** has five parts, each also exported on its own:

| Part | Shows |
|---|---|
| `<ConsentSettings>` | A switch per consent purpose and Section 7(a) use; withdrawing is as easy as granting (Section 6(4)). Each consent purpose is shown in the notice's words with its data, and the full notice opens beside the choices, so consent given here is accompanied by the notice (Section 5(1)) and recorded against that version and language. Turning off a 7(a) use asks for confirmation first. Other legitimate uses are listed as always on |
| `<MyData>` | What you hold, using your fields' `label`s, who it's shared with and where, and a download as JSON (Section 11) |
| `<Requests>` | A form for access, correction, erasure or a complaint, the acknowledgement once sent, and the list with due dates |
| `<Nominees>` | Add and remove nominees (Section 14) |
| `<HowToReachUs>` | How to make a request, identifiers and answer times (Rule 14(1)) |

`<PrivacyCentre sections={["consents", "requests"]} />` shows some of them, and `language="hi"` starts the choices and their notice in Hindi.

### Your own words

Every piece of text outside the notice is in `labels`, English by default. The notice itself comes from the server in the person's language.

```tsx
<PrivacyCentre labels={{ consentsHeading: "आपकी पसंद", saved: "सहेजा गया।", locale: "hi-IN" }} />
```

### Styling

Without the stylesheet, the components are plain semantic HTML with stable class names (`dpdp-notice`, `dpdp-purpose`, `dpdp-switch`…) and `data-state="on" | "off"`, for your own CSS or Tailwind. The switches are buttons with `role="switch"` and `aria-checked`, labelled by their purpose; changes are announced through a live region.

The optional `dpdp-kit/react/styles.css` has no specificity (everything is inside `:where()`), so your CSS always wins. Change the look with custom properties:

```css
.dpdp-notice, .dpdp-centre {
  --dpdp-accent: #0b6e4f;
  --dpdp-radius: 6px;
  --dpdp-font: "Inter", sans-serif;
}
```

It's light by default, since only your app knows whether its page is dark. Add `data-dpdp-theme="dark"` to the component or a parent such as `<html>`, or `"auto"` to follow the system setting.

## Hooks

Build your own screens with the hooks the components use.

### Consents

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

### Every hook

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

> [React Native](../react-native/) gets the same screens, built on the same hooks. For a working app, see [`examples/next-app`](https://github.com/yogesh2902/dpdp-kit/tree/main/examples/next-app): Next.js App Router on SQLite, with both screens, run through a year of customers in CI.
