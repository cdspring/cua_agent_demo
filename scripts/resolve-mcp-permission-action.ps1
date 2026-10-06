# Resolve the OpenCode permission action name for an MCP tool.
#
# WHY THIS FILE EXISTS
#
# OpenCode V2 docs say an MCP tool's permission action is "<server>_<tool>"
# with resource "*", and that unsupported characters become "_". That left one
# thing genuinely uncertain for a server named `cua-driver`: does the hyphen
# survive, or become "_"?
#
# RESOLVED by reading the embedded source of the running v2.0.22 CLI:
#
#   Kr = (e) => e.name.replace(/[^a-zA-Z0-9_-]/g, "_")
#   wi = (e) => e.options?.namespace === void 0 ? Kr(e)
#              : `${e.options.namespace.replaceAll(".", "_")}_${Kr(e)}`
#
# Two details settle it:
#   1. The character class is [^a-zA-Z0-9_-]. The hyphen sits LAST, after an
#      underscore, so it is a literal member of the allowed set, not a range
#      operator. Hyphens SURVIVE.
#   2. A namespace only has "." replaced, never "-".
#
#   server "cua-driver" + tool "get_window_state"
#     -> action "cua-driver_get_window_state"
#
# Note there is also a `replace(/[^a-zA-Z0-9_]/g,"_")` in the same binary, but
# it belongs to shell-argument escaping, NOT to permission actions. Matching the
# wrong one produces "cua_driver_*" and silently fails to match any rule.
#
# This script re-derives the answer from the installed binary instead of
# trusting a comment, so a future version change shows up as a diff.

param(
  [string]$Server = 'cua-driver',
  [string]$Tool = 'get_window_state',
  [string]$CliPath
)

$ErrorActionPreference = 'Stop'

function Get-OpenCodeCli {
  if ($CliPath -and (Test-Path -LiteralPath $CliPath)) { return $CliPath }
  $onPath = Get-Command opencode -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  # The desktop app bundles a CLI; find the newest version.
  $bundled = Get-ChildItem "$env:APPDATA\ai.opencode.desktop\cli" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'opencode-cli.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if ($bundled) { return $bundled }
  throw "Could not find opencode CLI. Pass -CliPath explicitly."
}

$cli = Get-OpenCodeCli
Write-Host "CLI: $cli" -ForegroundColor Cyan

$bytes = [System.IO.File]::ReadAllBytes($cli)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

# The permission-action sanitiser. Note the trailing "-": it is a literal member
# of the allowed set because it follows an underscore, so hyphens are preserved.
$needle = 'replace(/[^a-zA-Z0-9_-]/g,"_")'
$idx = $text.IndexOf($needle)
if ($idx -lt 0) {
  Write-Host "Permission-action sanitiser pattern not found in the binary." -ForegroundColor Yellow
  Write-Host "The implementation may have changed. Fall back to listing both" -ForegroundColor Yellow
  Write-Host "spellings in opencode.jsonc; unmatched rules simply do not match." -ForegroundColor Yellow
  exit 2
}

$start = [Math]::Max(0, $idx - 140)
$snippet = ($text.Substring($start, 300) -replace '[\x00-\x08\x0E-\x1F]', ' ') -replace '\s+', ' '
Write-Host ""
Write-Host "Found the sanitiser in the binary:" -ForegroundColor Green
Write-Host "  $snippet" -ForegroundColor DarkGray
Write-Host ""

# Reproduce it locally so the answer below is computed, not asserted.
function ConvertTo-PermissionAction([string]$server, [string]$tool) {
  # Matches Kr/wi: hyphens survive, dots become underscores.
  $s = $server -replace '[^a-zA-Z0-9_-]', '_'
  $t = $tool -replace '[^a-zA-Z0-9_-]', '_'
  return "${s}_${t}"
}

$action = ConvertTo-PermissionAction $Server $Tool
Write-Host "  server: $Server" -ForegroundColor Cyan
Write-Host "  tool:   $Tool" -ForegroundColor Cyan
Write-Host "  action: $action" -ForegroundColor Green
Write-Host ""

$json = @"
{
  "$comment": "Rules are order-sensitive and last-match-wins. Put read-only rules first.",
  "permissions": [
    { "action": "$action", "resource": "*", "effect": "ask" }
  ]
}
"@
Write-Host "opencode.jsonc fragment:" -ForegroundColor Cyan
Write-Host $json
exit 0
