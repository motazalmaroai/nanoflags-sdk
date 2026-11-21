# Changelog

## 0.1.0 (unreleased)

First release of the NanoFlags Terraform provider.

- `op` accepts the version operators `semver_eq`, `semver_neq`, `semver_gt`, `semver_gte`, `semver_lt`, `semver_lte`
  (value: a version string) and the date operators `before` / `after` (value: a date string or a Unix timestamp), and
  plans warn when `gt` / `gte` / `lt` / `lte` compare something that looks like a version.
- Resources: `nanoflags_flag`, `nanoflags_flag_environment` (enabled, default and off values, rules with conditions,
  fixed values and percentage rollouts), `nanoflags_segment`, `nanoflags_environment_publish`,
  `nanoflags_slack_destination`.
- Data sources: `nanoflags_project`, `nanoflags_environment`, `nanoflags_environments`, `nanoflags_flag`,
  `nanoflags_sdk_keys`.
- Import for every resource; plan-time validation of keys, JSON values, value types, rules and conditions.
