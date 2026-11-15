# Publishing the Ruby gems

Nothing has been published. Two gems live here:

| Gem | Directory |
| --- | --- |
| `nanoflags` | `ruby/nanoflags` |
| `nanoflags-openfeature` | `ruby/nanoflags-openfeature` (depends on `nanoflags` ~> 0.1) |

## 1. Prerequisites (founder)

1. **RubyGems.org account** at <https://rubygems.org> with **MFA enabled** — both gemspecs set
   `rubygems_mfa_required`, so pushes require MFA (or a trusted-publishing OIDC token).
2. **Gem names.** Check that <https://rubygems.org/gems/nanoflags> and
   <https://rubygems.org/gems/nanoflags-openfeature> are still free right before the first push; the first push
   claims the name.
3. **Trusted publishing (recommended, no API key).** After the first manual push of each gem (RubyGems requires the
   gem to exist), add a trusted publisher on rubygems.org (gem → Trusted publishers → GitHub Actions) for
   `motazalmaroai/nanoflags-sdk` and a release workflow, then release from a tag with `rubygems/release-gem`.
   Alternatively, a scoped API key (push only, these two gems) stored as a repository secret.

## 2. Releasing a version

1. Bump `NanoFlags::VERSION` (`ruby/nanoflags/lib/nanoflags/version.rb`) or `NanoFlags::OpenFeature::VERSION`, update
   the `CHANGELOG.md` (replace "unreleased" with the date), merge once `Ruby SDK` CI is green.
2. Build and push, SDK first:

   ```sh
   cd ruby/nanoflags && gem build nanoflags.gemspec && gem push nanoflags-0.1.0.gem
   cd ../nanoflags-openfeature && gem build nanoflags-openfeature.gemspec && gem push nanoflags-openfeature-0.1.0.gem
   ```

3. Tag `ruby-v<version>` / `ruby-openfeature-v<version>` for the record.

No workflow in this repository publishes gems; `auto-release.yml` does not look at `ruby/`.
