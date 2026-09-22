# Experimental VALORANT OCR Integration

Branch: `experiment/valorant-ocr`

Status: research/experimental. Do not merge into `main` until the acceptance criteria in this document are met.

## Goal

Build an experimental VALORANT live-data collector that reads the spectator UI using OCR/computer vision, normalizes the detected state, and feeds that state into ISU Esports Broadcast Control so OBS browser-source graphics can render a custom VALORANT HUD without relying on Overwolf, GRID, or a public Riot live-data API.

The implementation should copy the *architecture* demonstrated by LHM, not its proprietary code:

1. A dedicated data-gathering process captures the VALORANT spectator window.
2. It reads only fixed regions of interest (ROIs), not the whole frame with general OCR.
3. It converts those detections into a stable, normalized game-state object.
4. The existing Broadcast Control app receives that state and publishes it to overlays.
5. Graphics remain completely separated from OCR.
6. The system supports a two-PC workflow so the data observer can leave the in-game scoreboard visible while the broadcast observer remains clean.

## What public LHM material tells us

LHM's public VALORANT documentation provides several strong clues about how their reliable OCR workflow is designed:

- VALORANT must run at **1920x1080**.
- The game should run **borderless windowed**.
- LHM captures the VALORANT window directly and lets the operator override the window name if automatic detection fails.
- The scoreboard must be visible for scoreboard fields to be read.
- LHM can automatically simulate the scoreboard key so the scoreboard stays open.
- Their documentation recommends a **second PC for data gathering** if the production does not want the scoreboard visible on the broadcast observer.
- They support fixed team-size layouts such as 5v5 because spacing/coordinates matter.
- They expose game-language and username-character-set settings because OCR models/preprocessing depend on expected glyphs.
- They expose a `Clear OCR data` operation between matches, which strongly implies they maintain a persistent state/cache rather than simply trusting every frame independently.

The public `lexogrine/valorant-react-hud` repository also shows that the HUD receives already-normalized VALORANT data rather than performing OCR itself. Its data model contains two distinct sources per player:

- `scoreboard` data: username, agent, K/D/A, ultimate progress, credits, weapon, armor, `lastOCRIteration`
- `observed` data: username, agent, credits, health, armor, weapon, `lastOCRIteration`

The HUD then merges these sources, preferring observed-player values where they are available. This is a useful design to reproduce.

## Core design decision

Do **not** put OCR inside `public/overlays/*` or the renderer UI.

Implement a new Electron-main-process service similar in responsibility to `electron/rocket-league-service.cjs`:

```text
VALORANT window
    -> capture service
    -> ROI extraction
    -> OCR / image recognition workers
    -> temporal validator / state reducer
    -> normalized Valorant state
    -> Electron main process
    -> existing Broadcast Control state
    -> local overlay server / SSE
    -> OBS browser source
```

For remote mode:

```text
DATA OBSERVER PC
VALORANT + scoreboard
    -> Valorant OCR Bridge
    -> authenticated WebSocket

GRAPHICS PC
Broadcast Control
    -> normalized Valorant state
    -> overlays
```

Reuse the architectural ideas already present in the Rocket League bridge where practical: authentication token, reconnect logic, status information, packet counters, stale-data detection, and simulator/test mode.

## Phase 1 scope

The first experiment should intentionally be smaller than the final HUD.

### Required fields

Read and publish:

- team scores
- round timer
- 10 player names
- 10 agent identities
- K/D/A
- current credits
- ultimate progress / ultimate-ready state
- current weapon
- armor type
- player alive/dead state
- current observed player
- observed player's current HP
- spike state when reliably detectable

### Deferred fields

Do not block the first prototype on:

- exact round-end cause
- full killfeed parsing
- ability charge counts
- ability cooldowns
- minimap reconstruction
- player world coordinates
- economy prediction
- post-match analytics
- automatic roster identity matching beyond name normalization

These may be added after the basic state is stable.

## Capture layer

Create:

```text
electron/valorant-ocr-service.cjs
```

and, if needed, a helper module:

