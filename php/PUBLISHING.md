# Publishing the PHP packages

Nothing has been published. Two Composer packages live here:

| Package | Directory |
| --- | --- |
| `nanoflags/nanoflags` | `php/nanoflags` |
| `nanoflags/openfeature-provider` | `php/openfeature-provider` (requires `nanoflags/nanoflags` ^0.1) |

## 1. Prerequisites (founder)

1. **Packagist account** at <https://packagist.org> (sign in with the GitHub account that owns
   `motazalmaroai/nanoflags-sdk`, enable two-factor authentication).
2. **Vendor name `nanoflags`.** A vendor is claimed by publishing the first package under it. Check that
   <https://packagist.org/packages/nanoflags/> is still free right before the first submission.
3. **One Git repository per package.** Packagist reads `composer.json` from the root of a repository; it cannot
   publish a package from a subdirectory of this monorepo. Create two public read-only mirrors, for example
   `motazalmaroai/nanoflags-php` and `motazalmaroai/nanoflags-php-openfeature`, and keep them in sync from this
   repository with a subtree split (e.g. `git subtree split --prefix php/nanoflags -b php-split` and push it, or the
   `symplify/monorepo-split-github-action` in a workflow). The split needs a token with write access to the mirrors
   (a fine-grained token limited to those two repositories, stored as a secret of this repository).
4. **Submit** each mirror once on Packagist (Submit → repository URL) and enable the GitHub hook (Packagist's GitHub
   integration) so new tags are picked up automatically.

## 2. Releasing a version

Composer versions come from Git tags of the mirrors (`composer.json` carries no version):

1. Update `CHANGELOG.md` (replace "unreleased" with the date) in a pull request; merge once `PHP SDK` CI is green.
2. Split, then tag the mirror: `v0.1.0` on `nanoflags-php` first, then `v0.1.0` on `nanoflags-php-openfeature`
   (its `nanoflags/nanoflags: ^0.1` constraint needs the SDK on Packagist first).
3. Packagist updates within a minute through the hook. Verify with `composer require nanoflags/nanoflags:^0.1` in an
   empty project.

No workflow in this repository publishes PHP packages; `auto-release.yml` does not look at `php/`.
