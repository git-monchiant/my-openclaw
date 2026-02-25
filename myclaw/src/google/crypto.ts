/**
 * Google Token Encryption — AES-256-GCM
 * เข้ารหัส refresh/access token ก่อนเก็บใน SQLite
 */

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;

  const envKey = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (envKey) {
    // Hash to ensure exactly 32 bytes regardless of input length
    _key = crypto.createHash("sha256").update(envKey).digest();
  } else {
    // Dev mode: derive from LINE_CHANNEL_SECRET
    const secret = process.env.LINE_CHANNEL_SECRET || "dev-fallback-key";
    _key = crypto.createHash("sha256").update(secret).digest();
    console.warn("[crypto] TOKEN_ENCRYPTION_KEY not set, using derived key (dev mode)");
  }

  return _key;
}

/** Encrypt plaintext → base64 string (iv + ciphertext + tag packed) */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64 string → plaintext */
export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}
