/**
 * Languages a notice can be given in. Section 5(3) of the DPDP Act lets a person read the
 * notice in English or in any language in the Eighth Schedule to the Constitution (22 languages).
 * Codes are ISO 639 (639-2/3 where a language has no two-letter code).
 */
export const NOTICE_LANGUAGES = {
  en: "English",
  as: "Assamese",
  bn: "Bengali",
  brx: "Bodo",
  doi: "Dogri",
  gu: "Gujarati",
  hi: "Hindi",
  kn: "Kannada",
  ks: "Kashmiri",
  kok: "Konkani",
  mai: "Maithili",
  ml: "Malayalam",
  mni: "Manipuri",
  mr: "Marathi",
  ne: "Nepali",
  or: "Odia",
  pa: "Punjabi",
  sa: "Sanskrit",
  sat: "Santali",
  sd: "Sindhi",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
} as const;

export type NoticeLanguage = keyof typeof NOTICE_LANGUAGES;

export function isNoticeLanguage(value: unknown): value is NoticeLanguage {
  return typeof value === "string" && Object.hasOwn(NOTICE_LANGUAGES, value);
}
