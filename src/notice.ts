// Privacy notices built from the config (Section 5, Rule 3), with a version that changes only when
// the content does, and snapshots kept as proof of what each person was shown (Section 6(10)).
import type { DpdpConfig } from "./config.js";
import { DpdpError } from "./errors.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isNoticeLanguage, type NoticeLanguage } from "./languages.js";

/**
 * - `"consent"`: shown with, or before, a request for consent (Section 5(1)).
 * - `"existing-users"`: for people who consented before the Act came into force (Section 5(2)).
 */
export type NoticeKind = "consent" | "existing-users";

export const NOTICE_KINDS: readonly NoticeKind[] = ["consent", "existing-users"];

/**
 * Where people can act on the notice. Rule 3(c) requires the link to your website or app, and a
 * description of the other means to withdraw consent, exercise rights and complain to the Board.
 * Each value is a URL or a short description, e.g. `"https://chai.example/privacy"` or
 * `"Settings → Privacy in the app"`.
 */
export interface NoticeLinks {
  /** Your website or app (Rule 3(c)). */
  website: string;
  /** Where to withdraw consent, as easily as it was given (Rule 3(c)(i), Section 6(4)). */
  withdraw: string;
  /** Where to exercise rights: access, correction, erasure, nomination, grievances (Rule 3(c)(ii)). */
  rights: string;
  /**
   * How to complain to the Data Protection Board (Rule 3(c)(iii)). Optional: without it the
   * notice says people can complain to the Board once they've raised a grievance with you.
   */
  complaint?: string;
}

/**
 * The fixed sentences of a notice, with placeholders: `{fiduciary}`, `{withdraw}`, `{rights}`,
 * `{contact}`, `{complaint}`, `{website}`. dpdp-kit ships English; supply the rest per language.
 */
export interface NoticeWording {
  /** e.g. "Privacy notice: {fiduciary}" */
  title: string;
  /** Opening for a consent request. */
  introConsent: string;
  /** Opening for people who consented before the Act came into force. */
  introExisting: string;
  /** Introduces the list of data for each purpose, e.g. "Data used:". */
  data: string;
  /** Must contain `{withdraw}`. */
  withdraw: string;
  /** Must contain `{rights}`. */
  rights: string;
  /** Must contain `{contact}`. Left out when there is no `fiduciary.dpo`. */
  contact: string;
  /** Used when there is no `links.complaint`. */
  complaint: string;
  /** Used with `links.complaint`; must contain `{complaint}`. */
  complaintWithLink: string;
  /** Must contain `{website}`. */
  website: string;
}

export const ENGLISH_WORDING: NoticeWording = {
  title: "Privacy notice: {fiduciary}",
  introConsent: "{fiduciary} asks for your consent to use the personal data below, for the purposes described.",
  introExisting:
    "You gave {fiduciary} consent to use your personal data before the Digital Personal Data Protection Act, 2023 came into force. This is the personal data we have processed, and why.",
  data: "Data used:",
  withdraw: "You can withdraw your consent at any time, as easily as you gave it: {withdraw}",
  rights: "To access, correct or erase your data, nominate someone to act for you, or raise a grievance: {rights}",
  contact: "Questions about your data: {contact}",
  complaint: "If you're not satisfied with how we handle your grievance, you can complain to the Data Protection Board of India.",
  complaintWithLink: "If you're not satisfied with how we handle your grievance, you can complain to the Data Protection Board of India: {complaint}",
  website: "More about how we use your data: {website}",
};

/** Placeholders each wording must keep, so the notice still has what Rule 3(c) requires. */
export const REQUIRED_PLACEHOLDERS: Partial<Record<keyof NoticeWording, string>> = {
  withdraw: "{withdraw}",
  rights: "{rights}",
  contact: "{contact}",
  complaintWithLink: "{complaint}",
  website: "{website}",
};

/** One language's text, supplied by you. dpdp-kit doesn't translate. */
export interface NoticeTranslation<P extends string = string> {
  /** Your name as written in this language. Default `fiduciary.name`. */
  fiduciary?: string;
  /** Each consent purpose's description. */
  purposes: Partial<Record<P, string>>;
  /** Each field's label, keyed `"<data key>.<field>"`, e.g. `"users.phone"`. */
  fields: Record<string, string>;
  wording: NoticeWording;
  /** Pages in this language, if you have them. Default `notice.links`. */
  links?: Partial<NoticeLinks>;
}

export interface NoticeConfig<P extends string = string> {
  links: NoticeLinks;
  /**
   * Notices in other languages than English (Section 5(3)), keyed by language code
   * (`"hi"`, `"ta"`…). The audit checks each one is complete.
   */
  translations?: Partial<Record<NoticeLanguage, NoticeTranslation<P>>>;
  /**
   * Your own version label, e.g. `"2026-11"`. By default each notice's version is a hash of its
   * content, so it changes exactly when the text does. With your own label, change it whenever you
   * change the notice: granting consent fails with `notice-version-conflict` if a different
   * notice was already saved under the same label.
   */
  version?: string;
}

export interface NoticeItem {
  purpose: string;
  /** The specified purpose, and what it provides (Rule 3(b)(ii)). */
  description: string;
  /** The itemised personal data (Rule 3(b)(i)): one entry per label, with the fields behind it. */
  data: Array<{ label: string; category: string; fields: string[] }>;
}

