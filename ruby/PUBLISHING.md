# Publishing the Ruby gems

Two gems live here, both on RubyGems.org:

| Gem | Directory | Version file | Release tag |
| --- | --- | --- | --- |
| `nanoflags` | `ruby/nanoflags` | `lib/nanoflags/version.rb` | `ruby-nanoflags-v<version>` |
| `nanoflags-openfeature` | `ruby/nanoflags-openfeature` (depends on `nanoflags` ~> 0.1) | `lib/nanoflags/openfeature/version.rb` | `ruby-nanoflags-openfeature-v<version>` |

Releases are automatic and use **RubyGems Trusted Publishing** (OIDC): no API key is stored anywhere.

1. `auto-release.yml` runs on every push to `main`. For each gem (`nanoflags` first) it reads `VERSION` from the
   version file and asks <https://rubygems.org/api/v1/versions/GEM.json> whether that version exists. If it does
   not, it pushes the tag `ruby-<gem>-v<version>` with the `RELEASE_TAG_TOKEN` secret (tags pushed with the workflow's
   own token start no workflow), unless that tag already exists.
2. The tag starts `release-ruby.yml` in the environment `rubygems`, which waits for the founder's approval. The job
   checks that the tag matches the version file, skips (successfully) if the version is already on rubygems.org,
   runs the gem's test suite (unit, engine parity incl. `extra.json`, local HTTP/WebSocket, fork safety), builds the
   gem, exchanges the job's OIDC token for a short-lived RubyGems API key
   (`rubygems/configure-rubygems-credentials`, pinned by commit) and runs `gem push`.
3. Releases run one at a time in push order, so `nanoflags` is published before `nanoflags-openfeature`.

## Founder: one-time setup

1. **RubyGems.org account** with **MFA enabled** (both gemspecs set `rubygems_mfa_required`; Trusted Publishing
   satisfies it without an OTP).
2. **Trusted publisher, for each gem** (`nanoflags` and `nanoflags-openfeature`): on rubygems.org open the gem →
   **Trusted publishers** (gem page sidebar, or *Edit* → *Trusted publishers*) → **Create** → **GitHub Actions**:

   | Field | Value |
   | --- | --- |
   | Repository owner | `motazalmaroai` |
   | Repository name | `nanoflags-sdk` |
   | Workflow filename | `release-ruby.yml` |
   | Environment | `rubygems` |

3. **GitHub environment** `rubygems`: repository → *Settings* → *Environments* → *New environment* `rubygems` →
   enable **Required reviewers** and add yourself. Leave *Prevent self-review* off (the tags are pushed with your
   `RELEASE_TAG_TOKEN`, so you count as the one who triggered the run). Optionally restrict *Deployment branches and
   tags* to *Selected* with the tag rules `ruby-nanoflags-v*` and `ruby-nanoflags-openfeature-v*`. No secrets go
   into it.
4. **`RELEASE_TAG_TOKEN`** (already used for pub.dev and NuGet): a fine-grained token limited to this repository with
   *Contents: read and write*, as a repository secret. Without it `auto-release.yml` only prints a notice.

## Releasing a version

1. Bump `NanoFlags::VERSION` (`ruby/nanoflags/lib/nanoflags/version.rb`) and/or `NanoFlags::OpenFeature::VERSION`, move
   the `CHANGELOG.md` entries from "Unreleased" to the new version with the date, and if the provider needs the new
   SDK, raise its `nanoflags` dependency in `nanoflags-openfeature.gemspec`. Merge once `Ruby SDK` CI is green.
2. Approve the `rubygems` deployment of each `release-ruby.yml` run (Actions tab, or the e-mail GitHub sends).
3. A failed or rejected release keeps its tag, and `auto-release.yml` then skips that version. To retry, delete the tag
   (`git push origin :refs/tags/ruby-nanoflags-v<version>`) and re-run `auto-release.yml`, or re-run the failed
   `release-ruby.yml` run.

## Manual fallback

If Trusted Publishing is unavailable, build and push by hand (MFA OTP required), SDK first:

```sh
cd ruby/nanoflags && gem build nanoflags.gemspec && gem push nanoflags-<version>.gem
cd ../nanoflags-openfeature && gem build nanoflags-openfeature.gemspec && gem push nanoflags-openfeature-<version>.gem
```

and push the matching tag afterwards (`release-ruby.yml` sees the version is published and skips).
