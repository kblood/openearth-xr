# Testing strategy

## Local quality gate

`npm run check` is the required deterministic gate. It includes lint, formatting,
source and test typechecking, Vitest, clean application and library builds,
distribution checks, and an npm dry-pack inspection.

The package check verifies licences, notices, every root/subpath ESM and type
entry, resolvable source maps, source files, browser-asset isolation, and package
size. The distribution check verifies relative subpath-safe assets, Cesium
runtime files, legal notices, and an initial JavaScript budget.

## Browser smoke

After installing Chromium with `npx playwright install chromium`, run
`npm run smoke:browser`. It serves `dist`, opens Copenhagen in a real headless
browser, waits for Cesium's visible canvas, exercises place/reset controls, and
fails on uncaught page errors. It also opens a deterministic orbital XR preview
and verifies that the WebGL canvas produces non-uniform pixels. This catches
immersive-renderer startup failures without claiming to emulate a headset or
requiring a public tile request to succeed. The local preview applies the exact
CSP extracted from `deploy/.htaccess`. Set `OPENEARTH_SMOKE_BASE_URL` to an
already-built HTTPS deployment to test that origin instead. CI runs the local
probe independently of unit tests, and the deployment gate runs it against the
newly activated release before accepting the symlink swap.

## Automated coverage and remaining hardware work

The deterministic suite covers provider/manifest validation, regional routing,
TileJSON resolution, malformed and oversized vectors, abort and retry behavior,
cache eviction and corruption, partial-atlas preservation, multi-LOD selection,
building density/geometry, geodetic handedness, application features, sky
geometry, and package consumption through every public subpath. The Chromium
probe exercises desktop startup and the non-headset XR preview path.

Browser automation still cannot prove controller-profile mappings, session
interruption behavior, stereoscopic depth, real compositor timing, comfort, or
minimum-clearance feel. Add emulator-level session tests when a stable WebXR
test runtime is available, and keep the physical checks below as the release
gate for renderer/input changes.

Headless emulation supplements but does not replace the
[physical-headset checklist](headset-release-checklist.md).
