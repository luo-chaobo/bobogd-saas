param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^bobo-v\d+\.\d+\.\d+-[a-z0-9][a-z0-9-]*$')]
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Invoke-Git {
  param([string[]]$Arguments)
  $result = & git -C $repoRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($result -join [Environment]::NewLine)"
  }
  return @($result)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gitRoot = (Invoke-Git @('rev-parse', '--show-toplevel') | Select-Object -First 1).Trim()
if ([IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($repoRoot)) {
  throw "Run this script from its own repository: $repoRoot"
}

$workingChanges = Invoke-Git @('status', '--porcelain=v1', '--untracked-files=all')
if ($workingChanges.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace(($workingChanges -join ''))) {
  throw "Git worktree must be clean. No files were packaged.`n$($workingChanges -join [Environment]::NewLine)"
}

& git -C $repoRoot show-ref --verify --quiet "refs/tags/$Tag"
if ($LASTEXITCODE -ne 0) {
  throw "Cannot find Git tag: $Tag"
}
$commit = (Invoke-Git @('rev-parse', '--verify', "$Tag^{commit}") | Select-Object -First 1).Trim()

$outputDirectory = Join-Path $repoRoot 'release-output'
$releaseDirectory = Join-Path $outputDirectory $Tag
if (Test-Path -LiteralPath $releaseDirectory) {
  throw "Release directory already exists and will not be overwritten: $releaseDirectory"
}
$archivePath = Join-Path $releaseDirectory "$Tag.zip"
$manifestPath = Join-Path $releaseDirectory 'release-manifest.json'
$checksumPath = Join-Path $releaseDirectory "$Tag.sha256"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("bobo-release-" + [guid]::NewGuid().ToString('N'))
$sourceArchive = Join-Path $tempRoot 'source.zip'
$stageDirectory = Join-Path $tempRoot 'stage'
$pendingArchive = Join-Path $tempRoot "$Tag.zip"
$pendingManifest = Join-Path $tempRoot 'release-manifest.json'
$pendingChecksum = Join-Path $tempRoot "$Tag.sha256"

try {
  New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
  $archiveResult = & git -C $repoRoot archive --format=zip --output=$sourceArchive $commit 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed: $($archiveResult -join [Environment]::NewLine)"
  }

  $sourceZip = [IO.Compression.ZipFile]::OpenRead($sourceArchive)
  try {
    $archiveEntries = @($sourceZip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  } finally {
    $sourceZip.Dispose()
  }

  $blockedPatterns = @(
    '(^|/)(data|db|public/uploads|node_modules|\.pnpm-store|\.tools|tmp|output|outputs|deploy|release-output)(/|$)',
    '(^|/)(config\.local\.json|\.env(?:$|\.(?!example(?:\.|$)))[^/]*|id_(?:rsa|dsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|secret))$',
    '(^|/)[^/]*(?:secret|credential|private-key)[^/]*$',
    '(^|/)(?:data|database|db|app_state)(?:[-_.][^/]*)?\.(?:json|sqlite|sqlite3)$',
    '(^|/)[^/]+\.(?:log|pid|tmp|sqlite|sqlite3|db|bak|backup)$',
    '(^|/)(backups?|\.cache|cache|coverage|\.restore-backups)(/|$)'
  )
  $blockedEntries = @($archiveEntries | Where-Object {
    $entry = $_
    @($blockedPatterns | Where-Object { $entry -match $_ }).Count -gt 0
  })
  if ($blockedEntries.Count -gt 0) {
    throw "Archive contains blocked runtime or sensitive paths.`n$($blockedEntries -join [Environment]::NewLine)"
  }

  [IO.Compression.ZipFile]::ExtractToDirectory($sourceArchive, $stageDirectory)
  $packagePath = Join-Path $stageDirectory 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw 'The tagged release does not contain package.json.'
  }
  $pnpmLockPath = Join-Path $stageDirectory 'pnpm-lock.yaml'
  if (-not (Test-Path -LiteralPath $pnpmLockPath -PathType Leaf)) {
    throw 'The tagged release does not contain pnpm-lock.yaml.'
  }
  $package = [IO.File]::ReadAllText($packagePath) | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$package.version)) {
    throw 'package.json does not contain a valid version.'
  }

  $files = @(Get-ChildItem -LiteralPath $stageDirectory -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relativePath = $_.FullName.Substring($stageDirectory.Length + 1).Replace('\', '/')
    $fileHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{ path = $relativePath; bytes = $_.Length; sha256 = $fileHash }
  })

  Copy-Item -LiteralPath $sourceArchive -Destination $pendingArchive
  $archiveHash = (Get-FileHash -LiteralPath $pendingArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    tag = $Tag
    commit = $commit
    packageVersion = [string]$package.version
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    buildMachine = [Environment]::MachineName
    archive = "$Tag.zip"
    archiveSha256 = $archiveHash
    files = $files
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($pendingManifest, ($manifest | ConvertTo-Json -Depth 8), $utf8)
  [IO.File]::WriteAllText($pendingChecksum, "$archiveHash  $Tag.zip`n", $utf8)

  New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
  Move-Item -LiteralPath $pendingArchive -Destination $archivePath
  Move-Item -LiteralPath $pendingManifest -Destination $manifestPath
  Move-Item -LiteralPath $pendingChecksum -Destination $checksumPath
  Write-Output "Release package: $archivePath"
  Write-Output "Release manifest: $manifestPath"
  Write-Output "SHA-256: $checksumPath"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
    $resolvedTempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $tempPrefix = $resolvedTempBase.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTempRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean a path outside the temporary directory: $resolvedTempRoot"
    }
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
