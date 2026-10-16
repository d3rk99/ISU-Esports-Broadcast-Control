; ISU Esports Game Bridge (Rust) installer. Built by package.ps1 (/DAppVersion, /DSrc).
; The Electron bridge was portable only; the installer is extra, the portable zip stays the same idea.
#define AppName "ISU Esports Game Bridge"
#define AppExe "isu-game-bridge.exe"

[Setup]
AppId={{1F0C9A33-7E52-4D7A-A1B8-3C6D2E9F4B22}
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