```text
electron/valorant-capture.cjs
```

### Preferred capture method

Use a native Windows capture path that can target the VALORANT window directly. Prefer Windows Graphics Capture over repeated desktop screenshots.

A Node-native library such as `@screen-capture/node` is a reasonable first experiment because it exposes Windows Graphics Capture, direct window selection by title/handle, BGRA/RGBA frame buffers, cropping, and bounded frame buffering. Keep the capture implementation behind an interface so it can be replaced if Vanguard or a driver combination causes capture failure.

Required capture settings:

```js
{
  enabled: false,
  windowName: 'VALORANT',
  expectedWidth: 1920,
  expectedHeight: 1080,
  captureFps: 10,
  scoreboardMode: 'manual', // manual | auto-tab
  language: 'en',
  usernameCharset: 'latin',
  source: 'local' // local | remote
}
```

### Frame-rate strategy

Do not OCR at 60 fps.

Capture can run at 10-30 fps, but each detector should have its own cadence.

Suggested defaults:

- timer ROI: 5-10 Hz
- score ROI: 3-5 Hz
- observed-player HP: 10 Hz
- observed-player weapon: 3-5 Hz
- scoreboard numeric fields: 2-4 Hz
- player names: only on scoreboard-open acquisition or when identity is unknown
- agent icons: 1-2 Hz until locked, then only re-check on round/side transitions

This keeps CPU usage bounded.

## Fixed coordinate profiles

The first version must support only:

```text
1920 x 1080
VALORANT borderless windowed
5v5 observer UI
English UI
```

Create a profile file:

```text
src/valorant-ocr-profiles.js
```

Example shape:

```js
export const VALORANT_OCR_PROFILES = {
  '1920x1080-en-5v5': {
    frame: { width: 1920, height: 1080 },
    score: {
      left:  { x: 820, y: 25, w: 80, h: 55 },
      right: { x: 1020, y: 25, w: 80, h: 55 }
    },
    timer: { x: 900, y: 25, w: 120, h: 55 },
    scoreboard: {
      rows: [ /* exact row ROI definitions determined during calibration */ ]
    },
    observed: {
      /* ROIs determined during calibration */
    }
  }
};
```

Do not hard-code ROI numbers throughout the service. All coordinates must be stored in one profile object.

## Calibration/debug mode

Add a developer-only or experimental UI section under VALORANT Match Control called:

**OCR Lab**

It should provide:

- selected window name
- capture status
- current source resolution
- start/stop capture
- auto-detect VALORANT window
- screenshot current frame
- toggle ROI debug overlay
- show each cropped ROI
- show raw OCR text
- show OCR confidence
- show normalized value
- show accepted state value
- Clear OCR State button
- Start Test Replay / fixture mode

The debug view is essential. Codex should not implement an OCR system that can only be diagnosed from console logs.

## OCR engine strategy

Do not send every crop through a single generic OCR pipeline.

Use detector-specific processing.

### Text and numeric fields

Use OCR for:

- player names
- K/D/A values
- credits
- scores
- timer
- ultimate numbers if represented as text

For the first experiment, use an efficient local OCR backend. Prefer ONNX-based OCR or another native/local engine over browser-only OCR if practical.

Tesseract.js is acceptable as a prototype fallback but should not be assumed to be the final engine. The service must expose an adapter interface:

```js
class OcrEngine {
  async recognize(crop, options) {}
  async close() {}
}
```

so a faster backend can be substituted without rewriting state logic.

### Icon fields

Do not OCR things that are icons.

Use image/template classification for:

- agent identity
- weapon identity
- armor type
- spike icon/state where appropriate
- ultimate-ready icon/state

Store canonical templates/assets in:

```text
assests/Image/Valorant/OCR/
```

Use grayscale or edge-based template matching where color is not important. If template matching proves fragile, replace specific detectors with a small ONNX classifier later.

### Health/alive state

Prefer direct reading of numeric HP where text is visible. If a health bar is easier to detect, calculate the filled proportion as a secondary signal.

