/**
 * Teno — Node.js: POST /api/external/fetch-dk + RSA decrypt.
 * Same AES wire format as web crypto-aes (iv 12 || ciphertext || tag 16, base64).
 * Same RSA as engine/decrypt_rsa_export.js (RSA-OAEP, SHA-256).
 *
 * Requires Node 18+ (global fetch). Save as fetch-dk-example.cjs and run: node fetch-dk-example.cjs
 */

const crypto = require("node:crypto");

const BASE_URL = "https://cred.polywinbot.xyz"; // no trailing slash
const API_KEY = "uweom4SyD3NWBAWFv0-CmpXl_t7k4Sw-YIaMhpD_hjw"; // Authorization: Bearer …
const WALLET_ADDRESS = "0xf3534B482284537ad589F7D7121c82b77f006735";
const PROTECT_KEY = "abc123";
const CIPHERKEY = "XEKbzigoSR9vzutVG5QNXAZY//zL2z1U13wPGmGA3VbtFfkOQJTLlVhwcp2lGNOxwLD7t7fpG7wpfOkeiCaaNcXuhubBYEWh+4ru6TWkQfnFTk0Qm2WI6ur4yi4tIXu4socvsr/PZnqF7U5QyPfL/tjBl3v6QOqid0LW0ChHrm5Czfpv9y4PHm6eUHlKjZDAgEK99S5CLs/IKGBPpD7BmfJ5R17jh476oRoxc1puGboAzGO4D1QxYp8eSUNT+Y7GYxOsFy+5M6btBBz9uZPmvPQi7QKL8T+MGwZFQFldcfKnlGvLG/kNgg7m2WucbONfwimem3s/m40hLiFqZrKibRw/maYAUv7rabOUGhkhQ6oZHgunF66CVa9j86hBQNFVPV10kYozQ4amZ1nQKxLUm29x8SgOsycTWZeEjYe2Unhzyys359p1raLeMZwlclqLXo4iJRvjFSlfYryXUuJPJQn/Vg/nrRBeyXc2+0iduFc6DhY4pdrBmcHDfdYM1oSHUZGnkpLxjJB8PY1OOUnCTEZgvE5dphuoH7ZqFODQBLLd4Iqmt21jP9xdmEGz03ch2ZNSTkqWlnYMA16cx/mPuakgl31pmULixhZB0SaNQCdh/fdL+mZ8JUzbai+JU3D0s4ZM8LYwCfIEKUFwbrxLqE+C92AsGxV7kLeFn/JxUhU=";


const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PLACEHOLDER_PREFIX = "paste-";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function hasPlaceholder(v) {
  return typeof v !== "string" || v.length === 0 || v.startsWith(PLACEHOLDER_PREFIX);
}

function normalizeAddress(address) {
  if (typeof address !== "string" || !ETH_ADDRESS.test(address)) {
    throw new Error("walletAddress must be a valid 0x-prefixed 40-hex Ethereum address.");
  }
  return address.toLowerCase();
}

function ensureConfigured(walletAddress, protectKey) {
  if (hasPlaceholder(API_KEY)) {
    throw new Error("Set API_KEY to a real key from Dashboard → Generate new API key.");
  }
  if (!BASE_URL.startsWith("https://") && !BASE_URL.startsWith("http://")) {
    throw new Error("BASE_URL must include protocol, e.g. https://cred.polywinbot.xyz");
  }
  normalizeAddress(walletAddress);
  if (typeof protectKey !== "string" || protectKey.length < 4) {
    throw new Error("protectKey must be at least 4 characters.");
  }
  if (!ETH_ADDRESS.test(WALLET_ADDRESS)) {
    throw new Error("WALLET_ADDRESS must be a valid 0x-prefixed 40-hex address.");
  }
  if (hasPlaceholder(CIPHERKEY)) {
    throw new Error("Set CIPHERKEY from your local *_rsa_ciphertext.json file.");
  }
}

function deriveKeyFromProtectKey(protectKey) {
  return crypto.createHash("sha256").update(protectKey, "utf8").digest();
}

