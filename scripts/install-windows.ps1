<#
  Makes Windows treat Kestrel workspace files (.kestrel) as their own file
  type: Kestrel's icon in Explorer, and a double-click opens them in Kestrel
  (via open-kestrel-workspace.vbs, with no console window). Also adds Kestrel
  to the "Open with" list for .json files, for older .kestrel.json workspaces,
  without making it the default for .json.

  Per user, no administrator rights needed; nothing is copied anywhere - the
  registration points at this folder, so re-run it if you move the folder.

    install-windows.bat                 (double-click)  register
    install-windows.bat -Uninstall                      remove it again

  Needs Node.js (nodejs.org) to open files; the registration itself doesn't.
#>
param([switch]$Uninstall, [switch]$Quiet)
$ErrorActionPreference = 'Stop'

$progId  = 'Kestrel.Workspace'
$classes = 'HKCU:\Software\Classes'
$here    = $PSScriptRoot
$icon    = Join-Path $here 'kestrel.ico'
$vbs     = Join-Path $here 'open-kestrel-workspace.vbs'

function Set-Default([string]$key, [string]$value) {
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  Set-Item -LiteralPath $key -Value $value
}

function Show([string]$text, [string]$kind = 'Information') {
  Write-Host $text
  if ($Quiet) { return }
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show($text, 'Kestrel', 'OK', $kind)
}

if ($Uninstall) {
  foreach ($k in "$classes\.kestrel", "$classes\$progId") {
    if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force }
  }
  $owp = "$classes\.json\OpenWithProgids"
  if (Test-Path -LiteralPath $owp) { Remove-ItemProperty -LiteralPath $owp -Name $progId -ErrorAction SilentlyContinue }
  $msg = 'Kestrel workspace files are no longer associated with Kestrel.'
} else {
  foreach ($f in $icon, $vbs, (Join-Path $here 'open-workspace.mjs')) {
    if (-not (Test-Path -LiteralPath $f)) { Show "Missing $f. Run this from Kestrel's scripts folder." 'Error'; exit 1 }
  }
  Set-Default "$classes\.kestrel" $progId
  New-ItemProperty -LiteralPath "$classes\.kestrel" -Name 'Content Type' -Value 'application/json' -PropertyType String -Force | Out-Null
  Set-Default "$classes\$progId" 'Kestrel workspace'
  New-ItemProperty -LiteralPath "$classes\$progId" -Name 'FriendlyTypeName' -Value 'Kestrel workspace' -PropertyType String -Force | Out-Null
  Set-Default "$classes\$progId\DefaultIcon" "`"$icon`",0"
  Set-Default "$classes\$progId\shell" 'open'
  Set-Default "$classes\$progId\shell\open" 'Open in Kestrel'
  Set-Default "$classes\$progId\shell\open\command" "`"$env:SystemRoot\System32\wscript.exe`" `"$vbs`" `"%1`""
  # list Kestrel under "Open with" for .json (older .kestrel.json files) without becoming the default
  $owp = "$classes\.json\OpenWithProgids"
  if (-not (Test-Path -LiteralPath $owp)) { New-Item -Path $owp -Force | Out-Null }
  New-ItemProperty -LiteralPath $owp -Name $progId -Value '' -PropertyType String -Force | Out-Null

  $node = Get-Command node -ErrorAction SilentlyContinue
  $msg = "Done. .kestrel workspace files now show Kestrel's icon and open in Kestrel on double-click.`n`nRegistered from:`n$here`n(re-run this if you move that folder)."
  if (-not $node) { $msg += "`n`nNode.js wasn't found. Install it from nodejs.org, or double-clicking a workspace will show an error." }
}

# tell Explorer file types changed, so icons refresh without signing out
Add-Type -Namespace Kestrel -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);'
[Kestrel.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Show $msg
