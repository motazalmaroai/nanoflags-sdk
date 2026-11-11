# Security policy

## Reporting a vulnerability

Please report security vulnerabilities by e-mail to **support@nanoflags.io**.

**Do not open a public GitHub issue, discussion or pull request for a vulnerability.** Public reports put
NanoFlags users at risk before a fix is available.

Include, as far as you can:

- the affected package(s) and version(s) (`@nanoflags/sdk`, `@nanoflags/openfeature-provider`, `@nanoflags/cli`,
  the GitHub Action, or the engine);
- a description of the issue and its impact;
- steps or a minimal proof of concept to reproduce it;
- whether the issue is already known to others.

We will acknowledge your report, keep you informed while we investigate, and credit you in the release notes
if you wish. Please give us reasonable time to release a fix before any public disclosure.

## Supported versions

Security fixes are made for the latest published minor version of each package.

## Keys

Never include real NanoFlags keys (`nf_srv_…`, `nf_pub_…`, `nf_ci_…`, `nf_adm_…`) or test-session tokens in
issues, pull requests, logs or test fixtures. If a key was exposed, revoke it in the dashboard
(Project settings → Keys) and create a new one.
