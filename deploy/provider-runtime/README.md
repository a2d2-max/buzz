# A2D2 provider source kit

This directory keeps the A2D2 changes to Plane and AFFiNE reproducible without
vendoring either upstream repository. The patches apply to the exact upstream
commits in `sources.lock.json`. Runtime credentials, environment files, image
archives, build logs, and rollout evidence are deliberately excluded.

## Contents

- `patches/plane-a2d2.patch` — the complete tracked and required untracked A2D2
  delta for Plane.
- `patches/affine-a2d2.patch` — the complete tracked and required untracked A2D2
  delta for AFFiNE.
- `sources.lock.json` — upstream commits, patch/source digests, accepted image
  witnesses, and the names and relationships of required environment inputs.
- `scripts/apply-source-patches.sh` — fail-closed patch application to clean,
  exact-base checkouts.
- `scripts/verify-provider-kit.py` — patch and post-apply source verification.
- `scripts/build-provider-images.sh` — Linux amd64 image/archive build recipe.

## Prepare exact source

Start with clean checkouts at the locked commits. The apply script refuses a
different commit or an already dirty checkout.

```sh
deploy/provider-runtime/scripts/apply-source-patches.sh \
  /path/to/plane /path/to/affine
```

It verifies each patch hash before mutation, applies both patches, and then
requires the complete changed-file set, byte hashes, modes, and aggregate source
digest to match `sources.lock.json`. Both checkouts are validated before either
is changed. An unexpected write-time failure remains visible; the script never
resets either checkout. A later invocation recognizes an exact already-applied
provider patch and completes only the missing provider, so the partial operation
has an idempotent recovery path. Any other dirty state fails closed.

To verify already-patched checkouts without changing them:

```sh
python3 deploy/provider-runtime/scripts/verify-provider-kit.py \
  --plane-checkout /path/to/plane \
  --affine-checkout /path/to/affine
```

## Build images

The build recipe requires the verified patched source and a Docker Buildx
builder capable of Linux amd64 builds. It never starts containers or changes a
runtime deployment.

```sh
deploy/provider-runtime/scripts/build-provider-images.sh \
  /path/to/plane /path/to/affine /private/output
```

Plane is built from `apps/api/Dockerfile.api` with `apps/api` as its context.
The recipe first copies that reviewed Dockerfile to the private output and pins
its accepted Linux amd64 Python base digest; the source checkout is unchanged.
AFFiNE uses the patch-owned `deploy/a2d2/build-managed-image.sh`, including its
pinned base image and native-addon checks. The output records image IDs,
platforms, source delta digests, and archive SHA-256 values. Rebuilds must not
assume a new local image ID is the accepted production image; compare and
review the new result explicitly. It also writes exact, secret-free Plane and
AFFiNE image override files under `runtime-overrides/`.

To regenerate overrides for the already accepted images without rebuilding or
loading anything:

```sh
deploy/provider-runtime/scripts/build-provider-images.sh \
  --accepted-overrides /private/provider-overrides
```

The output binds the same Plane image to `api`, `worker`, and `beat-worker` and
the accepted AFFiNE image to `affine`. It is an input to the guarded apply flow,
not permission to run Compose directly.

## Runtime apply contract

The provider-owned Compose files introduced by the patches are the source
recipe. A live update must render them with the existing protected environment
files and append only the generated exact image overrides. Before mutation, capture the
complete current container semantics, migration sets, authority/data state,
and public health. Arm rollback before each Compose recreation. Candidate and
rollback paths must both satisfy these gates:

1. `BUZZ_AUTO_MIGRATE=false`; no implicit SQLx, Django, or Prisma migration.
2. Exact pre/post migration version, success, and checksum sets are equal.
3. Only the three Plane service image values (`api`, `worker`, `beat-worker`)
   and the AFFiNE application image value may change. All other environment,
   labels, HostConfig, network names, and aliases remain equal.
4. Plane and AFFiNE managed-auth inputs are injected from mode-0600 files. The
   key relationships in `sources.lock.json` are checked by fingerprints; secret
   values are never printed or committed.
5. The Plane API, worker, and beat use the same exact image. The AFFiNE service
   uses its one exact image. Loaded image platform is `linux/amd64`.
6. Private readiness, authority/data preservation, and projection convergence
   (`pending=0`, `errors=0`) pass before public readiness.
7. Public readiness has an absolute 300-second deadline, preserves every
   existing Buzz/Max health endpoint on every sample, and requires two
   consecutive meaningful Plane and AFFiNE responses.
8. A failure recreates the captured old exact images and rechecks the same
   semantic, migration, authority/data, projection, and public gates. It does
   not delete databases, volumes, projection rows, or provider data.

The accepted runtime image and archive witnesses are recorded in
`sources.lock.json`. They are evidence pins, not blobs stored in this repository.
The historical build-manifest hashes are retained only as witnesses for those
accepted images. A clean reproduction is bound by the exact upstream commit,
patch hash, changed-file records, and aggregate source delta; it intentionally
does not recreate local caches or test output that may have existed beside the
original build checkout.
Signed desktop Plane/AFFiNE CRUD and reopen acceptance remains a separate gate;
container health alone is insufficient.

The accepted Plane runtime witness covers the `apps/api` Docker context only.
The Plane patch also preserves the reviewed web, live, test, and deployment
source delta needed by the full integration; those files are not implied to be
inside the backend image. Historical status paragraphs inside the upstream
deployment overlay describe the earlier bring-up and do not supersede the pins
or runtime contract in this directory.

## Secrets and generated data

Commit only the example files in the provider patches. Never add real `.env` or
`.env.remote` files, broker keys, service tokens, private keys, image archives,
Docker exports, databases, logs, or rollout evidence. The verifier rejects
common private-key and credential-literal patterns in this kit.