/** A notice as shown to people, and as saved as proof. */
export interface PrivacyNotice {
  version: string;
  language: NoticeLanguage;
  kind: NoticeKind;
  fiduciary: string;
  items: NoticeItem[];
  links: NoticeLinks;
  contact?: string;
  /** The whole notice as plain text, ready to show or send. */
  text: string;
}

export interface SavedNotice {
  notice: PrivacyNotice;
  /** When it was first shown (saved). */
  firstShownAt: string;
}

/**
 * Where notice snapshots are kept. The built-in stores are all one (table or collection
 * `dpdp_privacy_notices`).
 */
export interface NoticeStore {
  /** Save a notice unless one with the same version, language and kind exists. True when saved. */
  savePrivacyNotice(notice: PrivacyNotice, at: string): Promise<boolean>;
  getPrivacyNotice(version: string, language: NoticeLanguage, kind: NoticeKind): Promise<SavedNotice | undefined>;
  /** Every saved notice, oldest first. */
  listPrivacyNotices(): Promise<SavedNotice[]>;
}

export function isNoticeStore(store: object): store is NoticeStore {
  const s = store as Partial<NoticeStore>;
  return typeof s.savePrivacyNotice === "function" && typeof s.getPrivacyNotice === "function";
}

/** Languages a config has a notice in: English, then each translation. */
export function noticeLanguages(config: DpdpConfig<string>): NoticeLanguage[] {
  return ["en", ...(Object.keys(config.notice?.translations ?? {}) as NoticeLanguage[]).filter((l) => l !== "en")];
}

/** `"phoneNumber"` and `"phone_number"` → `"Phone number"`. Fields should set `label`; this is the fallback. */
export function humanise(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/**
 * Build the notice for a language. Items are the consent purposes, in config order, each with the
 * data held for it. Pure: the same config always gives the same notice and version.
 */
export function buildNotice(config: DpdpConfig<string>, options: { language?: NoticeLanguage; kind?: NoticeKind } = {}): PrivacyNotice {
  const notice = config.notice;
  if (!notice) throw new DpdpError("notice-not-configured", "Add notice: { links: { website, withdraw, rights } } to the config to build notices");
  const language = options.language ?? "en";
  const kind = options.kind ?? "consent";
  if (!isNoticeLanguage(language)) throw new DpdpError("invalid-language", `Unknown notice language ${JSON.stringify(language)}`);
  if (!NOTICE_KINDS.includes(kind)) throw new DpdpError("invalid-input", `Unknown notice kind ${JSON.stringify(kind)}`);
  const translation = language === "en" ? undefined : notice.translations?.[language];
  if (language !== "en" && !translation) {
    throw new DpdpError("notice-language-unavailable", `There's no ${language} notice: add notice.translations.${language} to the config`);
  }

  const missing = (what: string): never => {
    throw new DpdpError("notice-translation-incomplete", `The ${language} notice has no ${what}. Run the audit to see everything missing.`);
  };
  const wording = translation ? translation.wording : ENGLISH_WORDING;
  const fiduciary = translation?.fiduciary ?? config.fiduciary.name;
  const links: NoticeLinks = { ...notice.links, ...translation?.links };

  const items: NoticeItem[] = [];
  for (const [purpose, def] of Object.entries(config.purposes)) {
    if (def.basis !== "consent") continue;
    const description = translation ? translation.purposes[purpose] : def.description;
    if (!description) {
      if (translation) missing(`description for purpose ${purpose}`);
      throw new DpdpError("notice-description-missing", `Purpose ${purpose} needs a description for the notice (Rule 3(b)(ii))`);
    }
    const data: NoticeItem["data"] = [];
    for (const [key, table] of Object.entries(config.data)) {
      for (const [field, f] of Object.entries(table.fields)) {
        if (!f.purposes.includes(purpose)) continue;
        const label = translation ? (translation.fields[`${key}.${field}`] ?? missing(`label for ${key}.${field}`)) : (f.label ?? humanise(field));
        const same = data.find((d) => d.label === label);
        if (same) same.fields.push(`${key}.${field}`);
        else data.push({ label, category: f.category, fields: [`${key}.${field}`] });
      }
    }
    items.push({ purpose, description, data });
  }

  const contact = config.fiduciary.dpo;
  const values = { fiduciary, contact: contact ?? "", ...links, complaint: links.complaint ?? "" };
  const lines = [fill(wording.title, values), "", fill(kind === "consent" ? wording.introConsent : wording.introExisting, values), ""];
  for (const item of items) {
    lines.push(`• ${item.description}`, `  ${wording.data} ${item.data.map((d) => d.label).join(", ")}`);
  }
  lines.push("", fill(wording.withdraw, values), fill(wording.rights, values));
  if (contact) lines.push(fill(wording.contact, values));
  lines.push(fill(links.complaint ? wording.complaintWithLink : wording.complaint, values), fill(wording.website, values));

  const content: Omit<PrivacyNotice, "version"> = {
    language,
    kind,
    fiduciary,
    items,
    links,
    ...(contact ? { contact } : {}),
    text: lines.join("\n"),
  };
  return { version: notice.version ?? noticeHash(content), ...content };
}

/** Twelve hex characters of a SHA-256 over the notice's content (everything but the version). */
export function noticeHash(content: Omit<PrivacyNotice, "version">): string {
  return sha256(canonicalJson(content)).slice(0, 12);
}

/** Whether two notices say exactly the same thing. */
export const sameNotice = (a: PrivacyNotice, b: PrivacyNotice) => canonicalJson(a) === canonicalJson(b);
