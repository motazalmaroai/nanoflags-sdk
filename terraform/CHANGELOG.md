# Changelog

## 0.1.0 (unreleased)

First release of the NanoFlags Terraform provider.

- Resources: `nanoflags_flag`, `nanoflags_flag_environment` (enabled, default and off values, rules with conditions,
  fixed values and percentage rollouts), `nanoflags_segment`, `nanoflags_environment_publish`,
  `nanoflags_slack_destination`.
- Data sources: `nanoflags_project`, `nanoflags_environment`, `nanoflags_environments`, `nanoflags_flag`,
  `nanoflags_sdk_keys`.
- Import for every resource; plan-time validation of keys, JSON values, value types, rules and conditions.
