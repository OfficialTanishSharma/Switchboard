$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'Switchboard AI Gateway'
node .\server.js
