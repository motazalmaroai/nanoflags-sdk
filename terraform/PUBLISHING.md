# Publishing the Terraform provider

The Terraform Registry only publishes providers from a **public GitHub repository named
`terraform-provider-<name>`**, from GitHub releases on **`v<semver>` tags** that carry the zipped binaries, a
`SHA256SUMS` file, its detached GPG signature and the registry manifest. The provider lives in `terraform/` of this
repository, so it is published through a mirror, the same way the PHP packages are.

## How a release works

1. Add a dated entry to `terraform/CHANGELOG.md`, e.g. `## 0.1.0 (2026-12-01)`, and merge it.
2. Push the tag `terraform-v0.1.0` on that commit of `main`.
3. `.github/workflows/terraform.yml` tests the provider, then
   - splits `terraform/` into the mirror's `main` branch (force push: the mirror is generated, never edited) and tags
     it `v0.1.0`;
   - runs GoReleaser (`terraform/.goreleaser.yml`) in a checkout of the mirror: it builds every platform, signs
     `SHA256SUMS` with the GPG key and creates the GitHub release `v0.1.0` on the mirror;
   - the Registry sees the release through its webhook and publishes `nanoflags/nanoflags` 0.1.0 within minutes.

Until the secrets below exist, the tag only runs the tests and leaves a notice. Pushes and pull requests never publish.

## One-time setup (founder)

1. **Create the mirror repository** `motazalmaroai/terraform-provider-nanoflags` (public, empty, no README). Its
   description can say "Generated from nanoflags-sdk/terraform; open issues and pull requests there". Another owner
   or name works if it starts with `terraform-provider-`: set the repository variable `TERRAFORM_PROVIDER_REPO`
   (e.g. `nanoflags/terraform-provider-nanoflags`) in this repository. If the owner changes, also change the module
   path in `terraform/go.mod` and the imports to match.
2. **Create an RSA GPG signing key** (4096 bits) used only for provider releases; Terraform verifies RSA signatures
   on every version:
   ```sh
   gpg --full-generate-key                      # RSA and RSA, 4096 bits, name "NanoFlags releases", support@nanoflags.io
   gpg --armor --export-secret-keys <KEY_ID>    # -> secret GPG_PRIVATE_KEY
   gpg --armor --export <KEY_ID>                # -> public key for the Registry (step 5)
   ```
   Keep an offline backup of the key; the Registry verifies every future release with it.
3. **Create a fine-grained personal access token** limited to the mirror repository with *Contents: read and
   write* (it pushes the split, the tag and creates the release).
4. **Add an environment `terraform-registry`** in this repository (Settings → Environments; optionally with required
   reviewers) with the secrets `TERRAFORM_MIRROR_TOKEN`, `GPG_PRIVATE_KEY` and `GPG_PASSPHRASE`.
5. **Sign in to registry.terraform.io with the GitHub account that owns the mirror**, then:
   - User settings → Signing keys → add the ASCII-armored *public* key for the namespace (`motazalmaroai`, or the
     organization that owns the mirror);
   - Publish → Provider → choose `terraform-provider-nanoflags`. The Registry installs its webhook on the repository.
   The provider address is `<namespace>/nanoflags`. The examples and docs use `nanoflags/nanoflags`, which requires
   the mirror to live in a GitHub organization named `nanoflags`; with a personal namespace, replace `nanoflags/` with
   `motazalmaroai/` in `examples/`, `templates/`, `main.go` (`Address`) and regenerate the docs (`go generate ./...`).
6. Push the first tag `terraform-v0.1.0`. The Registry can take a few minutes to show it; later releases are picked up
   automatically.

## Alternative: a separate repository

Instead of mirroring, the provider can be moved to its own repository `terraform-provider-nanoflags`: copy
`terraform/` to the repository root, move the `release` job of `.github/workflows/terraform.yml` into that repository
(without the split step; checkout the tag itself), and tag `v<version>` there. This keeps one source of truth but
loses the shared CI and history of this repository; the mirror is the default.

## Notes

- Do not edit the mirror directly; the next release overwrites its `main`.
- A release cannot be replaced on the Registry: bump the version for any fix.
- The version printed by the provider comes from the tag (`-X main.version`).
