# Security policy

## Supported versions

Security fixes are applied to the latest released minor version and the live
deployment at <https://dionysus.dk/openearth/>. Older releases are not promised
security updates.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/kblood/openearth-xr/security/advisories/new>

Please include affected versions, reproduction steps, impact, and any suggested
mitigation. Do not include secrets, private tile data, access tokens, or personal
location history in a public issue. Allow reasonable time to investigate and
ship a coordinated fix before public disclosure.

## Security boundaries

OpenEarth renders network and host-supplied map data in the browser. Applications
embedding the package are responsible for trusting their configured providers,
protecting provider credentials outside client bundles, constraining offline
bundle imports, and configuring a Content Security Policy compatible with their
own endpoints. The public site does not require an account and intentionally has
no analytics.

The deployment defaults and verification steps are documented in
[the release runbook](docs/releasing.md). Dependency audit results are useful
signals, not a substitute for review of WebGL/WebXR, parsers, deployment, and
provider behavior.

The public site's `script-src` is restricted to same-origin scripts but includes
`'unsafe-eval'`. Cesium's bundled Viewer/Knockout runtime evaluates generated
bindings, and its WebAssembly decoders require runtime compilation. The release
browser probe exercises the exact policy. Removing this exception requires a
future widgetless Cesium integration or an upstream runtime that does not use
string evaluation; keep external script origins and `'unsafe-inline'` excluded.
