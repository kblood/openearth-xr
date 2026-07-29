# Providers, attribution, and licence operations

OpenEarth separates rendering from data providers. Every deployment must show
credits for every visible layer and confirm that its request, caching, offline,
and redistribution behavior is permitted by each provider.

## Standalone defaults

### OpenStreetMap raster tiles

The desktop default requests `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
Show a visible link reading **© OpenStreetMap contributors** and linking to
<https://www.openstreetmap.org/copyright>.

The OpenStreetMap Foundation's
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requires visible attribution, valid browser identification/referrer behavior,
and normal HTTP caching. It prohibits bulk download and offline packs from this
community service. Offline OpenMaps regions must use a provider or self-hosted
dataset whose terms explicitly allow that use.

### CARTO Voyager

The immersive default requests CARTO Voyager raster tiles. Show links for
**© OpenStreetMap contributors** and **© CARTO**. CARTO's current attribution
guidance is at <https://carto.com/attribution/>. Do not assume the public endpoint
has an availability SLA suitable for a paid or safety-critical product.

### OpenFreeMap buildings

The default building layer resolves OpenFreeMap TileJSON and streams the
OpenMapTiles `building` layer. OpenFreeMap asks non-MapLibre clients to display:

> OpenFreeMap © OpenMapTiles Data from OpenStreetMap

Link the names to <https://openfreemap.org/>, <https://openmaptiles.org/>, and
<https://www.openstreetmap.org/copyright>. OpenFreeMap does not currently offer
an SLA. Availability-sensitive applications should host their own versioned
tiles or cache a properly licensed regional bundle.

### Nominatim place search

Online place search is disabled until the user opts in. When enabled, submitted
queries use the public Nominatim service at
`https://nominatim.openstreetmap.org/search`; built-in place and coordinate
searches do not use it. Display **Search data © OpenStreetMap contributors**
with a link to <https://www.openstreetmap.org/copyright> anywhere online search
results are presented.

The OpenStreetMap Foundation's
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
sets an absolute maximum of one request per second, requires an identifying HTTP
Referer or User-Agent and visible attribution, prohibits client-side
autocomplete, and asks applications to cache results and remain able to switch
providers. The standalone provider runs only on form submission, waits at least
one second between network requests in each browser instance, and keeps up to
100 normalized query results in a session-memory cache. That client-side limit
does not coordinate traffic across visitors: deployments with meaningful
traffic should add shared throttling/caching or use a contracted or self-hosted
geocoder. Public Nominatim is a donated, best-effort service, not an availability
dependency for production applications. Its requests are also covered by the
OpenStreetMap Foundation terms and privacy policy.

## Custom and offline providers

A provider's `attribution` value is required metadata, not proof of licence.
Bundle manifests should also record:

- provider and dataset names, canonical licence URLs, and required credit text;
- source/version dates and geographic/zoom coverage;
- whether modification, redistribution, offline storage, and derived works are
  permitted;
- checksums and an immutable bundle format version;
- any share-alike or database-production obligations.

Do not embed API keys or private URLs in a browser bundle. Use origin-restricted
public tokens where unavoidable, or a controlled service that does not expose a
privileged credential.

`PersistentTileCache` and `CachedNetworkXyzProvider` are opt-in integration
tools, not permission to retain a provider's data. Never wrap the public
OpenStreetMap raster endpoint—or any source that prohibits offline storage—in
the persistent cache. Set an explicit quota and document how users clear stored
regions when persistence is permitted.

`XyzTileProvider.loadTile` transfers ownership of the returned `ImageBitmap` to
OpenEarth; it is closed after drawing. Return a new decoded object for each call.
Building footprints are interpreted as heights relative to the current globe
surface; terrain-aware elevation remains planned.

## Attribution presentation

Attribution must remain readable in both desktop and immersive views. A DOM-only
credit that disappears when WebXR owns the compositor is insufficient. Prefer a
shared structured registry—label plus trusted URL—rendered by Cesium and by an
in-scene XR panel. Avoid treating untrusted TileJSON HTML as safe DOM content.