Alive/dead should use multiple signals where possible:

- HP == 0
- portrait/player-row visual state
- scoreboard row styling

Do not flip alive/dead from a single uncertain frame.

## Preprocessing

Each ROI should define its own preprocessing recipe.

Examples:

```js
{
  grayscale: true,
  scale: 3,
  threshold: 'otsu',
  invert: false,
  allowedChars: '0123456789'
}
```

Player-name fields should use a language/character-set-specific whitelist.

Numerical fields should reject all non-numeric glyphs before parsing.

For the timer, normalize likely OCR substitutions:

- `O` -> `0`
- `I`, `l` -> `1` only in numeric-only ROIs

Do not apply these substitutions to usernames.

## Detection pipeline

Each detector returns a candidate, not final game state.

Example:

```js
{
  field: 'left.players.2.credits',
  value: 2900,
  confidence: 0.93,
  capturedAt: 1789680000000,
  source: 'scoreboard',
  iteration: 4182
}
```

The candidate then enters a temporal validator.

## Temporal validation / anti-flicker

This is one of the most important parts of the experiment.

Never replace broadcast state immediately from one OCR result.

Maintain a rolling history for every field.

Suggested rule set:

### Static/slow identity fields

Player name, agent:

- require confidence >= 0.80
- require same normalized value in 2 of last 3 valid samples
- once locked, require 3 contradictory high-confidence samples before changing

### Credits

- require confidence >= 0.75
- prefer 2 consecutive matching reads
- validate plausible VALORANT values
- reject huge impossible one-frame jumps outside known round transitions unless confidence is extremely high

### K/D/A

- integers only
- cannot decrease during a map
- only accept a change when confirmed twice

### Score

- integers only
- cannot decrease except on manual OCR reset/new map
- cannot increase by more than 1 without a reset/recovery path
- require two reads if confidence < 0.95

### Timer

Timer is special because it changes continuously.

- parse `M:SS` / seconds
- accept if within a plausible delta from locally predicted countdown
- maintain a local monotonic countdown between OCR samples
- periodically resynchronize from OCR
- stop/defer countdown during buy phase, round end, technical pause, or when OCR is uncertain

### Health

- may decrease rapidly
- may return to 100 at a new round
- use a short confirmation window, e.g. 2 samples or one very-high-confidence read
- never show negative or >100

### Weapon

- require matching classification over 2 frames unless confidence >0.97
- allow rapid change for observed player
- use slower locking for non-observed scoreboard weapon reads

## State confidence and freshness

Every normalized field should track metadata internally:

```js
{
  value: 2900,
  confidence: 0.93,
  source: 'scoreboard',
  updatedAt: 1789680000000,
  iteration: 4182
}
```

The OBS-facing state does not need to expose all metadata, but the OCR Lab should.

Define stale thresholds:

- timer: 1.0 s
- observed HP: 1.0 s
- score: 5 s
- scoreboard player data: 10 s while scoreboard is expected open

If a field becomes stale, **hold the last trusted value** rather than replacing it with zero/null immediately. Surface stale status to the operator.

## Normalized VALORANT state

Create a game-specific model inspired by the public Lexogrine shape but tailored to this application:

```js
{
  source: 'valorant-ocr',
  connected: true,
  capture: {
    width: 1920,
    height: 1080,
    fps: 10,
    lastFrameAt: 0,
    scoreboardVisible: true
  },
  match: {
    timerSeconds: 82,
    spikeState: 'carried', // unknown | carried | dropped | planted | defused | detonated
    round: 17
  },
  teams: {
    home: {
      score: 8,
      side: 'attacker',
      players: []
    },
    away: {
      score: 8,
      side: 'defender',
      players: []
    }
  },
  observedPlayerId: 'home:2'
}
```

Each player:

```js
{
  id: 'home:2',
  name: 'BengalOne',
  agent: 'jett',
  alive: true,
  hp: 76,
  credits: 2900,
  armor: 'heavy',
  weapon: 'vandal',
  kills: 12,
  deaths: 8,
  assists: 4,
  ultimate: {
    current: 5,
    max: 7,
    ready: false
  },
  isObserved: true
}
```