/** AES-256-GCM — same wire as Teno src/lib/crypto-aes.ts */
function aesEncryptUtf8(plaintext, protectKey) {
  const key = deriveKeyFromProtectKey(protectKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_LENGTH,
  });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

function aesDecryptUtf8(b64, protectKey) {
  const key = deriveKeyFromProtectKey(protectKey);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid ciphertext");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const enc = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

async function callFetchDk(encryptedWalletAddress, protectKey) {
  const r = await fetch(`${BASE_URL}/api/external/fetch-dk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      encryptedWalletAddress,
      protectKey,
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail =
      typeof j.error === "string" && j.error.trim().length > 0
        ? j.error.trim()
        : undefined;
    if (r.status === 400) {
      throw new Error(
        detail ||
          "400 Bad Request: invalid JSON/body or wallet address could not be decrypted."
      );
    }
    if (r.status === 401) {
      throw new Error(
        detail ||
          "401 Unauthorized: invalid or missing API key."
      );
    }
    if (r.status === 403) {
      throw new Error(
        detail ||
          "403 Forbidden: wallet not found for this user, API disabled, or IP not allowed."
      );
    }
    throw new Error(detail || `fetch-dk failed: ${r.status}`);
  }
  return j;
}

/** API returns encryptedDecryptKey; unwrap to same shape as *_rsa_decrypt_key.json */
async function fetchDecryptKeyJson(walletAddress, protectKey) {
  const encryptedWalletAddress = aesEncryptUtf8(
    normalizeAddress(walletAddress),
    protectKey
  );
  const j = await callFetchDk(encryptedWalletAddress, protectKey);
  if (typeof j.encryptedDecryptKey !== "string" || j.encryptedDecryptKey.length === 0) {
    throw new Error("fetch-dk response missing encryptedDecryptKey.");
  }

  const innerUtf8 = aesDecryptUtf8(j.encryptedDecryptKey, protectKey);
  return JSON.parse(innerUtf8);
}

/** Mirrors engine/decrypt_rsa_export.js */
function rsaJwkFromKeyFile(keyFile) {
  if (typeof keyFile.decdata === "string") {
    return JSON.parse(Buffer.from(keyFile.decdata, "base64").toString("utf8"));
  }
  if (keyFile.jwk && typeof keyFile.jwk === "object") {
    return keyFile.jwk;
  }
  throw new Error("Unsupported decrypt key file: expected decdata or jwk.");
}

function rsaOaepSha256Decrypt(ciphertextB64, rsaPrivateJwk) {
  const rsaPrivate = crypto.createPrivateKey({ key: rsaPrivateJwk, format: "jwk" });
  const plain = crypto.privateDecrypt(
    {
      key: rsaPrivate,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(ciphertextB64, "base64")
  );
  return plain.toString("utf8");
}

async function fetchThenRsaDecryptWalletSecret() {

  const walletAddress = WALLET_ADDRESS;
  const protectKey = PROTECT_KEY;
  ensureConfigured(WALLET_ADDRESS, PROTECT_KEY);

  const keyFile = await fetchDecryptKeyJson(walletAddress, protectKey);

  if (
    typeof keyFile.address === "string" &&
    WALLET_ADDRESS.toLowerCase() !== keyFile.address.toLowerCase()
  ) {
    throw new Error("Address mismatch between ciphertext file and decrypt key from API.");
  }

  const jwk = rsaJwkFromKeyFile(keyFile);
  const plainUtf8 = rsaOaepSha256Decrypt(CIPHERKEY, jwk);
  const { address, privateKey } = JSON.parse(plainUtf8);

  if (
    typeof keyFile.address === "string" &&
    address.toLowerCase() !== keyFile.address.toLowerCase()
  ) {
    throw new Error("Decrypted address does not match address in decrypt key file.");
  }

  return { address, privateKey };
}

  // Full RSA decrypt (requires real WALLET_ADDRESS and CIPHERKEY):
  // const { address, privateKey } = await fetchThenRsaDecryptWalletSecret(
  //   WALLET_ADDRESS,
  //   PROTECT_KEY
  // );
  // console.log(JSON.stringify({ address, privateKey }, null, 2));


module.exports = {
  fetchThenRsaDecryptWalletSecret
}