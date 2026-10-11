$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$acl = Get-Acl -LiteralPath $runtimeDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($existingRule in @($acl.Access)) {
  $acl.RemoveAccessRuleSpecific($existingRule)
}
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$identities = @(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
  [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
  [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
)
foreach ($identity in $identities) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    $fullControl,
    $inheritance,
    $propagation,
    $allow
  )
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $runtimeDir -AclObject $acl

$token = Read-Host "Paste the Telegram bot token from BotFather" -AsSecureString
if ($token.Length -eq 0) {
  throw "The Telegram bot token cannot be empty."
}

$secretPath = Join-Path $runtimeDir "telegram-token.dpapi"
$encryptedToken = ConvertFrom-SecureString -SecureString $token
Set-Content -LiteralPath $secretPath -Value $encryptedToken -Encoding Ascii -NoNewline
Write-Host "Encrypted token saved for this Windows account."
