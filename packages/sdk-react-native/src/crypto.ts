/**
 * Signature primitives for React Native. Hermes has no WebCrypto (no `crypto.subtle`, so neither SHA-256 nor
 * Ed25519), so verification uses the audited pure-JS implementations by Paul Miller — `@noble/ed25519` and
 * `@noble/hashes` (MIT), pinned to exact versions and compiled into this package, so the app's own copies (if any)
 * are never reconfigured.
 */
import { hashes, verify } from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { SignatureCrypto } from "@nanoflags/sdk";

export type { SignatureCrypto } from "@nanoflags/sdk";

/** Pure-JS SHA-256 and Ed25519 (RFC 8032 verification, not the more permissive ZIP-215 rules). */
export const nobleCrypto: SignatureCrypto = Object.freeze({
  sha256: (data: Uint8Array) => sha256(data),
  ed25519Verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
    // Synchronous verification needs a synchronous SHA-512; this is the package's private copy of the library.
    if (!hashes.sha512) hashes.sha512 = sha512;
    try {
      return verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false; // malformed key or signature
    }
  },
});
