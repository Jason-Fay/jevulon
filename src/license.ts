/**
 * Offline entitlement for gated JEVULON VII features (the Pro code-review sieve and successors).
 *
 * A license token is an Ed25519-signed claim envelope, `jvii_lic.<claims>.<signature>`, where
 * `<claims>` is base64url JSON. The signing key lives only with the fulfillment service (see the
 * minting script in the private repository); this module ships just the verifying key, so nothing
 * inside the npm package can issue or extend a license.
 *
 * Verification is deliberately offline: a paid seat must keep working in zero-egress deployments
 * (Zero-Scraping Privacy Mode, the self-hosted tier), so entitlement cannot require a phone-home.
 * The honest limits of that choice: a determined user can patch a local check, which is the same
 * enforcement class as every offline-licensed developer tool. Server-backed features must still
 * re-check the tenant tier where the server holds the truth.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export type LicenseTier = "free" | "pro" | "team" | "enterprise" | "admin";

export const LICENSE_TIERS: readonly LicenseTier[] = ["free", "pro", "team", "enterprise", "admin"];

/** Everything a license asserts. `exp`/`iat` are epoch milliseconds. */
export interface LicenseClaims {
  v: 1;
  /** Licensee label — the tenant slug or buyer reference shown in the activation mail. */
  sub: string;
  tier: LicenseTier;
  /** Features this seat bought, e.g. `["sieve"]`. Enforcement keys off features, not tiers. */
  features: readonly string[];
  seats: number;
  iat: number;
  exp: number;
  /** Order or tenant reference for support and revocation lookups. */
  ref: string;
}

export type LicenseErrorCode =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "missing_feature";

/** Raised for every entitlement failure; `code` lets callers branch without string matching. */
export class LicenseError extends Error {
  constructor(
    public code: LicenseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

export const LICENSE_TOKEN_PREFIX = "jvii_lic.";

/** JEVULON VII license verifying key (Ed25519, SPKI PEM). The matching private key never ships. */
export const LICENSE_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEA50/O8CRahQFSdJINz7n83oWIMtf7nIRP1XuaGFZ+A2E=",
  "-----END PUBLIC KEY-----",
].join("\n");

export interface VerifyLicenseOptions {
  /** Alternate verifying key — key rotation and tests; defaults to the embedded issuing key. */
  publicKeyPem?: string;
  /** Evaluation clock in epoch milliseconds; defaults to now. */
  now?: number;
}

function parseClaims(payload: string): LicenseClaims {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new LicenseError("malformed", "license claims are not base64url-encoded JSON");
  }
  const c = claims as Partial<LicenseClaims> | null;
  const shapeOk =
    c !== null &&
    typeof c === "object" &&
    c.v === 1 &&
    typeof c.sub === "string" &&
    typeof c.tier === "string" &&
    LICENSE_TIERS.includes(c.tier as LicenseTier) &&
    Array.isArray(c.features) &&
    c.features.every((feature) => typeof feature === "string") &&
    typeof c.seats === "number" &&
    typeof c.iat === "number" &&
    typeof c.exp === "number" &&
    typeof c.ref === "string";
  if (!shapeOk) throw new LicenseError("malformed", "license claims do not match the expected shape");
  return c as LicenseClaims;
}

/** Signs a claim envelope into a token. Only the fulfillment service holds a signing key. */
export function mintLicense(claims: LicenseClaims, signingKeyPem: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signed = `${LICENSE_TOKEN_PREFIX}${payload}`;
  const key: KeyObject = createPrivateKey(signingKeyPem);
  const signature = sign(null, Buffer.from(signed, "utf8"), key).toString("base64url");
  return `${signed}.${signature}`;
}

/**
 * Verifies a token end to end: envelope shape, signature, expiry.
 * Throws {@link LicenseError}; never fails open.
 */
export function verifyLicense(token: string | undefined | null, options: VerifyLicenseOptions = {}): LicenseClaims {
  const raw = token?.trim();
  if (!raw) {
    throw new LicenseError("missing", "no license token found — set JVII_TOKEN to your JEVULON VII license token");
  }
  const parts = raw.split(".");
  if (parts.length !== 3 || `${parts[0]}.` !== LICENSE_TOKEN_PREFIX) {
    throw new LicenseError("malformed", "token is not a jvii_lic.<claims>.<signature> envelope");
  }
  const claims = parseClaims(parts[1]);
  const key = createPublicKey(options.publicKeyPem ?? LICENSE_PUBLIC_KEY_PEM);
  const signatureOk = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    key,
    Buffer.from(parts[2], "base64url")
  );
  if (!signatureOk) {
    throw new LicenseError("bad_signature", "license signature does not verify against the JEVULON VII issuing key");
  }
  const now = options.now ?? Date.now();
  if (claims.exp <= now) {
    throw new LicenseError("expired", `license expired on ${new Date(claims.exp).toISOString()}`);
  }
  return claims;
}

/** Asserts the claims carry `feature`; returns the claims so callers can log tier/seat context. */
export function requireFeature(claims: LicenseClaims, feature: string): LicenseClaims {
  if (!claims.features.includes(feature)) {
    throw new LicenseError("missing_feature", `license for ${claims.sub} (tier ${claims.tier}) does not include the '${feature}' feature`);
  }
  return claims;
}

/** The gate every feature entry point calls: verify the token, then assert the feature. */
export function requireLicensedFeature(
  token: string | undefined | null,
  feature: string,
  options: VerifyLicenseOptions = {}
): LicenseClaims {
  return requireFeature(verifyLicense(token, options), feature);
}
