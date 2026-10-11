$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot ".runtime\telegram-token.dpapi"
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "No encrypted token found. Run scripts/save-token.ps1 first."
}

$environmentNames = @(
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "CODEX_EXECUTABLE",
  "TELEGRAM_BOT_TOKEN"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

Push-Location $projectRoot
try {
  if (-not $env:CODEX_EXECUTABLE) {
    $codexCommand = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($codexCommand) {
      $env:CODEX_EXECUTABLE = $codexCommand.Source
    }
  }
  if (-not $env:CODEX_EXECUTABLE) {
    $daemonExecutable = Join-Path $env:USERPROFILE ".codex\packages\app-server-daemon\current\bin\codex.exe"
    if (Test-Path -LiteralPath $daemonExecutable -PathType Leaf) {
      $env:CODEX_EXECUTABLE = $daemonExecutable
    }
  }
  if (-not $env:CODEX_EXECUTABLE) {
    $codexBin = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexBin -PathType Container) {
      $managedExecutables = Get-ChildItem -LiteralPath $codexBin -Directory |
        Where-Object { $_.Name -notlike ".staging-*" } |
        ForEach-Object {
          $candidate = Join-Path $_.FullName "codex.exe"
          if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            [pscustomobject]@{
              Path = $candidate
              LastWriteTime = $_.LastWriteTime
            }
          }
        } |
        Sort-Object LastWriteTime -Descending
      if ($managedExecutables) {
        $env:CODEX_EXECUTABLE = $managedExecutables[0].Path
      }
    }
  }

  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "TypeScript build failed."
  }

  if (-not $env:HTTP_PROXY -and -not $env:HTTPS_PROXY) {
    try {
      $internetSettings = Get-ItemProperty `
        -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
      if ($internetSettings.ProxyEnable -and $internetSettings.ProxyServer) {
        $proxyByScheme = @{}
        foreach ($entry in ([string]$internetSettings.ProxyServer -split ";")) {
          $entry = $entry.Trim()
          if ($entry -match "^(?<scheme>http|https)=(?<address>.+)$") {
            $proxyByScheme[$Matches.scheme] = $Matches.address.Trim()
          }
          elseif ($entry -and $entry -notmatch "=") {
            $proxyByScheme["http"] = $entry
            $proxyByScheme["https"] = $entry
          }
        }

        if (-not $proxyByScheme.ContainsKey("https") -and $proxyByScheme.ContainsKey("http")) {
          $proxyByScheme["https"] = $proxyByScheme["http"]
        }
        if (-not $proxyByScheme.ContainsKey("http") -and $proxyByScheme.ContainsKey("https")) {
          $proxyByScheme["http"] = $proxyByScheme["https"]
        }
        foreach ($scheme in @("http", "https")) {
          if ($proxyByScheme.ContainsKey($scheme)) {
            $address = $proxyByScheme[$scheme]
            if ($address -notmatch "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
              $address = "http://$address"
            }
            if ($scheme -eq "http" -and -not $env:HTTP_PROXY) {
              $env:HTTP_PROXY = $address
            }
            if ($scheme -eq "https" -and -not $env:HTTPS_PROXY) {
              $env:HTTPS_PROXY = $address
            }
          }
        }

      }
    }
    catch {
      Write-Host "Could not read the Windows proxy settings; using existing environment settings."
    }
  }

  if (-not $env:HTTPS_PROXY -and $env:HTTP_PROXY) {
    $env:HTTPS_PROXY = $env:HTTP_PROXY
  }
  if (-not $env:HTTP_PROXY -and $env:HTTPS_PROXY) {
    $env:HTTP_PROXY = $env:HTTPS_PROXY
  }
  $noProxyEntries = @()
  if ($env:NO_PROXY) {
    $noProxyEntries += $env:NO_PROXY -split ","
  }
  $noProxyEntries += @("localhost", "127.0.0.1", "::1")
  $env:NO_PROXY = (
    $noProxyEntries |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ } |
      Select-Object -Unique
  ) -join ","

  if (($env:HTTP_PROXY -or $env:HTTPS_PROXY) -and -not $env:NODE_USE_ENV_PROXY) {
    $env:NODE_USE_ENV_PROXY = "1"
    Write-Host "Node.js will use the configured proxy for Telegram requests."
  }

  $encryptedToken = Get-Content -LiteralPath $secretPath -Raw
  $env:PSModulePath = @(
    (Join-Path $env:USERPROFILE "Documents\WindowsPowerShell\Modules")
    (Join-Path $env:ProgramFiles "WindowsPowerShell\Modules")
    (Join-Path $PSHOME "Modules")
  ) -join ";"
  Import-Module Microsoft.PowerShell.Security
  $secureToken = ConvertTo-SecureString -String $encryptedToken
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    npm run start
    $bridgeExitCode = $LASTEXITCODE
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
}
finally {
  Pop-Location
  foreach ($name in $environmentNames) {
    if ($null -eq $originalEnvironment[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    else {
      [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }
  }
}

if ($null -ne $bridgeExitCode -and $bridgeExitCode -ne 0) {
  exit $bridgeExitCode
}
