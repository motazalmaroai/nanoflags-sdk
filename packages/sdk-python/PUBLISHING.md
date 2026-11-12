# Publishing `nanoflags` to PyPI

Nothing has been published. Releases go out from the public mirror
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk) through **PyPI trusted publishing**
(OIDC from GitHub Actions). That needs no API token, but it does need a one-time setup on the founder's PyPI account.
The name `nanoflags` was free on pypi.org and test.pypi.org on 2026-11-12 (both answered `404`).

## 1. Mirror the package (private monorepo → public repo)

`scripts/export-sdk-repo.sh` does not copy `packages/sdk-python` yet. Proposed change (not applied):

```diff
-#   packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action
+#   packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action
 ...
-dirs=(packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action)
+dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action)
 ...
   rsync -a --delete \
     --exclude node_modules/ \
     --exclude dist/ \
+    --exclude build/ \
+    --exclude __pycache__/ \
+    --exclude '*.py[cod]' \
+    --exclude .pytest_cache/ \
+    --exclude '*.egg-info/' \
+    --exclude .venv/ \
     --exclude coverage/ \
 ...
-echo "scan clean. Next: cd $dest && pnpm install && pnpm build && pnpm typecheck && pnpm test, review git diff, commit."
+echo "scan clean. Next: cd $dest && pnpm install && pnpm build && pnpm typecheck && pnpm test && (cd packages/sdk-python && pip install -e '.[openfeature,test]' && pytest), review git diff, commit."
```

`packages/engine` is mirrored already, so the parity fixtures (`packages/engine/fixtures/parity.json` and its
generator) go with it. The credential scan passes on `packages/sdk-python` and `packages/engine/fixtures` (checked
2026-11-12). No SDK key is stored in the package: `scripts/live_verify.py` and `tests/test_production.py` read
`NANOFLAGS_SDK_KEY` from the environment.

## 2. Workflow in the public repo

Add `.github/workflows/release-python.yml` to `motazalmaroai/nanoflags-sdk`. Root files there are maintained by
hand, and the export script does not touch them. The tag `python-v<version>` cannot collide with the npm workflow's
`sdk-v*`, `openfeature-v*` or `cli-v*` tags.

```yaml
name: Release Python SDK

# tag python-v<version> -> PyPI project `nanoflags` (packages/sdk-python), via trusted publishing (no token).
on:
  push:
    tags: ["python-v*"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Check the tag matches pyproject.toml
        run: |
          version=$(python -c "import tomllib; print(tomllib.load(open('packages/sdk-python/pyproject.toml','rb'))['project']['version'])")
          if [ "$GITHUB_EVENT_NAME" = "push" ] && [ "${GITHUB_REF_NAME#python-v}" != "$version" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match version $version in packages/sdk-python/pyproject.toml"; exit 1
          fi
          if curl -sf "https://pypi.org/pypi/nanoflags/$version/json" > /dev/null; then
            echo "::error::nanoflags $version is already on PyPI. Bump the version."; exit 1
          fi
      - name: Test
        run: |
          python -m pip install --upgrade pip build
          python -m pip install -e "packages/sdk-python[openfeature,test]"
          python -m pytest packages/sdk-python
      - name: Build
        run: python -m build packages/sdk-python --outdir dist
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  publish:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: pypi
      url: https://pypi.org/project/nanoflags/
    permissions:
      id-token: write # trusted publishing
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - uses: pypa/gh-action-pypi-publish@release/v1
```

Optionally, add a matrix job to `ci.yml` so every pull request runs the Python tests on 3.9–3.13:

```yaml
  python:
    name: Python ${{ matrix.python }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        python: ["3.9", "3.10", "3.11", "3.12", "3.13"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: python -m pip install -e "packages/sdk-python[openfeature,test]" && python -m pytest packages/sdk-python
```

## 3. One-time PyPI setup (founder's account)

1. Sign in at https://pypi.org with 2FA enabled. Go to **Your account → Publishing → Add a new pending publisher**
   (a pending publisher is how a project that does not exist yet gets trusted publishing).
2. Choose **GitHub** and enter:
   - PyPI Project Name: `nanoflags`
   - Owner: `motazalmaroai`
   - Repository name: `nanoflags-sdk`
   - Workflow name: `release-python.yml`
   - Environment name: `pypi`
3. In GitHub, open `motazalmaroai/nanoflags-sdk` → **Settings → Environments → New environment** and name it `pypi`.
   Recommended: add yourself under **Required reviewers**, and under **Deployment branches and tags** limit it to
   tags matching `python-v*`.
4. Optional dry run: repeat step 1 on https://test.pypi.org with environment `testpypi`. Then run a copy of the
   workflow whose publish step has `with: { repository-url: "https://test.pypi.org/legacy/" }` and
   `environment: testpypi`, and install the result with
   `pip install -i https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ nanoflags`.

## 4. Release

1. Run the export script (step 1), then review and commit in the public repo.
2. Check that `version` in `packages/sdk-python/pyproject.toml` is the version to release and that `SDK_VERSION` in
   `src/nanoflags/client.py` matches it. Both are `0.1.0` now.
3. `git tag python-v0.1.0 && git push origin python-v0.1.0`, then approve the `pypi` environment deployment.
4. Check the result: `pip install nanoflags==0.1.0 && python -c "import nanoflags; print(nanoflags.__version__)"`.

After the first upload the pending publisher becomes a normal trusted publisher on the project. Later releases only
repeat step 4.
