# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release ships `Decky OptiScaler.zip`, installable through Decky Loader's
*Install from URL* (Developer mode).

## [0.0.1] - 2026-08-20

First public release. Bundles **OptiScaler v0.9.4**, so installing works offline
and every game gets the same build.

### Added

- **Per-game install.** Steam libraries are read from `libraryfolders.vdf`
  (SD card included), and any folder can be added as a custom library. The
  install folder is scored automatically — Unreal's `Binaries/Win64`, launcher
  layouts like Cyberpunk's `bin/x64` — and the pick can be overridden by hand.
- **Automatic setup from the wiki.** Games are matched against the OptiScaler
  [Compatibility List](https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List),
  with a search box to pin the right entry. Setup is a three-step checklist —
  the DLL under the filename the entry names, the Steam launch options, the
  settings the entry lists — and every line names the wiki field it came from
  before anything is written. Anything the plugin cannot place is shown rather
  than guessed at.
- **Basic and Advanced settings.** Basic is four choices that drive several INI
  keys at once; Advanced exposes all 288 options across 34 sections. Controls,
  ranges and help text are generated from the comments in the shipped
  `OptiScaler.ini`, and edits preserve every comment in the file.
- **Live in-game control.** A bundled ASI plugin applies frame generation,
  FidelityFX FG version and upscaler changes to the running game, next to a
  live frame rate readout and the backend the game actually created. Every
  discovery check fails closed: if anything cannot be validated the plugin
  writes nothing and reports why.
- **Quick Access panel.** Two tabs — the running game's live controls and a
  filtered game list — for changing settings without leaving the game.
- **Nothing gets lost.** Any file an install would overwrite is moved into
  `decky_optiscaler_backup_files/` and restored on uninstall, tracked in a
  manifest.
- **Odds and ends.** `OptiScaler.log` is parsed for the created backend, the GPU
  and the Proton version. [OptiPatcher](https://github.com/optiscaler/OptiPatcher)
  is bundled for the games that need it. An **OptiScaler Settings** entry is
  added to the game's Steam library context menu.

[0.0.1]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.1
