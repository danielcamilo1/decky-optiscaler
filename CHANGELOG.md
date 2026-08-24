# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release ships `Decky OptiScaler.zip`, installable through Decky Loader's
*Install from URL* (Developer mode).

## [0.0.5.1-testing] - 2026-08-24

A prerelease on the `testing` branch. Bundled OptiScaler release is unchanged at
0.9.4.

### Added

- **Games that need REFramework are set up with it, automatically.** Nine
  entries on the compatibility list — the Resident Evil titles, Devil May Cry 5,
  Monster Hunter Wilds, PRAGMATA — say in prose that OptiScaler does nothing in
  that game unless [REFramework](https://github.com/praydog/REFramework) is
  already next to the executable, because REF is what exposes the upscaler the
  game will not expose itself. The plugin read straight past that: those games
  got an install that reported success, set the launch options, and changed
  nothing on screen, with no error anywhere to go looking for. The requirement
  is now read out of the entry, stated on the checklist before anything is
  written, and the right build is downloaded and installed with OptiScaler as
  one step.
- **The two REFramework builds are told apart, because they are not
  interchangeable.** praydog's nightly is one unified build for every game it
  supports; the pd-upscaler branch is built per game and is what the entries
  pairing REF with PureDark's UpscalerBasePlugin need, since that plugin does
  not support the unified build. Which one an entry wants is read from the entry
  itself — the pd entries name the branch and the plugin, the nightly ones do
  not — and only the per-game asset name is curated, because "RE2.zip" is not
  reachable from "Resident Evil 2 (2019)" by any matching rule and the wrong
  game's build is a crash on launch. A game with no known asset says so and
  links the release page rather than falling back to a near-enough one.
- **REFramework gets a `WINEDLLOVERRIDES` entry of its own.** For the same
  reason OptiScaler's proxy needs one: Proton ships its own `dinput8` and loads
  that in preference to the game folder. The wiki never mentions it — those
  pages are written for Windows, where the folder wins — which makes it the one
  instruction in the whole set-up that cannot come from the entry, and without
  it a set-up that followed the wiki to the letter would put REF in place and
  never load it.
- **`PDPerfPlugin.dll` is named rather than pretended about.** PureDark's
  UpscalerBasePlugin is on Nexus Mods behind a login, so nothing here can fetch
  it, and the pd-upscaler games do not work without it. It gets a row of its own
  on the checklist with the link, marked as the user's job, and ticks when the
  file turns up next to the executable — an install that reports success and
  leaves the game rendering exactly as before is the failure this whole feature
  exists to stop, and it would be absurd to reintroduce it one file further
  down.
- **REFramework can be added on its own,** to a game already set up or after a
  download that failed. A 13 MB download over a handheld's connection is the
  part that fails, and making somebody reinstall OptiScaler to retry it is a
  poor answer to a flaky network.

### Fixed

- **Wiki pages whose name contains brackets are downloaded again.** The
  compatibility list writes `[Resident Evil 2 (2019)](Resident-Evil-2-(2019))`,
  and the link parser stopped at the inner bracket: the page came out as
  `Resident-Evil-2-(2019`, which the wiki does not serve, so the detail page for
  every parenthesised title silently never downloaded. Those are exactly the
  Resident Evil entries whose settings — `Dxgi=false`, `OverlayMenu=false` — and
  REFramework instructions live on the page rather than in the notes column, so
  automatic set-up had been working from half an entry for them. Dead Space
  (2023) and Elden Ring were affected too.
- **The bundled compatibility list has been regenerated,** so an offline Deck
  gets the corrected page names rather than the truncated ones.

### Changed

- Anything REFramework installs goes through the same contract as every other
  file this plugin places: a `dinput8.dll` the game already had is set aside and
  put back on removal, and both REF files are in the manifest, so removing
  OptiScaler removes them too.

## [0.0.5] - 2026-08-23

Released after testing across the `0.0.4.x-testing` prereleases on the `testing`
branch. Bundled OptiScaler release is unchanged at 0.9.4.

### Added

- **Removing OptiScaler asks what to do with the Steam launch options.**
  Installing it is two changes, not one — a folder full of files and a
  `WINEDLLOVERRIDES` entry in Steam — and removing it only ever undid the first.
  A game that had been "removed" kept an override for a DLL that was no longer
  there, and on the one path that did clear the field it cleared whatever else
  the game had in it too. Removing now offers: put back exactly what was there
  before the install, take only the OptiScaler override out and keep the rest,
  or change nothing. The answer can be remembered.
- **The launch options are backed up the way files are.** Installing records
  what Steam was passing beforehand into a plain text file next to the manifest
  and the backup folder, and removing takes it out again. Written once per
  install, so a reinstall — or the launch-options step being switched off and on
  — cannot overwrite the original with the override this plugin itself wrote.
  Three states stay distinct, and each means something different: recorded and
  empty (the game had none, so the field can be cleared outright), recorded and
  not empty (restore it verbatim), and not recorded at all (only the override
  this plugin recognises comes out; the rest is not ours to guess about).
- **A Settings tab on the main page.** Both launch-options prompts offer
  "Remember my choice", and an answer that can only be given and never taken
  back is a trap: every stored answer is listed by name with what it will do and
  a row that puts the question back, alongside the switch that stops answers
  being kept at all — which also drops the ones already stored, so turning it on
  again does not silently restore decisions just disowned. The same tab reports
  the compatibility list: how many games are on it, how old it is and where it
  came from, and when a refresh is failing, the error, the address and which
  certificates were tried, with a button to fetch it again.
- **The plugin ships a copy of the compatibility list.** A Deck that has never
  reached the wiki matches games against 685 bundled entries instead of
  reporting "no wiki entry matched this game" for every game it owns — which was
  indistinguishable from the wiki being broken. It is only a floor: the first
  successful fetch replaces it. `scripts/fetch_compat_seed.py` refreshes it
  before a release.
- **The manual setup page states what Steam is passing and what was recorded**
  before the install. "The plugin cannot read them" and "they are empty" look
  identical from the outside.

### Changed

- **The compatibility list is read from cache and refreshed behind the answer.**
  A handheld is regularly asleep, offline, or on a network that resolves and
  does not route, and the wiki used to sit in front of every question asked of
  it: a cache older than a day was thrown away rather than used, so each of
  those cost a full timeout before anything appeared. Whatever is on disk is now
  returned at once — stale or not — and the refresh runs behind it, single-flight
  so opening three games in a row is one download rather than three. Detail
  pages follow the same rule.
- **A refresh that brings something new updates what is on screen.** The list
  carries a content fingerprint, so "something arrived" is exactly "the
  fingerprint changed"; a refresh that brought back the same list redraws
  nothing.
- **A failed refresh cannot make things worse.** Nothing is written unless the
  download both succeeded and parsed, so a working cache is never turned into an
  empty one. The failure is shown next to the list it could not replace, rather
  than replacing the list with an error.

### Fixed

- **Removing OptiScaler no longer leaves its launch options behind.** See above.
- **The launch options are read from three sources, not one.**
  `SteamClient.Apps.GetAppLaunchOptions` is undocumented and absent from some
  client builds entirely, and everything here depended on it. Where it is
  missing, every launch-options question answered itself with "cannot tell" and
  every action taken on that answer became nothing at all. The app details store
  the library's own Properties dialog uses is tried next, and finally
  `localconfig.vdf` — Steam's own record on disk, which depends on no
  undocumented method existing.
- **A wiki that will not download is no longer reported as "your game is not on
  the list".** The two produced the same empty result and the setup checklist
  printed the same sentence for each, so a network fault presented as every game
  in the library being unknown to the wiki. They are now separated, the failure
  is printed in the words of whatever actually failed, and there is a **Try
  again** button — there was previously no way to retry from the interface at
  all.
- **A stalled connection is retried over IPv4.** A router advertising IPv6 it
  cannot route is the classic works-on-one-network fault, and Python's urllib
  has no Happy Eyeballs to fall back the way a browser does. A server that
  answered is not retried, because asking again says the same thing.
- **The last-resort unverified TLS context no longer builds its own trust
  store.** It was created with `create_default_context`, which reads the system
  certificates — so on the one machine where that is what is broken, the
  fallback meant to survive it was the single construction that could throw the
  whole chain away.

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
