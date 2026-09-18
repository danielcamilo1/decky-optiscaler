# Changelog

Newest first. Each release ships `Decky OptiScaler.zip` for Decky Loader's
*Install from URL* (Developer mode), and bundles **OptiScaler 0.9.4**.

## [Unreleased]

### Added

- **FSR 4.1.1b — Steam Deck** in the Basic upscaler dropdown. Downloads the pinned
  community RDNA2 upscaler and applies INT8 settings together while the game is
  stopped. Frame generation is unchanged. Setup identifies the installed build
  and offers restoration of the bundled SDK.

### Fixed

- Verification recognizes the selected community DLL by hash; reinstall preserves it.
- DLL replacements use atomic file replacement with rollback on errors and reject
  unmanaged installs or games detected running.
- The schema offers all six FSR4 quality presets from the reference INI.
- Selecting an FSR version on RDNA2 no longer forces the incompatible upgrade path.

## [0.0.6] - 2026-08-28

Everything from the `0.0.5.x-testing` prereleases, as one release.

### Added

- Non-Steam games can be set up. Their folder is taken from the shortcut's
  target, since Steam reports no install folder for them.
- Games whose wiki entry requires
  [REFramework](https://github.com/praydog/REFramework) say so on the setup
  checklist and link the right build. Installing it for you is disabled for
  now, until I can gather more information to get it fully working.

### Fixed

- A non-Steam game's launch options are read from `shortcuts.vdf`, so removing
  OptiScaler no longer wipes them.
- Settings are read only from the install method this plugin actually performs.
  Monster Hunter Wilds would not boot because of this.
- Settings hedged by an "if", a "try", an "e.g." or a "desired" are reported
  rather than applied. Resident Evil 2 was getting 2× output scaling it never
  asked for.
- Setup names the OptiScaler overlay's new shortcut key when an entry moves it
  off Insert.
- Wiki pages with brackets in the name download again — Resident Evil, Dead
  Space (2023) and Elden Ring were affected. Bundled list regenerated.

[0.0.6]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.6

## [0.0.5.3-testing] - 2026-08-27

Prerelease on the `testing` branch.

### Added

- Non-Steam games can be set up. Their folder is taken from the shortcut's
  target, since Steam reports no install folder for them.

### Changed

- Automatic REFramework setup is disabled for now, until I can gather more
  information to get it fully working. The games that need it still say so and
  link the right build, and REFramework installed by 0.0.5.1/0.0.5.2-testing can
  still be removed.

### Fixed

- A non-Steam game's launch options are read from `shortcuts.vdf`, so removing
  OptiScaler no longer wipes them.

## [0.0.5.2-testing] - 2026-08-24

Prerelease.

### Fixed

- Monster Hunter Wilds would not boot: settings were being read from install
  methods other than the one performed.
- Resident Evil 2 got 2× output scaling it never asked for. Settings hedged by
  an "if", a "try", an "e.g." or a "desired" are reported, not applied.
- Setup names the OptiScaler overlay's new shortcut key when an entry moves it
  off Insert.

## [0.0.5.1-testing] - 2026-08-24

Prerelease. REFramework auto-install — **disabled in 0.0.5.3-testing**.

### Added

- The nine compatibility-list games that need REFramework are detected, and the
  build, the `dinput8` override and `PDPerfPlugin.dll` are stated on the
  checklist.

### Fixed

- Wiki pages with brackets in the name download again — Resident Evil, Dead
  Space (2023) and Elden Ring were affected. Bundled list regenerated.

## [0.0.5] - 2026-08-23

### Added

- Removing OptiScaler asks what to do with the Steam launch options: restore
  what was there, remove only the OptiScaler override, or change nothing. The
  answer can be remembered.
- A Settings tab on the main page: remembered answers, the switch that stops
  answers being kept, and the state of the compatibility list.
- A copy of the compatibility list ships with the plugin, so an offline Deck
  still matches games.

### Changed

- The compatibility list is read from cache and refreshed in the background,
  instead of a network timeout in front of every question.

### Fixed

- Launch options are read from three sources, not just
  `SteamClient.Apps.GetAppLaunchOptions`, which some client builds do not have.
- A wiki that will not download is no longer reported as "your game is not on
  the list", and there is a **Try again** button.
- A stalled connection is retried over IPv4.
- The last-resort unverified TLS context no longer reads the system trust store.

[0.0.5]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.5

## [0.0.4] - 2026-08-21

### Added

- The exact FSR version the running game built, rather than just the backend id.
- A second dropdown for which FSR version to run. Applies without a restart.
- Both frame rates while frame generation is on: what the game renders and what
  reaches the screen.
- A live-control readout that says why a number is missing, and a warning when a
  game's in-game plugin is out of date.

### Fixed

- A dropdown could keep a name its option list no longer used.
- Asking for FSR 4 could silently give you FSR 3.
- A game on the SD card reported itself as "writing to a different folder".
- The newest FSR version was named after the reference INI's build, not the
  bundled one.

[0.0.4]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.4

## [0.0.3] - 2026-08-20

### Fixed

- The upscaler dropdown lagged one change behind after reopening the panel.
- The FidelityFX FG version control disappeared on games reporting one
  generator.

[0.0.3]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.3

## [0.0.2] - 2026-08-20

### Fixed

- A control could display a value it was not set to.
- Picking the third FidelityFX frame generator did nothing.
- Settings the config writer refused are reported instead of left on screen.
- Re-reading the config could undo an edit or blank the panel.
- The live upscaler switch works for DX11 games.

[0.0.2]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.2

## [0.0.1] - 2026-08-20

First public release.

### Added

- Per-game install, into a folder scored automatically and overridable by hand.
  Steam libraries including the SD card, plus any folder as a custom library.
- Automatic setup from the OptiScaler
  [Compatibility List](https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List),
  as a checklist that names the wiki field behind every line before writing it.
- Basic settings (four controls) and Advanced (all 288 options across 34
  sections), generated from the shipped `OptiScaler.ini` and preserving its
  comments.
- Live in-game control of frame generation, the FidelityFX FG version and the
  upscaler, with a frame rate readout, via a bundled ASI plugin.
- Quick Access panel: the running game's live controls and a filtered game list.
- Files an install would overwrite are backed up and restored on uninstall.
- `OptiScaler.log` parsing, bundled
  [OptiPatcher](https://github.com/optiscaler/OptiPatcher), and an **OptiScaler
  Settings** entry in the Steam library context menu.

[0.0.1]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.1
