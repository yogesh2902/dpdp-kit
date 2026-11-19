---
title: Notices
description: Build the privacy notice from your config, record which version each person saw, and keep it as proof.
---

> New in 0.5.

Section 5 requires a notice with every request for consent, and Rule 3 says what it must contain:

- an itemised description of the personal data (Rule 3(b)(i));
- each purpose, and what it provides (Rule 3(b)(ii));
- the link to your website or app, and how to withdraw consent as easily as it was given, exercise rights, and complain to the Data Protection Board (Rule 3(c)).

Your config already lists the data and the purposes. Add the links and dpdp-kit builds the notice, gives it a version that changes only when its content does, and saves a copy the first time it's shown. If consent is ever questioned, Section 6(10) puts the burden of proof on you: each consent event points to the exact notice the person saw.

## Turn it on

```ts
purposes: {
  offers:    { basis: "consent", retain: { afterWithdrawal: "0d" }, description: "Offers and discounts by SMS" },
  analytics: { basis: "consent", retain: { afterWithdrawal: "7d" }, description: "Understanding how the app is used, to improve it" },
},
data: {
  users: { table: "users", subject: "id", fields: {
    phone: { category: "contact", purposes: ["offers"], label: "Mobile number" },
    city:  { category: "location", purposes: ["offers", "analytics"], label: "City" },
  } },
},
notice: {
  links: {
    website: "https://chai.example/privacy",
    withdraw: "Settings → Privacy in the app",
    rights: "https://chai.example/privacy/requests",
    // complaint: optional; without it the notice says people can complain to the Board
  },
},
```

- **`description`** on each consent purpose: the purpose, and what it gives the person.
- **`label`** on each field held for a consent purpose: what people would call it. Without one, the field name is made readable (`phoneNumber` becomes "Phone number").
- **`links`**: a URL, or a short description such as "Settings → Privacy in the app".

Only consent purposes are listed: legitimate uses (Section 7) need no notice.

## Show it

```ts
const notice = await dpdp.notice.show({ language: "en" });
notice.text;     // the whole notice as plain text
notice.items;    // [{ purpose, description, data: [{ label, category, fields }] }]
notice.links;    // { website, withdraw, rights }
notice.version;  // "3f9c1a7e02bd": changes exactly when the content does
```

`show()` saves the notice the first time; `build()` returns the same thing without saving. Render `items` in your own design, or show `text` as it is.

For people who consented before the Act came into force, Section 5(2) requires a notice too. Pass `kind: "existing-users"`: same items, with an opening that says so.

## Consent records the notice

With `notice` set, `consent.grant()` builds the notice in the event's language, saves it if it's new, and records `noticeVersion` and `language` on the event:

```ts
const event = await dpdp.consent.grant(userId, ["offers"], { language: "hi", channel: "android" });
event.noticeVersion; // the Hindi notice's version

const proof = await dpdp.notice.get(event.noticeVersion!, { language: "hi" });
proof.notice.text;   // exactly what was shown
proof.firstShownAt;  // when it was first saved
```

Pass your own `noticeVersion` to `grant()` (for example a paper form) and dpdp-kit leaves it alone. Without `notice` in the config, nothing changes.

The version is a hash of the notice's content, so it's the same in every process and changes only when the text does. Adding a language doesn't change the English version. To use your own labels instead, set `notice.version: "2026-11"`; if you change the notice and forget to change the label, `grant()` fails with `notice-version-conflict` rather than recording consent against the wrong text.

## Other languages

Section 5(3) gives people the option of the notice in English or any of the 22 languages of the Eighth Schedule. dpdp-kit ships the English wording only: you supply each translation, and the audit checks it's complete.

```ts
notice: {
  links: { … },
  translations: {
    hi: {
      purposes: { offers: "SMS से ऑफ़र और छूट", analytics: "…" },
      fields: { "users.phone": "मोबाइल नंबर", "users.city": "शहर" },
      wording: {
        title: "गोपनीयता सूचना: {fiduciary}",
        withdraw: "आप कभी भी उतनी ही आसानी से सहमति वापस ले सकते हैं: {withdraw}",
        // … every sentence of ENGLISH_WORDING
      },
      // links: pages in Hindi, if you have them
    },
  },
},
```

`ENGLISH_WORDING` (exported) has every sentence to translate. Keep the placeholders (`{withdraw}`, `{rights}`, `{contact}`, `{complaint}`, `{website}`): the audit fails when one is missing, because the notice would lose what Rule 3(c) requires. Have translations done by someone fluent, and reviewed: the notice must be in "clear and plain language" (Rule 3(b)).

## What the audit checks

Only when `notice` is set:

| Code | Level | When |
|---|---|---|
| `notice-link-missing` | error | `website`, `withdraw` or `rights` is missing. |
| `notice-description-missing` | error | A consent purpose has no `description`. |
| `notice-translation-incomplete` | error | A translation lacks a purpose, a field label or a sentence, or drops a placeholder. |
| `invalid-notice-language` | error | A translation isn't for an Eighth Schedule language. |
| `notice-label-missing` | warning | A field in the notice has no `label`. |

## Storage

Notices are saved in `dpdp_privacy_notices` (a table, or a MongoDB collection). It's in `DPDP_DDL` and `MIGRATE_0_5_DDL`, the Drizzle table `privacyNotices`, and the Prisma model `DpdpPrivacyNotice`. See [Storage](../storage/).

> dpdp-kit builds the notice and keeps the proof. Whether the notice is clear, shown before consent is asked, and "understandable independently of any other information" (Rule 3(a)) depends on how your app presents it.
