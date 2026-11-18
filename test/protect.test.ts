import { describe, expect, it } from "vitest";
import {
  createEncryptor,
  createTokenizer,
  generateKey,
  mask,
  maskAadhaar,
  maskEmail,
  maskPan,
  maskPhone,
} from "../src/protect.js";

describe("createEncryptor", () => {
  const k1 = generateKey();
  const k2 = generateKey();

  it("round-trips, with a fresh IV every time", () => {
    const enc = createEncryptor({ keys: { k1 }, current: "k1" });
    const a = enc.encrypt("1234 5678 9012");
    const b = enc.encrypt("1234 5678 9012");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.k1.")).toBe(true);
    expect(a).not.toContain("1234");
    expect(enc.decrypt(a)).toBe("1234 5678 9012");
    expect(enc.isEncrypted(a)).toBe(true);
    expect(enc.isEncrypted("1234 5678 9012")).toBe(false);
    expect(enc.decrypt(enc.encrypt(""))).toBe("");
    expect(enc.decrypt(enc.encrypt("नमस्ते 👋"))).toBe("नमस्ते 👋");
  });

  it("detects any change to the ciphertext", () => {
    const enc = createEncryptor({ keys: { k1 }, current: "k1" });
    const parts = enc.encrypt("secret").split(".");
    const data = Buffer.from(parts[4]!, "base64url");
    data[0]! ^= 1;
    parts[4] = data.toString("base64url");
    expect(() => enc.decrypt(parts.join("."))).toThrow(expect.objectContaining({ code: "decrypt-failed" }));
    expect(() => enc.decrypt("v1.k1.not.valid")).toThrow(expect.objectContaining({ code: "decrypt-failed" }));
  });

  it("binds a value to its context, so it can't be moved to another row", () => {
    const enc = createEncryptor({ keys: { k1 }, current: "k1" });
    const stored = enc.encrypt("ABCDE1234F", "users.pan:42");
    expect(enc.decrypt(stored, "users.pan:42")).toBe("ABCDE1234F");
    expect(() => enc.decrypt(stored, "users.pan:43")).toThrow(expect.objectContaining({ code: "decrypt-failed" }));
    expect(() => enc.decrypt(stored)).toThrow(expect.objectContaining({ code: "decrypt-failed" }));
  });

  it("rotates keys: old values still decrypt and are flagged for re-encryption", () => {
    const before = createEncryptor({ keys: { k1 }, current: "k1" });
    const old = before.encrypt("9876543210");
    const after = createEncryptor({ keys: { k1, k2 }, current: "k2" });
    expect(after.decrypt(old)).toBe("9876543210");
    expect(after.needsRotation(old)).toBe(true);
    expect(after.needsRotation(after.encrypt("9876543210"))).toBe(false);
    const onlyNew = createEncryptor({ keys: { k2 }, current: "k2" });
    expect(() => onlyNew.decrypt(old)).toThrow(expect.objectContaining({ code: "decrypt-failed" }));
  });

  it("rejects bad keys", () => {
    expect(() => createEncryptor({ keys: { k1: "c2hvcnQ" }, current: "k1" })).toThrow(expect.objectContaining({ code: "invalid-key" }));
    expect(() => createEncryptor({ keys: { "k.1": k1 }, current: "k.1" })).toThrow(expect.objectContaining({ code: "invalid-key" }));
    expect(() => createEncryptor({ keys: { k1 }, current: "k2" })).toThrow(expect.objectContaining({ code: "invalid-key" }));
    // standard base64 works too
    const std = Buffer.from(k1, "base64url").toString("base64");
    expect(createEncryptor({ keys: { k1: std }, current: "k1" }).decrypt(createEncryptor({ keys: { k1 }, current: "k1" }).encrypt("x"))).toBe("x");
  });
});

describe("createTokenizer", () => {
  it("gives the same token for the same value, and different ones for other keys", () => {
    const key = generateKey();
    const t = createTokenizer({ key });
    expect(t.token("asha@example.com")).toBe(t.token(" asha@example.com "));
    expect(t.token("asha@example.com")).not.toBe(t.token("ravi@example.com"));
    expect(t.token("asha@example.com")).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(createTokenizer({ key: generateKey() }).token("asha@example.com")).not.toBe(t.token("asha@example.com"));
  });

  it("normalises before tokenising", () => {
    const t = createTokenizer({ key: generateKey(), normalize: (v) => v.trim().toLowerCase() });
    expect(t.token("Asha@Example.com")).toBe(t.token("asha@example.com"));
  });

  it("needs a key of at least 32 bytes", () => {
    expect(() => createTokenizer({ key: "c2hvcnQ" })).toThrow(expect.objectContaining({ code: "invalid-key" }));
  });
});

describe("masking", () => {
  it("masks phone numbers, keeping an Indian country code", () => {
    expect(maskPhone("+91 98765 43210")).toBe("+91 ••••••3210");
    expect(maskPhone("9876543210")).toBe("••••••3210");
  });

  it("masks emails, keeping the domain", () => {
    expect(maskEmail("asha.k@gmail.com")).toBe("a•••••@gmail.com");
    expect(maskEmail("a@x.in")).toBe("•@x.in");
  });

  it("uses the masked Aadhaar format", () => {
    expect(maskAadhaar("1234 5678 9012")).toBe("XXXX XXXX 9012");
    expect(maskAadhaar("123456789012")).toBe("XXXX XXXX 9012");
  });

  it("masks PAN and anything else", () => {
    expect(maskPan("abcde1234f")).toBe("XXXXXX234F");
    expect(mask("secret", { keepStart: 1, keepEnd: 1, char: "*" })).toBe("s****t");
    expect(mask("abc")).toBe("•••");
  });
});
