import crypto from "node:crypto";
import { env } from "../config/env.js";

// AES-256-GCM encryption for provider API keys at rest.
//
// GCM is authenticated: decryption fails loudly if the ciphertext was
// tampered with. The stored format is three hex segments joined by ":" —
//   <iv>:<authTag>:<ciphertext>
// ENCRYPTION_KEY must be 32 bytes (256 bits), hex-encoded (64 hex chars).
// Generate one with: openssl rand -hex 32

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM

function getKey(): Buffer {
  const hex = env.encryptionKey;
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`.",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes.`,
    );
  }
  return key;
}

export function encryptKey(plainKey: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plainKey, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

export function decryptKey(encryptedKey: string): string {
  const parts = encryptedKey.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted key.");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
