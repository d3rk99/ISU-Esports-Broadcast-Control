; ISU Esports Broadcast Control (Rust) installer. Built by package.ps1 (/DAppVersion, /DSrc).
; Same choices as the Electron NSIS build: not one-click, pick the folder, desktop + start menu shortcut.
#define AppName "ISU Esports Broadcast Control"
#define AppExe "isu-broadcast-control.exe"

[Setup]
AppId={{6B2A7E0C-4C1F-4C3E-9B1D-1F2E5A0C7D11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Idaho State University Esports
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequiredOverridesAllowed=dialog
OutputBaseFilename={#AppName}-Setup-{#AppVersion}-x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\{#AppExe}
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#Src}\{#AppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM isu-outputs.exe /F"; Flags: runhidden; RunOnceId: "KillOutputs"
