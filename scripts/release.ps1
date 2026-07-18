#requires -Version 5
<# Deploy OpenEarth XR as an independently staged static site. #>
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$SshKey = 'C:\Devstuff\GCloud\caldor_nopass'
$Target = 'kaspersolesen@35.228.204.127'
$RemoteLive = '/var/www/html/openearth'
$SshOpts = @('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20')

if (-not (Test-Path $SshKey)) { throw "SSH key missing: $SshKey" }
if (-not $SkipBuild) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'OpenEarth build failed' } }

$rand = [guid]::NewGuid().ToString().Substring(0, 8)
$stage = "/var/www/html/.staging-openearth-$rand"
& ssh @SshOpts $Target "mkdir -p '$stage'"
if ($LASTEXITCODE -ne 0) { throw 'Could not create remote staging directory' }
& scp @SshOpts -r (Join-Path $Root 'dist\*') "${Target}:$stage/"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload OpenEarth build' }
& scp @SshOpts (Join-Path $Root 'deploy\.htaccess') "${Target}:$stage/.htaccess"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload OpenEarth headers' }
& ssh @SshOpts $Target "if [ -e '$RemoteLive' ]; then mv '$RemoteLive' '$RemoteLive.old-$rand'; fi && mv '$stage' '$RemoteLive' && rm -rf '$RemoteLive.old-$rand'"
if ($LASTEXITCODE -ne 0) { throw 'Could not activate OpenEarth release' }
Write-Host 'Live: https://dionysus.dk/openearth/' -ForegroundColor Green