## Separate scoreboard and observed-player sources

Copy the useful concept visible in Lexogrine's public types: keep raw acquisition sources separate before merging.

Internally:

```js
player.sources = {
  scoreboard: {
    name,
    agent,
    kills,
    deaths,
    assists,
    ultCurrent,
    ultMax,
    credits,
    weapon,
    armor,
    lastIteration
  },
  observed: {
    name,
    agent,
    hp,
    credits,
    weapon,
    armorValue,
    lastIteration
  }
};
```

Then produce a merged player state.

Priority examples:

- HP: observed source > side-panel source > previous trusted value
- weapon: observed source > scoreboard source > previous trusted value
- credits: observed source > scoreboard source
- K/D/A: scoreboard source
- agent: locked scoreboard/side-panel identity

## Scoreboard automation

Support two modes.

### Manual

The data observer operator holds/toggles the scoreboard normally.

### Auto Tab

Experimental option:

```text
Open VALORANT Scoreboard Automatically
```

Only implement this through normal Windows keyboard input to the focused VALORANT observer window. Do not inject into the game process, read game memory, bypass Vanguard, or hook DirectX.

Safety requirements:

- disabled by default
- clear UI indicator when active
- configurable scoreboard key
- only press the key when the selected VALORANT window is foreground/focused
- never spam key events faster than a conservative interval

For our preferred two-PC workflow, the dedicated data observer can simply leave the scoreboard visible.

## Two-PC bridge

The preferred production configuration is:

### Observer 1 / data PC

- VALORANT spectator
- 1920x1080 borderless
- scoreboard permanently visible when needed
- OCR Bridge executable

### Graphics PC

- ISU Esports Broadcast Control
- HTML overlays
- OBS / key-fill workflow

Implement a dedicated bridge similarly to the Rocket League bridge:

```text
electron/valorant-ocr-bridge.cjs
```

Transport:

- authenticated WebSocket
- JSON messages
- sequence number
- timestamp
- bridge version

Example:

```json
{
  "type": "valorant-state",
  "version": 1,
  "sequence": 3812,
  "capturedAt": 1789680000000,
  "state": {}
}
```

Do not send screenshots continuously over the network. OCR should run on the data PC and only normalized state should be transmitted.

Optional debug snapshot requests may be implemented later.

## Service status

Mirror the strong status model already used by Rocket League.

Expose:

- disabled
- starting
- searching-window
- capturing
- calibrating
- reading
- degraded
- stale
- disconnected
- error
- simulating

Also expose:

- frames/sec
- OCR scans/sec
- average OCR latency
- accepted updates/sec
- rejected candidates/sec
- last frame age
- last trusted update age
- bridge clients
- selected VALORANT window title

## OCR reset

Implement:

```text
Clear OCR State
```

This must clear:

- player identity locks
- temporal candidate history
- K/D/A monotonic baselines
- credits history
- score baseline
- round history
- observed-player lock
- stale flags

It must not erase the manually configured Broadcast Control teams/rosters.

Run this automatically when the operator starts a new VALORANT map only if the user has enabled an experimental auto-reset option. Otherwise display a prompt/status reminder in the OCR Lab.

## Roster-assisted OCR

Use existing Broadcast Control roster information to improve OCR reliability.

If the user has already configured a 5-player roster, fuzzy-match OCR names only against those expected names plus the away roster.

Example:

```text
OCR: BengaI0ne
Roster: BengalOne
```

A high-similarity match can normalize to `BengalOne`.

Rules:

- never silently map two OCR rows to the same roster player
- display the raw OCR value in OCR Lab
- maintain a confidence score for the mapping
- allow manual row-to-player override in debug UI

This is likely to be much more reliable than unrestricted username OCR.

## Agent and weapon classifiers

Create canonical IDs independent of filenames:

```js
AGENTS = {
  jett: { aliases: [], templates: [...] },
  omen: { aliases: [], templates: [...] }
}
```

