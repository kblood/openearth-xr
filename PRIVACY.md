# Privacy

OpenEarth XR does not create accounts, set application cookies, collect
analytics, or send telemetry. It stores interface preferences and bookmarks on
the device, caches the same-origin application shell, and requests browser
geolocation only after the user selects **Locate me**. Map and search providers
can still observe ordinary request metadata—including IP address, browser
headers, referring origin, requested tile coordinates or search text, and
time—which can reveal the area being viewed or searched.

## Network services used by the standalone site

| Purpose               | Default service                          | Requests begin                      |
| --------------------- | ---------------------------------------- | ----------------------------------- |
| Desktop raster map    | `tile.openstreetmap.org`                 | When the viewer starts              |
| Immersive raster map  | CARTO Voyager at `basemaps.cartocdn.com` | On first XR or preview use          |
| 3D building vectors   | `tiles.openfreemap.org`                  | Near city/street altitude           |
| Optional place search | `nominatim.openstreetmap.org`            | After opt-in and a submitted search |

Those services operate under their own privacy and retention policies. OpenEarth
does not receive their server logs. The live host receives standard web-server
requests for the application and its static assets.

Online Nominatim search is off by default. Enabling it stores that preference
on the device. The first occurrence of a submitted query is sent to the public
Nominatim service; up to 100 normalized results are kept in memory for reuse in
that page session and are discarded on reload. Built-in place and coordinate
searches remain local. OpenEarth does not implement search-as-you-type requests.

## Location permission and local storage

Selecting **Locate me** asks the browser for a one-time position. OpenEarth uses
the returned coordinates and accuracy only to move the local camera; it does
not send a separate location request to the OpenEarth host. The browser or
operating system may use its own location service. After the camera moves, map
tile coordinates requested from the configured providers can reveal the viewed
area.

The standalone app uses browser `localStorage` for bookmarks and the selected
language, VR comfort/quality settings, and online-search preference. Its service
worker uses Cache Storage for same-origin HTML, JavaScript, CSS, icons, and
Cesium runtime assets so the installed shell can start offline. It deliberately
does not cache third-party map, search, or building responses. Clearing site
data in the browser removes these local values and cached app files.

The library exports opt-in persistent raster-cache and OpenMaps store adapters,
but the standalone site does not use them for public provider tiles. An
embedding application that enables persistent map storage must disclose its
quota, retention, clearing controls, provider terms, and any additional network
services in its own privacy information.

## Embedding and private/offline use

Hosts can replace desktop imagery with `imageryProvider`/`imageryUrl`, immersive
rasters with `xrTileProvider`, and buildings with `buildingProvider`. Pass
`buildingProvider: null` to prevent the default OpenFreeMap building requests.
Supplying only a custom desktop provider does **not** replace the independent XR
or building defaults.

For a no-third-party deployment, self-host all three data providers and set a
Content Security Policy that allows only those origins. The interface uses a
system font stack and does not require a font CDN. Offline providers should
return fresh `ImageBitmap` objects because OpenEarth consumes and closes each
returned bitmap.

See [provider and licence guidance](docs/providers-and-licenses.md) before
downloading or redistributing map data. In particular, the public OpenStreetMap
raster service does not permit bulk download or offline packs.

## Changes

Changes that add telemetry, persistent identifiers, storage, permissions, or new
network services must update this document and the release changelog before
deployment.
