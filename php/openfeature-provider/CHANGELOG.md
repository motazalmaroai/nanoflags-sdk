# Changelog

## 0.3.0 (2026-11-21)

- Requires `nanoflags/nanoflags` ^0.3 (version and date operators). Composer's `^0.2` excluded 0.3.0. No code changes.

## 0.2.0 (2026-11-18)

- Requires `nanoflags/nanoflags` ^0.2 (test sessions).

- Documented test sessions through the `$evaluator` argument (`fn () => $flags->sessionFromGlobals()`).

## 0.1.0 (2026-11-18)

First release of `nanoflags/openfeature-provider`: an OpenFeature (open-feature/sdk 2.x) provider backed by
`nanoflags/nanoflags` 0.1. Targeting key → `key`; reasons `DISABLED`, `DEFAULT`, `TARGETING_MATCH`, `SPLIT` (variant =
rule id); errors `FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`, `TYPE_MISMATCH`, `GENERAL`; the revision as flag metadata.