and:

```js
WEAPONS = {
  vandal: { templates: [...] },
  phantom: { templates: [...] },
  operator: { templates: [...] }
}
```

Return `{id, confidence}`.

The overlay should render its own clean assets based on the canonical ID. Never crop the game's icon and display the crop directly in the broadcast HUD.

## OCR region scheduling

Use a scheduler so expensive work is not repeated unnecessarily.

Example priorities:

### High priority

- timer
- observed HP
- observed player identity
- team score

### Medium

- credits
- weapon
- ultimate state
- alive/dead

### Low

- player names after locked
- agents after locked
- K/D/A unless scoreboard is visible

When scoreboard visibility is confidently false, pause scoreboard detectors rather than repeatedly OCRing meaningless pixels.

## Scoreboard visibility detector

Implement a lightweight `scoreboardVisible` detector before running all scoreboard OCR.

Options:

- template-match a stable scoreboard header/shape
- inspect known background/colors/lines at anchor points
- combine 2-3 anchor tests

Only run the full scoreboard pass when visible.

This saves significant CPU and prevents random gameplay pixels from becoming false player data.

## Round/state detection

Do not attempt a perfect event model in v1.

Infer round transitions from a combination of:

- team score change
- timer reset/buy-phase transition
- player HP reset/alive reset
- scoreboard state changes

When a new round is confirmed:

- allow HP to reset
- update round number
- clear transient observed-player values as necessary
- retain cumulative K/D/A

## OBS overlay

Do not clone the LHM visual design.

Build a new ISU-branded VALORANT HUD using the normalized state.

Recommended new files:

```text
public/overlays/valorant-hud.html
public/overlays/valorant-hud.css
public/overlays/valorant-hud.js
```

The overlay should subscribe to the same local state distribution system used by the current overlays.

First UI target:

- top match bar
- team names/logos
- score
- timer
- attacker/defender color/indicator
- five player cards on each side
- agent
- name
- HP/alive
- credits
- weapon
- ultimate indicator
- observed-player highlight

Do not include OCR debug information in the production overlay.

## Integration with existing Broadcast Control state

Do not let OCR overwrite operator-entered metadata such as:

- team name
- team logo
- team colors
- best-of series score
- roster portraits
- sponsor information

OCR should own only live in-game state.

The combined overlay state should look conceptually like:

```js
{
  metadata: existingBroadcastControlState,
  liveData: valorantOcrState
}
```

When OCR is disabled, the current manual VALORANT controls must continue to work.

## Manual override policy

Broadcast operation must always be able to override OCR.

Add manual override controls for:

- home/away score
- timer freeze/correction
- player name mapping
- observed player
- weapon
- credits
- ultimate state

An override should be clearly marked and should optionally expire on the next round.

Do not make the broadcast dependent on OCR being perfect.

## Fixture / replay test system

A real VALORANT custom match should not be required for development.

Create:

```text
test/fixtures/valorant-ocr/
```

Support fixture frames captured from the user's own test environment.

Do not commit copyrighted broadcast footage from VCT or other third parties.

Test categories:

- scoreboard open
- scoreboard closed
- buy phase
- live round
- one player dead
- several players dead
- spike planted
- observed player switches
- weapon swap
- halftime
- overtime
- end of map

Add a replay runner that feeds fixture images into the detector pipeline at deterministic intervals.

## Automated tests

Create unit tests for the state reducer independent of OCR.

At minimum:

1. score cannot decrease within a map
2. score increments by one are accepted
3. one-frame OCR score hallucinations are rejected
4. K/D/A cannot decrease
5. credits are held when OCR confidence drops
6. observed HP may decrease immediately with high confidence
7. HP may reset at a confirmed new round
8. stale fields retain last trusted value
9. player identity does not switch from one noisy frame
10. clear OCR state resets locks/baselines
11. remote packets with old sequence numbers are ignored
12. remote state becomes stale after timeout

## Performance targets

On the dedicated data observer PC:

