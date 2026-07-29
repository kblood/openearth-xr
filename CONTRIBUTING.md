# Contributing to OpenEarth XR

Thanks for helping build an open Earth viewer. Small, reviewable changes with a
clear compatibility story are easiest to maintain.

## Development setup

Use Node.js 22.13 or newer and npm. A clean setup is:

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run check
```

This lints and formats-checks the repository, typechecks source and tests, runs
unit tests, builds the standalone site and library from clean directories,
validates the browser distribution, and dry-packs the npm package. To run the
real Chromium smoke test as well:

```bash
npx playwright install chromium
npm run smoke:browser
```

## Change expectations

- Keep provider behavior replaceable and avoid introducing mandatory tokens or
  proprietary services.
- Preserve geographic conventions across Cesium and Three.js render paths.
- Add deterministic tests for coordinate, lifecycle, cache, and provider logic.
- Test WebXR/input changes in a physical headset using the
  [headset checklist](docs/headset-release-checklist.md).
- Update API docs, data attribution, privacy notes, and `CHANGELOG.md` whenever
  behavior or external requests change.
- Never add captured tile data without confirming redistribution rights.

Generated screenshots, traces, and headset captures belong in the ignored
`artifacts/` directory. Intentional visual regression fixtures should be small,
documented, and committed under a dedicated fixture directory.

## Pull requests

Explain the user outcome, affected browsers/headsets/providers, and verification
performed. Do not combine unrelated formatting or refactors with behavior
changes. Security reports should follow [SECURITY.md](SECURITY.md), not a public
issue.
