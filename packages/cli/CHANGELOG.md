# Changelog

## 0.4.0 (2026-11-19)

Additive, no breaking changes.

- Co-signing: `nanoflags keygen` creates an Ed25519 co-signing key; `nanoflags sign` co-signs the revision the next
  publish would create (computed and checked locally; `--expect` / `--expect-checksum` refuse to sign a draft that
  differs from the one your pipeline reviewed); `nanoflags publish --cosign <file>` publishes with that co-signature,
  and `--change <id>` publishes an approved change on a co-signed environment. New `COSIGN_REQUIRED`,
  `COSIGN_INVALID` and `APPROVAL_REQUIRED` error explanations.
- Transparency log: `nanoflags log verify` downloads an environment's publish history and verifies it locally (signed
  tree head, every entry, consistency with the head saved in `--state`); `nanoflags log monitor` is the light one-shot
  check for scheduled CI jobs. `--public-keys` pins NanoFlags' signing keys.
- Import: `--format statsig`, and `nanoflags import verify` compares the source's evaluation with the NanoFlags engine
  on your sample contexts before you switch (dry run, nothing is written).