- capture CPU load should remain modest
- no unbounded frame queues
- old frames should be dropped rather than processed late
- total state latency target: <500 ms for player/score data
- observed HP target: <250 ms if achievable
- no renderer/UI freezes
- OCR work must never run synchronously on Electron's renderer thread

The graphics PC should receive compact JSON state only.

## Security and anti-cheat boundaries

The experiment must stay entirely in normal screen-capture and input-automation territory.

Do not:

- read VALORANT process memory
- inject DLLs
- hook Vanguard
- bypass Riot anti-cheat
- modify the VALORANT executable
- intercept encrypted Riot network traffic
- automate gameplay

The data observer is a spectator and the tool should only read pixels visible to that spectator.

## Recommended implementation order for Codex

### Step 1 - branch-safe scaffolding

- add settings schema for `valorantOcr`
- add service skeleton and status events
- no OCR yet
- preserve all existing behavior

### Step 2 - capture proof of concept

- select VALORANT window
- verify exact 1920x1080
- capture frames
- show current frame in OCR Lab
- capture-rate metrics

### Step 3 - ROI/debug system

- load ROI profile
- display ROI rectangles
- preview crops
- save test frame/crops locally

### Step 4 - first OCR fields

Implement only:

- home score
- away score
- timer

Use temporal validation.

Do not proceed until these remain stable through a full test map.

### Step 5 - scoreboard visibility and player rows

- scoreboard detector
- row crops
- player names
- K/D/A
- credits

Use roster-assisted matching.

### Step 6 - classifiers

- agents
- weapons
- armor
- alive/dead

### Step 7 - observed-player data

- identify currently observed player
- HP
- weapon
- credits if visible

### Step 8 - state reducer

- merge scoreboard + observed sources
- confidence/freshness
- round transition rules

### Step 9 - two-PC bridge

- reuse Rocket League bridge patterns
- authenticated WebSocket
- normalized JSON only
- reconnect/stale state

### Step 10 - ISU Valorant HUD

- production browser overlay
- no debug content
- use manual metadata + OCR live data

### Step 11 - fixture tests and burn-in

Run at least one full custom-match session before considering the feature usable on air.

## Acceptance criteria for the first usable experimental build

The experiment is considered successful when, during a controlled 5v5 custom match:

- VALORANT is detected and captured reliably for 30+ minutes
- the OCR process never freezes the Broadcast Control UI
- team score is correct for every round
- timer does not visibly jump/flicker from bad OCR
- at least 9/10 player identities remain locked correctly
- K/D/A remains monotonic and correct after initial acquisition
- credits are correct often enough to be useful and never wildly flicker
- agent and weapon classifiers do not visibly oscillate
- observed-player HP updates quickly enough for broadcast use
- disconnecting the data PC produces a clear stale/disconnected state instead of clearing the HUD
- reconnecting recovers without restarting Broadcast Control
- manual score/identity overrides remain possible
- existing Rocket League and other game functionality is unaffected

## Research notes / design rationale

The most important lesson from LHM's public implementation is not a specific OCR library. It is the constrained acquisition model:

- one known resolution
- one known observer UI
- fixed ROI coordinates
- scoreboard intentionally exposed
- language/character-set configuration
- persistent OCR state
- second data PC when necessary
- normalized data separated from graphics

That is the model this experiment should follow.

The public Lexogrine HUD also shows that the graphics layer expects structured game data including scoreboard and observed-player sources and then merges them for presentation. We should reproduce that separation rather than attempting to make the overlay interpret pixels itself.

## Codex execution instruction

Codex: implement this incrementally on `experiment/valorant-ocr`. Do not make broad unrelated refactors. Preserve the existing Rocket League service, Companion API, overlay server, and manual game controls. After each implementation phase, run:

```powershell
npm run check
npm test
npm run build
```

If a native capture/OCR dependency breaks packaging, keep it isolated behind an adapter and document the failure rather than restructuring the entire app around that package.

Start with Steps 1-4 only. Once capture, ROI debugging, score, and timer are stable, continue to player-level OCR.
