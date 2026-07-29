# Release and deployment runbook

## 1. Prepare the release

1. Work from a clean branch based on `main`.
2. Update `package.json` and `package-lock.json` to the same semantic version.
3. Move relevant `Unreleased` changelog entries into a dated version heading.
4. Review provider terms, privacy, third-party notices, and public API changes.
5. Run `npm ci` and `npm run release:verify`.
6. Install Chromium and run `npm run smoke:browser`.
7. Complete the [physical-headset checklist](headset-release-checklist.md) for
   rendering, input, tile, or WebXR changes.

`release:verify` runs lint, formatting checks, source/test typechecking, unit
tests, clean app and library builds, browser artifact validation, and npm package
validation. It must pass before tagging or deploying.

## 2. Tag and build artifacts

Commit the release, create an annotated `v<version>` tag, and push commit and
tag. The tag workflow validates that the tag equals `package.json`, reruns all
checks and a Chromium smoke test, then creates:

- the npm package tarball;
- a deployable site tarball containing `release.json` and per-file checksums;
- a CycloneDX production-dependency SBOM;
- SHA-256 checksums for all release assets.

It uploads those files to both the workflow run and the matching GitHub release.
Artifacts can be generated locally after a successful build with:

```bash
npm run release:artifacts
```

An npm registry publication is not yet part of the workflow. Add it only after
registry ownership, provenance, tokenless trusted publishing, and package-name
policy are configured.

## 3. Configure SSH deployment

The deployment script contains no host or key secrets. Set:

```powershell
$env:OPENEARTH_DEPLOY_TARGET = 'deploy@example.org'
$env:OPENEARTH_DEPLOY_ROOT = '/var/www/html' # optional
$env:OPENEARTH_DEPLOY_URL = 'https://dionysus.dk/openearth' # optional
$env:OPENEARTH_SSH_KEY = 'C:\secure\deploy-key' # optional when ssh-agent is used
npm run release
```

The server host key must already be present in `known_hosts`. `-AcceptNewHostKey`
is available for an explicitly reviewed first connection, but pinned host
identity is preferred. The deploy account needs write access only to the live
symlink, deploy lock, and `.openearth-releases` directory.

Apache must also permit the release-local `.htaccess` directives that provide
the CSP, permissions policy, MIME types, and cache rules checked by the release
gate. Do not enable overrides for the entire document root. Install the scoped
[`deploy/apache-openearth.conf`](../deploy/apache-openearth.conf) snippet as an
Apache configuration, enable it, verify `apache2ctl configtest`, and reload
Apache before the first deployment. It grants only `FileInfo`; the snippet
itself disables directory indexes on the live symlink and its immutable release
targets.

## 4. Deployment behavior

The script always runs release verification, creates a release identity, uploads
to a unique staging directory, validates required files and every SHA-256 sum,
then uses a locked symlink swap to activate an immutable release. It requests
`release.json` over HTTPS and automatically restores the previous target if the
health check fails. Four releases are retained by default; use `-Retain` to keep
between two and twenty.

After deployment, manually verify:

- the landing page and Copenhagen view;
- desktop attribution and external provider requests;
- security and cache headers on HTML, hashed assets, Cesium JSON, and workers;
- WebXR entry/exit on the production origin;
- `release.json` matches the intended commit and version.

Never modify an active release directory. Roll back by atomically repointing the
`openearth` symlink to a retained release, then investigate from checksums and
the release manifest.
