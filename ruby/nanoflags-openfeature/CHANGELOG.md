# Changelog

## 0.2.0 (2026-11-18)

- Requires the `nanoflags` gem ~> 0.2 (test sessions).

- Documented and tested test sessions through `evaluator: -> { NanoFlags.flags_for(client) }` (needs the `nanoflags`
  release with test sessions).

## 0.1.0 (2026-11-18)

First release of `nanoflags-openfeature`: an OpenFeature (openfeature-sdk >= 0.4) provider backed by the `nanoflags`
gem 0.1. Targeting key → `key`; reasons `DISABLED`, `DEFAULT`, `TARGETING_MATCH`, `SPLIT` (variant = rule id); errors
`FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`, `TYPE_MISMATCH`, `GENERAL`; the revision as flag metadata; provider events for
configuration changes and status.
