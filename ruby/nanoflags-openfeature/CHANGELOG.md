# Changelog

## 0.1.0 (unreleased)

First release of `nanoflags-openfeature`: an OpenFeature (openfeature-sdk >= 0.4) provider backed by the `nanoflags`
gem 0.1. Targeting key → `key`; reasons `DISABLED`, `DEFAULT`, `TARGETING_MATCH`, `SPLIT` (variant = rule id); errors
`FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`, `TYPE_MISMATCH`, `GENERAL`; the revision as flag metadata; provider events for
configuration changes and status.
