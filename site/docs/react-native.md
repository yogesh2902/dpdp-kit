---
title: React Native
description: The consent notice and privacy centre for React Native and Expo apps, on the same hooks as React.
---

> New in 0.6.

`dpdp-kit/react-native` has the same screens as [React](../react/), built from React Native's own `View`, `Text`, `Switch`, `Pressable` and `TextInput`, for iOS and Android apps with or without Expo. They call your server's [HTTP API](../http/).

```bash
npm i dpdp-kit
```

## Set up

A mobile app signs in with a token, not a cookie, so give the client the full URL of your API and the token:

```tsx
import { DpdpProvider, PrivacyCentre } from "dpdp-kit/react-native";

export function Privacy({ token }: { token: string }) {
  return (
    <DpdpProvider options={{ base: "https://api.example.in/privacy", headers: () => ({ authorization: `Bearer ${token}` }) }}>
      <PrivacyCentre />
    </DpdpProvider>
  );
}
```

On the server, `subject` reads the same token: `dpdpRouter(dpdp, { subject: (req) => userFromToken(req.headers.authorization) })`. The API refuses anything without it (401), so the person only ever sees their own records.

## Screens

```tsx
import { ConsentNotice, PrivacyCentre } from "dpdp-kit/react-native";

// After sign-up
<ConsentNotice language="hi" onDone={() => navigation.replace("Home")} />

// In settings
<PrivacyCentre theme="auto" />
```

They do what the web components do (see [React](../react/#ready-made-screens)):

- **`<ConsentNotice>`**: the notice's own text in the person's language, a switch per purpose with every one off, and "Accept selected" and "Reject all" alike. Languages are buttons, each in its own script.
- **`<PrivacyCentre>`**: `<ConsentSettings>`, `<MyData>` (with a share sheet to save a copy), `<Requests>`, `<Nominees>` and `<HowToReachUs>`, each also exported on its own.

Both scroll by themselves. Inside your own `ScrollView`, pass `scroll={false}`.

## Look and words

| Prop | |
|---|---|
| `theme` | `"light"` (default), `"dark"`, or `"auto"` to follow the phone's setting |
| `colors` | Some of `text`, `muted`, `background`, `surface`, `border`, `accent`, `off`, `error` |
| `labels` | Your own words for anything outside the notice, as on the web |

Switches, buttons and language choices carry accessibility roles and labels, so VoiceOver and TalkBack read each purpose with its switch.

## Hooks

`useConsents`, `useNotice`, `useMyData`, `useRequests`, `useNominees` and `useRights` are exported here too, the same as in [React](../react/#hooks), for screens of your own.

For a working app, see [`examples/expo-app`](https://github.com/yogesh2902/dpdp-kit/tree/main/examples/expo-app): an Expo app with these screens, calling the Next.js example's API with a Bearer token.
