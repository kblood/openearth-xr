#requires -Version 5
<#
Build, verify, and atomically deploy OpenEarth as an immutable static release.

Required configuration:
  OPENEARTH_DEPLOY_TARGET=user@host

Optional configuration:
  OPENEARTH_DEPLOY_ROOT=/var/www/html
  OPENEARTH_DEPLOY_URL=https://dionysus.dk/openearth
  OPENEARTH_SSH_KEY=C:\path\to\key
#>
param(
  [string]$Target = $env:OPENEARTH_DEPLOY_TARGET,
  [string]$RemoteRoot = $(if ($env:OPENEARTH_DEPLOY_ROOT) { $env:OPENEARTH_DEPLOY_ROOT } else { '/var/www/html' }),
  [string]$LiveUrl = $(if ($env:OPENEARTH_DEPLOY_URL) { $env:OPENEARTH_DEPLOY_URL } else { 'https://dionysus.dk/openearth' }),
  [string]$SshKey = $env:OPENEARTH_SSH_KEY,
  [ValidateRange(2, 20)][int]$Retain = 4,
  [switch]$AcceptNewHostKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Target)) {
  throw 'Set OPENEARTH_DEPLOY_TARGET (for example, deploy@example.org).'
}
if ($Target -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$') { throw "Unsafe SSH target: $Target" }
if ($RemoteRoot -notmatch '^/[A-Za-z0-9._/-]+$' -or $RemoteRoot.Contains('..')) {
  throw "Unsafe remote root: $RemoteRoot"
}
if (-not [Uri]::IsWellFormedUriString($LiveUrl, [UriKind]::Absolute) -or -not $LiveUrl.StartsWith('https://')) {
  throw "Live URL must be absolute HTTPS: $LiveUrl"
}
if ($SshKey -and -not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { throw "SSH key missing: $SshKey" }

$SshOpts = @(
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=20',
  '-o', $(if ($AcceptNewHostKey) { 'StrictHostKeyChecking=accept-new' } else { 'StrictHostKeyChecking=yes' })
)
if ($SshKey) { $SshOpts += @('-o', 'IdentitiesOnly=yes', '-i', $SshKey) }

function Assert-NativeSuccess([string]$Message) {
  if ($LASTEXITCODE -ne 0) { throw $Message }
}

Push-Location $Root
$stage = $null
try {
  & npm.cmd run release:verify
  Assert-NativeSuccess 'OpenEarth release verification failed.'

  $version = (& node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version").Trim()
  Assert-NativeSuccess 'Could not read package version.'
  $commit = (& git rev-parse --short=12 HEAD).Trim()
  Assert-NativeSuccess 'Could not read Git commit.'
  $releaseId = "v$version-$commit-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
  $env:OPENEARTH_RELEASE_ID = $releaseId
  & node scripts/create-site-manifest.mjs
  Assert-NativeSuccess 'Could not create release manifest and checksums.'

  $remoteReleases = "$RemoteRoot/.openearth-releases"
  $remoteLive = "$RemoteRoot/openearth"
  $stage = "$remoteReleases/.staging-$releaseId"
  $final = "$remoteReleases/release-$releaseId"
  $lock = "$RemoteRoot/.openearth-deploy.lock"

  & ssh @SshOpts $Target "set -eu; mkdir -p '$remoteReleases'; test ! -e '$stage'; mkdir '$stage'"
  Assert-NativeSuccess 'Could not create the remote staging directory.'
  & scp @SshOpts -r (Join-Path $Root 'dist\*') "${Target}:$stage/"
  Assert-NativeSuccess 'Could not upload the OpenEarth build.'
  & scp @SshOpts (Join-Path $Root 'dist\.htaccess') "${Target}:$stage/.htaccess"
  Assert-NativeSuccess 'Could not upload the OpenEarth headers file.'

  & ssh @SshOpts $Target "set -eu; cd '$stage'; test -s index.html; test -s release.json; test -d assets; test -d cesium/Workers; sha256sum -c SHA256SUMS"
  Assert-NativeSuccess 'Remote staging validation or checksum verification failed.'

  $activation = @"
set -eu
exec 9>'$lock'
flock -n 9
previous=''
if [ -e '$remoteLive' ] && [ ! -L '$remoteLive' ]; then
  previous='$remoteReleases/release-legacy-$releaseId'
  mv -- '$remoteLive' "`$previous"
elif [ -L '$remoteLive' ]; then
  previous=`$(readlink -f -- '$remoteLive' || true)
fi
test ! -e '$final'
mv -- '$stage' '$final'
next='$RemoteRoot/.openearth-next-$releaseId'
ln -s '$final' "`$next"
mv -Tf -- "`$next" '$remoteLive'
printf '%s\n' "`$previous"
"@
  $activationOutput = & ssh @SshOpts $Target $activation
  Assert-NativeSuccess 'Could not activate the OpenEarth release.'
  $previousTarget = [string]($activationOutput | Select-Object -Last 1)
  $previousTarget = $previousTarget.Trim()
  $stage = $null

  try {
    $healthUrl = "$($LiveUrl.TrimEnd('/'))/release.json?release=$releaseId"
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 30 -Headers @{ 'Cache-Control' = 'no-cache' }
    if ($health.releaseId -ne $releaseId) {
      throw "Live release id '$($health.releaseId)' does not match '$releaseId'."
    }
    $indexResponse = Invoke-WebRequest -UseBasicParsing -Uri "$($LiveUrl.TrimEnd('/'))/?release=$releaseId" -TimeoutSec 30
    $contentTypeOptions = [string]$indexResponse.Headers['X-Content-Type-Options']
    if ($contentTypeOptions -ne 'nosniff') {
      throw "Unexpected X-Content-Type-Options: $contentTypeOptions"
    }
    $referrerPolicy = [string]$indexResponse.Headers['Referrer-Policy']
    if ($referrerPolicy -ne 'strict-origin-when-cross-origin') {
      throw "Unexpected Referrer-Policy: $referrerPolicy"
    }
    $transportSecurity = [string]$indexResponse.Headers['Strict-Transport-Security']
    if ($transportSecurity -notmatch '(^|;\s*)max-age=31536000($|;)') {
      throw "Unexpected Strict-Transport-Security: $transportSecurity"
    }
    $permissionsPolicy = [string]$indexResponse.Headers['Permissions-Policy']
    foreach ($requiredPermission in @('geolocation=(self)', 'xr-spatial-tracking=(self)')) {
      if (-not $permissionsPolicy.Contains($requiredPermission)) {
        throw "Permissions-Policy is missing $requiredPermission."
      }
    }
    $contentSecurityPolicy = [string]$indexResponse.Headers['Content-Security-Policy']
    foreach ($requiredDirective in @("default-src 'self'", "frame-ancestors 'self' https://*.dionysus.dk", "worker-src 'self' blob:")) {
      if (-not $contentSecurityPolicy.Contains($requiredDirective)) {
        throw "Content-Security-Policy is missing $requiredDirective."
      }
    }
    if ($indexResponse.Headers['X-Frame-Options']) {
      throw "Legacy X-Frame-Options is still present: $($indexResponse.Headers['X-Frame-Options'])"
    }
    if ($indexResponse.Headers['Cache-Control'] -notmatch 'no-cache') {
      throw "HTML Cache-Control is unsafe: $($indexResponse.Headers['Cache-Control'])"
    }
    $assetMatch = [regex]::Match($indexResponse.Content, 'src="(?<path>\./assets/[^"]+\.js)"')
    if (-not $assetMatch.Success) { throw 'Could not find the hashed JavaScript asset in live HTML.' }
    $assetUri = [Uri]::new([Uri]"$($LiveUrl.TrimEnd('/'))/", $assetMatch.Groups['path'].Value)
    $assetResponse = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $assetUri -TimeoutSec 30
    if ($assetResponse.Headers['Cache-Control'] -notmatch 'immutable') {
      throw "Hashed asset Cache-Control is unsafe: $($assetResponse.Headers['Cache-Control'])"
    }
  } catch {
    if ($previousTarget -and $previousTarget.StartsWith("$remoteReleases/release-")) {
      $rollback = @"
set -eu
test -d '$previousTarget'
next='$RemoteRoot/.openearth-rollback-$releaseId'
ln -s '$previousTarget' "`$next"
mv -Tf -- "`$next" '$remoteLive'
"@
      & ssh @SshOpts $Target $rollback
      Assert-NativeSuccess 'Health check failed and automatic rollback also failed.'
      throw "Health check failed; rolled back to $previousTarget. $($_.Exception.Message)"
    }
    throw "Health check failed and no previous release was available. $($_.Exception.Message)"
  }

  $prune = @"
set -eu
active=`$(readlink -f -- '$remoteLive')
find '$remoteReleases' -mindepth 1 -maxdepth 1 -type d -name 'release-*' -printf '%T@ %p\n' |
  sort -rn | cut -d' ' -f2- | tail -n +$($Retain + 1) |
  while IFS= read -r candidate; do
    [ -n "`$candidate" ] || continue
    resolved=`$(readlink -f -- "`$candidate")
    case "`$resolved" in
      '$remoteReleases'/release-*) [ "`$resolved" = "`$active" ] || rm -rf -- "`$resolved" ;;
      *) echo "Refusing unsafe prune target: `$resolved" >&2; exit 1 ;;
    esac
  done
"@
  & ssh @SshOpts $Target $prune
  Assert-NativeSuccess 'Release succeeded, but pruning old immutable releases failed.'
  Write-Host "Live: $($LiveUrl.TrimEnd('/'))/ ($releaseId)" -ForegroundColor Green
} finally {
  if ($stage) {
    & ssh @SshOpts $Target "case '$stage' in '$RemoteRoot/.openearth-releases/.staging-'*) rm -rf -- '$stage' ;; *) exit 2 ;; esac" 2>$null
  }
  Remove-Item Env:OPENEARTH_RELEASE_ID -ErrorAction SilentlyContinue
  Pop-Location
}
