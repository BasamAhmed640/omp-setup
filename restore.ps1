<#
.SYNOPSIS
  Restore an omp-setup snapshot into ~/.omp/agent (Windows PowerShell).
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $HOME '.omp\agent')
)

$ErrorActionPreference = 'Stop'
$RepoDir = $PSScriptRoot
$src     = Join-Path $RepoDir 'agent'

Write-Host "Source repo : $RepoDir"
Write-Host "Destination : $Dest"
Write-Host ''

if (Test-Path $Dest) {
  $ans = Read-Host "$Dest already exists. Overwrite matching files? [y/N]"
  if ($ans -notmatch '^[yY]') { Write-Host 'Aborted.'; exit 1 }
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$files = 'config.yml','config.yml.bak','config.yml.pre-revert-backup','models.yml',
         'lsp.json','lsp.json.bak','last-changelog-version','history.db'
foreach ($f in $files) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $Dest $f) -Force }
}

$dirs = 'agents','extensions','sessions','blobs','terminal-sessions'
foreach ($d in $dirs) {
  $p = Join-Path $src $d
  if (Test-Path $p) { Copy-Item $p $Dest -Recurse -Force }
}

Write-Host ''
Write-Host "Restored into $Dest"
Write-Host 'Next steps:'
Write-Host '  1. Set DEEPSEEK_API_KEY (models.yml reads it from the environment).'
Write-Host '  2. Log in to your other providers.'
Write-Host '  3. Fix executable paths in lsp.json if this is not the original machine.'
