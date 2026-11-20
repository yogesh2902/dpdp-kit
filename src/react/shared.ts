// Logic shared by the web and React Native screens: no DOM, no React Native.
import type { PurposeStatus } from "../http.js";
import { NOTICE_LANGUAGES, type NoticeLanguage } from "../languages.js";
import type { PrivacyNotice } from "../notice.js";
import type { AccessSummary } from "../rights.js";
import type { Labels } from "./labels.js";

/** A language's name in its own script, e.g. "हिन्दी", or its English name where the engine has none. */
export const languageName = (code: NoticeLanguage) => {
  try {
    const own = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (own && own !== code) return own;
  } catch {
    // An engine without this language's names: the English name.
  }
  return NOTICE_LANGUAGES[code];
};

/** Purposes the person can switch: consent purposes, and Section 7(a) uses (by objecting). */
export const switchable = (p: PurposeStatus) => p.basis === "consent" || p.legitimateUse === "7(a)";

/** A stored value, as text. */
export const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A field's label from the data map, or its name made readable. */
export function fieldLabel(fields: AccessSummary["data"][number]["fields"], field: string): string {
  const label = fields.find((f) => f.field === field)?.label;
  if (label) return label;
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "90d" → "within 90 days" in the labels' words. */
export const answerTime = (l: Labels, duration: string) => {
  const m = /^(\d+)d$/.exec(duration);
  return m ? l.days(Number(m[1])) : duration;
};

/**
 * The notice's own text (what the server saved as proof), split for display: the title, the
 * lines before the purposes, each purpose with its two lines, and the lines after.
 */
export function noticeParts(n: PrivacyNotice) {
  const lines = n.text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("• "));
  const head = first === -1 ? lines : lines.slice(0, first);
  return {
    title: head[0] ?? "",
    intro: head.slice(1).filter(Boolean),
    items: n.items.map((item, i) => ({
      purpose: item.purpose,
      text: first === -1 ? item.description : (lines[first + 2 * i]?.replace(/^• /, "") ?? item.description),
      data: first === -1 ? "" : (lines[first + 2 * i + 1]?.trim() ?? ""),
    })),
    footer: (first === -1 ? [] : lines.slice(first + 2 * n.items.length)).filter(Boolean),
  };
}

/** URLs in a line, split out so each screen can make them links. */
export const splitLinks = (text: string) => text.split(/(https?:\/\/[^\s)]+)/g).map((part, i) => ({ text: part, url: i % 2 === 1 }));
