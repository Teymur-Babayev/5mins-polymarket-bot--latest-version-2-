import crypto from "node:crypto";

// ===== Constants =====
const BASE_URL = "https://cred.polywinbot.xyz"; // no trailing slash
const API_KEY = "uweom4SyD3NWBAWFv0-CmpXl_t7k4Sw-YIaMhpD_hjw"; // Authorization: Bearer …
const WALLET_ADDRESS = "0xf3534B482284537ad589F7D7121c82b77f006735";
const PROTECT_KEY = "abc123";
const CIPHERKEY = "XEKbzigoSR9vzutVG5QNXAZY//zL2z1U13wPGmGA3VbtFfkOQJTLlVhwcp2lGNOxwLD7t7fpG7wpfOkeiCaaNcXuhubBYEWh+4ru6TWkQfnFTk0Qm2WI6ur4yi4tIXu4socvsr/PZnqF7U5QyPfL/tjBl3v6QOqid0LW0ChHrm5Czfpv9y4PHm6eUHlKjZDAgEK99S5CLs/IKGBPpD7BmfJ5R17jh476oRoxc1puGboAzGO4D1QxYp8eSUNT+Y7GYxOsFy+5M6btBBz9uZPmvPQi7QKL8T+MGwZFQFldcfKnlGvLG/kNgg7m2WucbONfwimem3s/m40hLiFqZrKibRw/maYAUv7rabOUGhkhQ6oZHgunF66CVa9j86hBQNFVPV10kYozQ4amZ1nQKxLUm29x8SgOsycTWZeEjYe2Unhzyys359p1raLeMZwlclqLXo4iJRvjFSlfYryXUuJPJQn/Vg/nrRBeyXc2+0iduFc6DhY4pdrBmcHDfdYM1oSHUZGnkpLxjJB8PY1OOUnCTEZgvE5dphuoH7ZqFODQBLLd4Iqmt21jP9xdmEGz03ch2ZNSTkqWlnYMA16cx/mPuakgl31pmULixhZB0SaNQCdh/fdL+mZ8JUzbai+JU3D0s4ZM8LYwCfIEKUFwbrxLqE+C92AsGxV7kLeFn/JxUhU=";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PLACEHOLDER_PREFIX = "paste-";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

// ===== Types =====
type FetchDkResponse = {
  encryptedDecryptKey: string;
};

type DecryptKeyFile = {
  address?: string;
  decdata?: string;
  jwk?: crypto.JsonWebKey;
};

type WalletSecret = {
  address: string;
  privateKey: string;
};

// ===== Helpers =====
function hasPlaceholder(v: unknown): boolean {
  return typeof v !== "string" || v.length === 0 || v.startsWith(PLACEHOLDER_PREFIX);
}

function normalizeAddress(address: string): string {
  if (!ETH_ADDRESS.test(address)) {
    throw new Error("Invalid Ethereum address");
  }
  return address.toLowerCase();
}

function ensureConfigured(walletAddress: string, protectKey: string): void {
  if (hasPlaceholder(API_KEY)) throw new Error("Invalid API_KEY");
  if (!BASE_URL.startsWith("http")) throw new Error("Invalid BASE_URL");
  normalizeAddress(walletAddress);

  if (protectKey.length < 4) {
    throw new Error("protectKey too short");
  }

  if (!ETH_ADDRESS.test(walletAddress)) {
    throw new Error("Invalid wallet address");
  }

  if (hasPlaceholder(CIPHERKEY)) {
    throw new Error("Missing CIPHERKEY");
  }
}

function deriveKey(protectKey: string): Buffer {
  return crypto.createHash("sha256").update(protectKey).digest();
}

// ===== AES =====
function aesEncryptUtf8(plaintext: string, protectKey: string): string {
  const key = deriveKey(protectKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

function aesDecryptUtf8(ciphertextB64: string, protectKey: string): string {
  const key = deriveKey(protectKey);
  const buf = Buffer.from(ciphertextB64, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const enc = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(enc),
    decipher.final(),
  ]).toString("utf8");
}

// ===== API =====
async function callFetchDk(
  encryptedWalletAddress: string,
  protectKey: string
): Promise<FetchDkResponse> {
  const res = await fetch(`${BASE_URL}/api/external/fetch-dk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ encryptedWalletAddress, protectKey }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`API error ${res.status}`);
  }

  return json as FetchDkResponse;
}

async function fetchDecryptKeyJson(
  walletAddress: string,
  protectKey: string
): Promise<DecryptKeyFile> {
  const encryptedWalletAddress = aesEncryptUtf8(
    normalizeAddress(walletAddress),
    protectKey
  );

  const res = await callFetchDk(encryptedWalletAddress, protectKey);

  const decrypted = aesDecryptUtf8(res.encryptedDecryptKey, protectKey);
  return JSON.parse(decrypted);
}

// ===== RSA =====
function rsaJwkFromKeyFile(keyFile: DecryptKeyFile): crypto.JsonWebKey {
  if (keyFile.decdata) {
    return JSON.parse(
      Buffer.from(keyFile.decdata, "base64").toString("utf8")
    );
  }
  if (keyFile.jwk) return keyFile.jwk;

  throw new Error("Invalid key file");
}

function rsaDecrypt(ciphertextB64: string, jwk: crypto.JsonWebKey): string {
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });

  const decrypted = crypto.privateDecrypt(
    {
      key,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(ciphertextB64, "base64")
  );

  return decrypted.toString("utf8");
}

// ===== Main =====
export async function fetchThenDecrypt(): Promise<WalletSecret> {
  ensureConfigured(WALLET_ADDRESS, PROTECT_KEY);

  const keyFile = await fetchDecryptKeyJson(
    WALLET_ADDRESS,
    PROTECT_KEY
  );

  const jwk = rsaJwkFromKeyFile(keyFile);
  const decrypted = rsaDecrypt(CIPHERKEY, jwk);

  return JSON.parse(decrypted) as WalletSecret;
}