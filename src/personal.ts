import type { Category } from "./config.js";

/**
 * How sure we are that a column holds personal data, judging only by its name.
 * - `strong`: almost always personal (phone, email, aadhaar, date_of_birth, ip_address…).
 * - `weak`: often personal, often not (`name` is a person in `users` but a product in `products`).
 */
export type Confidence = "strong" | "weak";

export interface PersonalGuess {
  category: Category;
  confidence: Confidence;
  /** What matched, for the audit message, e.g. `"phone"`. */
  matched: string;
}

interface Rule {
  /** Every token must appear in the column name, in this order and next to each other. */
  tokens: readonly string[];
  category: Category;
  confidence: Confidence;
}

const rule = (spec: string, category: Category, confidence: Confidence = "strong"): Rule => ({
  tokens: spec.split(" "),
  category,
  confidence,
});

/** Longer, more specific rules come first, so "ip address" wins over "address". */
const RULES: readonly Rule[] = [
  // device and online identifiers
  rule("ip address", "device"),
  rule("ip", "device"),
  rule("imei", "device"),
  rule("device id", "device"),
  rule("user agent", "device"),
  rule("fcm token", "device"),
  rule("push token", "device"),
  rule("advertising id", "device"),
  rule("gaid", "device"),
  rule("idfa", "device"),
  // Indian and other government identifiers
  rule("aadhaar", "identity"),
  rule("aadhar", "identity"),
  rule("uidai", "identity"),
  rule("pan", "identity"),
  rule("passport", "identity"),
  rule("voter id", "identity"),
  rule("epic", "identity"),
  rule("driving licence", "identity"),
  rule("driving license", "identity"),
  rule("abha", "health"),
  // dates of birth and names
  rule("date of birth", "identity"),
  rule("birth date", "identity"),
  rule("birthdate", "identity"),
  rule("birthday", "identity"),
  rule("dob", "identity"),
  rule("first name", "identity"),
  rule("last name", "identity"),
  rule("middle name", "identity"),
  rule("full name", "identity"),
  rule("surname", "identity"),
  rule("father name", "identity"),
  rule("mother name", "identity"),
  rule("guardian name", "identity"),
  rule("parent name", "identity"),
  // contact
  rule("phone", "contact"),
  rule("mobile", "contact"),
  rule("msisdn", "contact"),
  rule("whatsapp", "contact"),
  rule("email", "contact"),
  rule("address", "contact"),
  rule("pincode", "contact"),
  rule("pin code", "contact"),
  rule("postcode", "contact"),
  rule("postal code", "contact"),
  rule("zipcode", "contact"),
  rule("zip code", "contact"),
  // financial
  rule("account number", "financial"),
  rule("bank account", "financial"),
  rule("ifsc", "financial"),
  rule("upi", "financial"),
  rule("vpa", "financial"),
  rule("card number", "financial"),
  rule("iban", "financial"),
  rule("salary", "financial"),
  rule("income", "financial"),
  // health and biometric
  rule("blood group", "health"),
  rule("diagnosis", "health"),
  rule("medical", "health"),
  rule("allergy", "health"),
  rule("allergies", "health"),
  rule("prescription", "health"),
  rule("fingerprint", "biometric"),
  rule("biometric", "biometric"),
  rule("face embedding", "biometric"),
  // location
  rule("latitude", "location"),
  rule("longitude", "location"),
  rule("lat", "location"),
  rule("lng", "location"),
  rule("gps", "location"),
  // weak: personal in a people table, not in a products table
  rule("name", "identity", "weak"),
  rule("gender", "identity", "weak"),
  rule("age", "identity", "weak"),
  rule("photo", "identity", "weak"),
  rule("avatar", "identity", "weak"),
  rule("selfie", "biometric", "weak"),
  rule("signature", "identity", "weak"),
  rule("city", "location", "weak"),
  rule("street", "contact", "weak"),
  rule("location", "location", "weak"),
];

/**
 * A column that ends in one of these describes the data rather than holding it:
 * `email_verified_at`, `phone_confirmed`, `address_type`, `email_opt_in`.
 */
const DESCRIPTIVE_ENDINGS = new Set([
  "verified",
  "verification",
  "confirmed",
  "enabled",
  "disabled",
  "count",
  "type",
  "status",
  "kind",
  "flag",
  "visible",
  "public",
  "at",
  "sent",
  "in",
  "out",
  "allowed",
  "required",
]);

/**
 * A column named for an organisation (`company_pan`, `merchant_email`, `branch_address`) is
 * usually business data, though a sole proprietor's PAN or a one-person shop's email is personal.
 * Such columns are only ever a `weak` guess.
 */
const ORGANISATION_WORDS = new Set([
  "company",
  "business",
  "org",
  "organisation",
  "organization",
  "merchant",
  "vendor",
  "supplier",
  "firm",
  "branch",
  "office",
  "school",
  "institute",
  "college",
]);

/** `phoneNumber`, `phone_number`, `PhoneNumber`, `phone-number` → `["phone", "number"]`. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function containsRun(tokens: readonly string[], run: readonly string[]): boolean {
  outer: for (let i = 0; i + run.length <= tokens.length; i++) {
    for (let j = 0; j < run.length; j++) if (tokens[i + j] !== run[j]) continue outer;
    return true;
  }
  return false;
}

/** Guess, from its name alone, whether a column holds personal data. */
export function guessPersonal(columnName: string): PersonalGuess | undefined {
  const tokens = tokenize(columnName);
  if (tokens.length === 0) return undefined;
  const last = tokens[tokens.length - 1]!;
  if (tokens.length > 1 && DESCRIPTIVE_ENDINGS.has(last)) return undefined;
  const organisational = tokens.some((t) => ORGANISATION_WORDS.has(t));
  for (const r of RULES) {
    if (containsRun(tokens, r.tokens)) {
      return {
        category: r.category,
        confidence: organisational ? "weak" : r.confidence,
        matched: r.tokens.join(" "),
      };
    }
  }
  return undefined;
}
