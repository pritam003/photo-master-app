/**
 * AES-256-GCM encrypt/decrypt for storing sensitive tokens (e.g. Google refresh tokens) at rest.
 *
 * Key is read from TOKEN_ENCRYPTION_KEY env var — must be a 64-char hex string (32 bytes).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Stored format: "<iv_hex>:<ciphertext_hex>:<authTag_hex>"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY ?? "";

if (!KEY_HEX || KEY_HEX.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  throw new Error(
    "TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

const KEY = Buffer.from(KEY_HEX, "hex");

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a storable string: "<iv_hex>:<ciphertext_hex>:<authTag_hex>"
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * Decrypts a string produced by encryptToken.
 * Throws if the format is invalid or authentication fails (tampered data).
 */
export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token format");
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final("utf8");
}
