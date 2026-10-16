; ISU Display Client (Rust) installer. Built by package.ps1 (/DAppVersion, /DSrc).
; Same choices as the Electron NSIS build: per user, no desktop shortcut, start menu shortcut,
; runs after install, shows the NDI license. Start-with-Windows is set by the app itself (on by default).
#define AppName "ISU Display Client"
#define AppExe "isu-display-client.exe"

[Setup]
AppId={{9D4E2B71-0A6C-4F18-8E3D-5B7C1A2F6E33}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Idaho State University Esports
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputBaseFilename={#AppName}-Setup-{#AppVersion}-x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\{#AppExe}
LicenseFile={#Src}\{#AppName}\NDI-LICENSE.txt
WizardStyle=modern

[Files]
Source: "{#Src}\{#AppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{userstartup}\{#AppName}.lnk"

[Registry]
; the app writes this Run entry itself; remove it on uninstall
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "{#AppName}"; Flags: uninsdeletevalue dontcreatekey
