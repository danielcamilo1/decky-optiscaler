# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release ships `Decky OptiScaler.zip`, installable through Decky Loader's
*Install from URL* (Developer mode).

## [0.0.4] - 2026-08-21

### Added

- **The exact FSR version, where the backend id could only say "FSR 3.X/4".**
  One OptiScaler backend id covers every FSR from 2.3.4 to 4.1.1, which is why
  it is named that way — but the running game knows which one it built, and its
  overlay prints it. The Quick Access panel's upscaler tile now says the same
  thing the overlay's title bar does.
- **A second upscaler control, for which version of FSR to run.** The overlay
  asks two questions under "FFX Settings" and this now asks both: which upscaler
  (FSR / XeSS / DLSS) and, under it, which FSR. The versions offered are the
  ones the running game's FidelityFX runtime reports rather than the three the
  shipped INI documents, and picking one applies without a restart wherever an
  upscaler switch would — OptiScaler rebuilds the feature and re-reads the
  index, which is exactly what its own "Change Upscaler" button does.
- **Two frame rates while frame generation is running.** Frame generation gives
  a game two of them and the old tile only ever showed one. Both now appear
  whenever frame generation is on: what the game renders, and what reaches the
  screen. OptiScaler times both sides for its own overlay and the in-game plugin
  reads both — but which measurement is which is worked out from the numbers
  rather than assumed, because interpolation can only ever add frames and the
  frame counter does not always count the frames that reach the screen. A
  reading that agrees with neither is refused instead of guessed at. The setting
  being on is not the same as the generator running — OptiScaler reports FSR-FG
  as off until the game selects frame generation in its own options — so when
  the two rates come out equal the frame-generation tile says "idle" rather than
  leaving two identical numbers to look like a fault.
- **A live-control readout that says why a number is missing.** The manual setup
  page prints both raw frame intervals, the raw frame count and which build of
  the in-game plugin produced them. A missing rate has several causes with
  different fixes, and they are indistinguishable from the rate alone.
- **A warning when a game's in-game plugin is out of date.** Updating this
  plugin does not update any game — the ASI is copied into the game's folder at
  set-up time and stays at that version — so a feature added here can be missing
  from a game for reasons that have nothing to do with the feature. The Quick
  Access panel marks it, and the live-control page offers the reinstall once the
  game is closed.

### Fixed

- **A dropdown could keep a name the list no longer uses.** Both FidelityFX
  version lists start as the shipped INI's snapshot and are replaced the moment
  the running game reports its own — under an index that does not move. Steam's
  dropdown builds its label once and keeps it, and the control was rebuilt only
  when its *value* changed, so the first name stayed on screen. It showed as the
  full page and the Quick Access panel disagreeing about the same install: the
  panel builds its controls only after the config read resolves, by which time
  the first live poll has landed, so it got "FSR 4.1.1" and the page was stuck
  on "FSR 4.0.2". Controls are now rebuilt when what they display changes, not
  only when the value does.
- **Asking for FSR 4 could silently give you FSR 3.** OptiScaler only reaches
  FSR 4 when the upgrade path is on, an RDNA 4 GPU is present, or the int8
  override is set — none of which is true by default on a Steam Deck — so
  choosing an FSR 4 version on its own fell back to FSR 3 with nothing said
  about it. Choosing one now switches on the path that makes it reachable.
  Choosing an older version does not switch it back off: that flag makes FSR 4
  available rather than requested.
- **A game on the SD card reported itself as "writing to a different folder".**
  Proton gives each library its own drive letter, so the in-game plugin reports
  `S:\steamapps\common\…` where the plugin is managing
  `/run/media/…/steamapps/common/…` — two paths with no shared tail. A perfectly
  healthy install was told to reinstall its live control. The drive letter is
  now dropped and what is left compared folder by folder.
- **The newest FSR version was named after the wrong build.** With no game
  running there is nothing to ask, and the fallback came from the reference INI,
  which documents whatever FidelityFX the OptiScaler release *it* shipped with
  carried — "0 = FSR 4.0.2". The library bundled here is 4.1.1. The version is
  now read from the FidelityFX library sitting next to the game, and the shipped
  archive is checked against its pinned hash so this cannot drift again.

[0.0.4]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.4

## [0.0.3] - 2026-08-20

### Fixed

- **The upscaler dropdown lagged one change behind.** Closing the Quick Access
  panel unmounts it — which is what you do to look at the game after changing
  something — and settings are written on a short debounce that is flushed on
  the way out. Reopening started a read that could be issued before that write
  landed, so the panel came up showing the value from *before* the change, and
  doing it again showed the one before that, while the running game was correct
  throughout. What this plugin writes is now remembered outside the panel and
  laid over anything a read brings back until the file agrees. Basic mode's
  picks also skip the debounce: it is there so a slider does not write per
  frame, and a dropdown is pressed once.
- **The FFX FG version control disappeared on some games.** It was hidden
  whenever the game's FidelityFX runtime reported fewer than two generators.
  It now stays on screen with whatever the game offers — quiet when there is
  only one, because which generator the game got is still worth seeing — and is
  shown whenever the game reports a list at all, which is a firmer answer than
  an INI whose FG output reads "auto".

[0.0.3]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.3

## [0.0.2] - 2026-08-20

Fixes for the Quick Access panel's live controls, where a dropdown could end up
showing something other than what was picked.

### Fixed

- **A control could display a value it was not set to.** Steam's dropdown shows
  the option whose value matches what it is given, and has nothing to fall back
  on when none of them does — so it kept the label it drew last, which read as
  the control ignoring the choice just made. Basic mode's four dropdowns and the
  Advanced page's option lists now always offer whatever the file is actually
  set to, named after itself when no preset covers it: an upscaler set from the
  Advanced page is no longer shown as "Auto", and a frame-generation pair
  written by a wiki plan is no longer shown as "FSR FG".
- **Picking the third FidelityFX frame generator did nothing.** The shipped
  `OptiScaler.ini` documents the two its own build offered, but each game's
  FidelityFX runtime reports its own list and the panel offers what the game
  reports. Anything past the second was refused by the config writer, so it
  reached neither the file nor the running game while still appearing selected.
- **Refused settings are reported instead of left on screen.** A value the
  writer will not take is now put back to what the file says, and the Quick
  Access panel says which key was refused — previously the control kept showing
  a change that existed nowhere.
- **Re-reading the config no longer undoes an edit or blanks the panel.** Edits
  are written on a short debounce, so a read landing in that window used to
  overwrite them with the file's older contents, and the panel would drop back
  to "Reading config…" — taking the live upscaler switch with it. A read now
  keeps the controls on screen and lays any newer edit back on top.
- **The live upscaler switch works for DX11 games.** It compared the pick
  against the DX12 and Vulkan backends only, so a game reporting its upscaler
  under DX11 was compared against nothing.

[0.0.2]: https://github.com/danielcamilo1/decky-optiscaler/releases/tag/v0.0.2

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
