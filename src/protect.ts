import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { DpdpError } from "./errors.js";

/*
 * Rule 6(1)(a) of the DPDP Rules: "appropriate data security measures, such as securing of personal
 * data through encryption, obfuscation, masking or the use of virtual tokens mapped to that personal
 * data". These helpers cover the parts that belong in application code.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

type KeyInput = string | Uint8Array;

/** A new random 256-bit key, as base64url text. Keep it in your secrets manager, not in code. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

/** Decode a key given as base64 or base64url text, or bytes. `exact` requires exactly 32 bytes, otherwise at least 32. */
function toKey(input: KeyInput, label: string, exact = true): Buffer {
  // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
  const key = typeof input === "string" ? Buffer.from(input, "base64") : Buffer.from(input);
  if (exact ? key.length !== KEY_BYTES : key.length < KEY_BYTES) {
    throw new DpdpError(
      "invalid-key",
      `${label} must be ${exact ? "" : "at least "}${KEY_BYTES} bytes (base64 or base64url text, or bytes); got ${key.length}`,
    );
  }
  return key;
}

export interface EncryptorOptions {
  /** Keys by id, each 32 bytes: base64 or base64url text (see `generateKey()`) or bytes. */
  keys: Record<string, KeyInput>;
  /** The id of the key that encrypts. The others only decrypt older values, so you can rotate keys. */
  current: string;
}

export interface Encryptor {
  /**
   * Encrypt a value with AES-256-GCM. Each call uses a fresh random IV, so the same value encrypts
   * differently every time; use `createTokenizer` to look values up. Pass `context` (for example
   * `"users.phone:42"`) to bind the ciphertext to one place: decrypting it with another context
   * fails, so a copied value can't be moved to another row.
   */
  encrypt(plaintext: string, context?: string): string;
  /** Decrypt a value from `encrypt`. Throws `DpdpError("decrypt-failed")` if it was changed, or the key or context is wrong. */
  decrypt(ciphertext: string, context?: string): string;
  /** Whether a value looks like the output of `encrypt`. */
  isEncrypted(value: string): boolean;
  /** Whether a value was encrypted with a key other than `current`, and should be re-encrypted. */
  needsRotation(ciphertext: string): boolean;
}

/**
 * Field encryption for personal data at rest.
 *
 * ```ts
 * const crypto = createEncryptor({ keys: { k1: process.env.DPDP_KEY_1! }, current: "k1" });
 * const stored = crypto.encrypt(user.aadhaar, `users.aadhaar:${user.id}`);
 * ```
 */
export function createEncryptor(options: EncryptorOptions): Encryptor {
  const keys = new Map<string, Buffer>();
  for (const [id, key] of Object.entries(options.keys)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new DpdpError("invalid-key", `Key id ${JSON.stringify(id)} may only use letters, digits, "_" and "-"`);
    }
    keys.set(id, toKey(key, `Key ${JSON.stringify(id)}`));
  }
  const current = keys.get(options.current);
  if (!current) throw new DpdpError("invalid-key", `current key ${JSON.stringify(options.current)} isn't in keys`);

  const parse = (value: string) => {
    const parts = value.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION) return undefined;
    const [, keyId, iv, tag, data] = parts as [string, string, string, string, string];
    return { keyId, iv: Buffer.from(iv, "base64url"), tag: Buffer.from(tag, "base64url"), data: Buffer.from(data, "base64url") };
  };

  return {
    encrypt(plaintext, context) {
      if (typeof plaintext !== "string") throw new DpdpError("invalid-input", "encrypt() takes a string");
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current, iv);
      if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, options.current, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
    },

    decrypt(ciphertext, context) {
      const parsed = typeof ciphertext === "string" ? parse(ciphertext) : undefined;
      if (!parsed) throw new DpdpError("decrypt-failed", "Not a value from encrypt()");
      const key = keys.get(parsed.keyId);
      if (!key) throw new DpdpError("decrypt-failed", `Encrypted with key ${JSON.stringify(parsed.keyId)}, which isn't in keys`);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
        if (context !== undefined) decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(parsed.tag);
        return Buffer.concat([decipher.update(parsed.data), decipher.final()]).toString("utf8");
      } catch {
        throw new DpdpError("decrypt-failed", "Couldn't decrypt: the value was changed, or the key or context is wrong");
      }
    },

    isEncrypted: (value) => typeof value === "string" && parse(value) !== undefined,

    needsRotation(ciphertext) {
      const parsed = parse(ciphertext);
      return parsed !== undefined && parsed.keyId !== options.current;
    },
  };
}

export interface TokenizerOptions {
  /** A secret key, at least 32 bytes (see `generateKey()`). Use a different key from encryption. */
  key: KeyInput;
  /**
   * Make equal values equal before tokenising, e.g. lower-case an email or strip spaces from a phone
   * number. Default: trim surrounding whitespace.
   */
  normalize?: (value: string) => string;
}

export interface Tokenizer {
  /**
   * A stable token for a value (keyed HMAC-SHA256): the same value always gives the same token, and
   * without the key the token reveals nothing about the value. Store it beside the encrypted value
   * and look rows up by it, or use it in place of the value where you only need to match.
   */
  token(value: string): string;
}

/** Virtual tokens mapped to personal data, for lookups without storing the value in the clear. */
export function createTokenizer(options: TokenizerOptions): Tokenizer {
  const key = toKey(options.key, "Tokenizer key", false);
  const normalize = options.normalize ?? ((v: string) => v.trim());
  return {
    token(value) {
      if (typeof value !== "string") throw new DpdpError("invalid-input", "token() takes a string");
      return `tk_${createHmac("sha256", key).update(normalize(value), "utf8").digest("base64url")}`;
    },
  };
}

// ---------- masking ----------

export interface MaskOptions {
  /** Characters to leave visible at the start. Default 0. */
  keepStart?: number;
  /** Characters to leave visible at the end. Default 4. */
  keepEnd?: number;
  /** Replacement character. Default `"•"`. */
  char?: string;
}

/** Hide all but a few characters of a value, for showing on screens and in logs. */
export function mask(value: string, options: MaskOptions = {}): string {
  const { keepStart = 0, keepEnd = 4, char = "•" } = options;
  const chars = [...value];
  if (chars.length <= keepStart + keepEnd) return char.repeat(chars.length);
  return chars.slice(0, keepStart).join("") + char.repeat(chars.length - keepStart - keepEnd) + chars.slice(chars.length - keepEnd).join("");
}

/** `"+91 98765 43210"` → `"+91 ••••••3210"`. Keeps an Indian country code if there is one. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${mask(digits.slice(2))}`;
  return mask(digits);
}

/** `"asha.k@gmail.com"` → `"a•••••@gmail.com"`. The domain stays, so support staff can tell accounts apart. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return mask(value);
  const local = value.slice(0, at);
  return mask(local, { keepStart: local.length > 1 ? 1 : 0, keepEnd: 0 }) + value.slice(at);
}

/**
 * `"1234 5678 9012"` → `"XXXX XXXX 9012"`: the masked Aadhaar format, which shows only the last four
 * digits.
 */
export function maskAadhaar(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 12) return mask(digits, { char: "X" });
  return `XXXX XXXX ${digits.slice(8)}`;
}

/** `"ABCDE1234F"` → `"XXXXXX234F"`. */
export function maskPan(value: string): string {
  return mask(value.trim().toUpperCase(), { char: "X" });
}
