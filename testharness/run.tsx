import React from "react";
import { createRoot } from "react-dom/client";
// React 18.3 exports act itself; the react-dom/test-utils re-export logs a
// deprecation warning on every run, which the pass condition below counts.
import { act } from "react";
import { fixtures, calls } from "@decky/api";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { ManagerPage } from "../src/components/ManagerPage";
import { QuickPanel } from "../src/components/QuickPanel";

// ---- fixtures mirroring what the Python backend returns --------------------
const iniValues: Record<string, Record<string, string>> = {};
for (const o of GENERATED_OPTIONS) {
  iniValues[o.section] = iniValues[o.section] ?? {};
  iniValues[o.section][o.key] = "auto";
}
iniValues.FrameGen.Enabled = "true";
iniValues.Upscalers.Dx12Upscaler = "fsr31";

const detail = {
  path: "/games/Cyberpunk 2077",
  name: "Cyberpunk 2077",
  target: "/games/Cyberpunk 2077/bin/x64",
  target_is_saved: false,
  candidates: [
    { path: "/games/Cyberpunk 2077/bin/x64", relative: "bin/x64", score: 53, executables: ["Cyberpunk2077.exe"] },
    { path: "/games/Cyberpunk 2077", relative: ".", score: -40, executables: ["REDprelauncher.exe"] },
  ],
  install: {
    path: "/games/Cyberpunk 2077/bin/x64",
    installed: true, filename: "dxgi.dll", managed: true, version: "0.9.4",
    installed_at: 1700000000, ini_present: true, ini_path: "/x/OptiScaler.ini",
    log_present: true, log_path: "/x/OptiScaler.log",
    candidates: ["dxgi.dll"], extra_proxies: [],
    backup_dir: "/games/Cyberpunk 2077/bin/x64/decky_optiscaler_backup_files",
    backed_up: ["dxgi.dll", "amd_fidelityfx_upscaler_dx12.dll"],
    fsr4: { files: { "amdxcffx64.dll": false, "amdxc64.dll": false }, ready: false,
            required: ["amdxcffx64.dll", "amdxc64.dll"],
            // The version OptiScaler's overlay prints in its FFX Settings box.
            ffx: { present: true, name: "amd_fidelityfx_upscaler_dx12.dll",
                   version: "4.1.1.2740", fsr4_capable: true } },
  },
  fsr4_sources: [{ path: "/home/deck/fgmod/fsr4-rdna2-3", files: ["amdxcffx64.dll", "amdxc64.dll"] }],
  ini_info: { present: true, legacy: true, keys: 288 },
  wiki_entry: null,
  gpu: { names: ["Van Gogh (Steam Deck)"], name: "Van Gogh (Steam Deck)", gfx: "gfx1033",
         vendor: "amd", generation: "RDNA2", fsr4: "unsupported" },
  launch_option: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
  writable: true,
};

Object.assign(fixtures, {
  get_status: {
    version: "0.9.4", archive_present: true, archive_path: "/p/bin/a.7z",
    extracted: true, extract_path: "/p/payload", extractor: "7z",
    optiscaler_version: "0.9.4",
    proxy_filenames: ["dxgi.dll","winmm.dll","version.dll","dbghelp.dll","d3d12.dll","wininet.dll","winhttp.dll","OptiScaler.asi"],
    default_proxy: "dxgi.dll",
  },
  prepare_payload: { ok: true },
  list_libraries: [
    { path: "/home/deck/.local/share/Steam", name: "Internal Storage", source: "steam", game_count: 2, available: true },
    { path: "/run/media/SD", name: "SD Card (SD)", source: "custom", game_count: 1, available: true },
  ],
  list_games: [
    { appid: "1091500", name: "Cyberpunk 2077", path: "/games/Cyberpunk 2077", source: "steam", size_on_disk: 1, installed: true, filename: "dxgi.dll", install_path: "/games/Cyberpunk 2077/bin/x64" },
    { appid: "2358720", name: "Black Myth Wukong", path: "/games/BMW", source: "steam", size_on_disk: 1, installed: false, filename: null, install_path: null },
  ],
  // The flat list the main page leads with: enough entries to page through.
  list_all_games: [
    { appid: "1091500", name: "Cyberpunk 2077", path: "/games/Cyberpunk 2077", source: "steam", library: "Internal Storage", size_on_disk: 1, installed: true, filename: "dxgi.dll", install_path: "/games/Cyberpunk 2077/bin/x64" },
    ...Array.from({ length: 27 }, (_, i) => ({
      appid: String(3000000 + i), name: `Test Game ${String(i + 1).padStart(2, "0")}`,
      path: `/games/test-${i}`, source: "steam", library: "Internal Storage",
      size_on_disk: 1, installed: false, filename: null, install_path: null,
    })),
  ],
  get_game: detail,
  find_running_game: { found: true, appid: "1091500", name: "Cyberpunk 2077", path: "/games/Cyberpunk 2077", detail },
  get_recommendation: {
    matched: true, searched: ["Cyberpunk 2077"], entry_count: 685,
    list_available: true, near_misses: [], game: "Cyberpunk 2077", filename: "dxgi.dll",
    filename_source: "wiki entry", alternatives: ["wininet.dll"],
    compatibility: "✅", inputs: "DLSS, FSR3, FSR3.1/4, XeSS",
    notes: "Use [this mod](http://x) to fix it.", optipatcher: false,
    wiki_url: "https://x", detail: { "FG Inputs": "DLSSG via Streamline", "Known Issues": "Avoid FSR-FG inputs!" },
    match_score: 1.0, list_meta: { source: "network", fetched_at: 1, error: null },
  },
  // What the wiki lookup and the plan built from it look like together. The
  // settings and the FG pair are the shape autoplan.py produces from a real
  // entry: keys it resolved against the schema, each citing the field it was
  // read out of, plus the things it could not place.
  get_auto_plan: {
    recommendation: {
      matched: true, searched: ["Cyberpunk 2077"], entry_count: 685,
      list_available: true, near_misses: [], game: "Cyberpunk 2077", filename: "dxgi.dll",
      filename_source: "wiki entry", alternatives: ["wininet.dll"],
      compatibility: "✅", inputs: "DLSS, FSR3, FSR3.1/4, XeSS",
      notes: "Use [this mod](http://x) to fix it.", optipatcher: false,
      wiki_url: "https://x", detail: { "FG Inputs": "DLSSG via Streamline", "Known Issues": "Avoid FSR-FG inputs!" },
      match_score: 1.0, list_meta: { source: "network", fetched_at: 1, error: null },
    },
    plan: {
      available: true, enabled: false, game: "Cyberpunk 2077", source: "wiki entry",
      wiki_url: "https://x", filename: "dxgi.dll", filename_source: "wiki entry",
      optipatcher: true,
      launch_flags: ["-dx12"],
      launch_options: 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12',
      settings: [
        { section: "Spoofing", key: "Dxgi", value: "false", label: "Dxgi",
          source: "wiki entry, “Settings”" },
        { section: "Hotfix", key: "RestoreComputeSignature", value: "true",
          label: "RestoreComputeSignature", source: "wiki entry, “Known Issues”" },
      ],
      framegen: {
        input: "dlssg", output: "fsrfg", input_label: "DLSSG via Streamline",
        output_label: "FSR FG", source: "wiki entry, “FG Inputs”",
        detail: "DLSSG via Streamline",
      },
      unresolved: [{ text: "DontCreateD3D12DeviceForLuma=true (not an OptiScaler setting)",
                     source: "wiki entry, “Notes”" }],
      warnings: [],
    },
  },
  set_auto_mode: { ok: true, enabled: true },
  auto_install: { ok: true, applied: [], rejected: [] },
  apply_auto_settings: { ok: true, applied: [] },
  read_config: { ok: true, path: "/x/OptiScaler.ini", values: iniValues, modified: 1 },
  write_config: { ok: true, applied: [], rejected: [] },
  reset_config: { ok: true },
  get_monitor: {
    path: "/x", log_path: "/x/OptiScaler.log", log_present: true, log_size: 2048,
    log_modified: Date.now() / 1000, logging_enabled: "true",
    state: { upscaler: "FSR 4.0.2", proxy: "dxgi.dll", gpu: "AMD Custom GPU 0405", game_name: "Cyberpunk 2077", wine: "9.0", game_exe: "Cyberpunk2077.exe", game_version: "2.2", optiscaler_version: null },
    counts: { info: 40, warning: 2, error: 1 },
    frame_generation: ["XeFG"],
    problems: [{ time: "12:00:00.0", level: "error", message: "Failed to create FG context" }],
    recent: [{ time: "12:00:00.0", level: "info", message: "OptiScaler working as dxgi.dll" }],
    configured: { fg_enabled: "true", fg_input: "fsrfg" },
    total_lines: 43,
  },
  clear_log: { ok: true },
  get_live_status: {
    asi_installed: true, asi_available: true, attached: true, ready: true, state: "ready",
    load_enabled: true, loaded_by_optiscaler: true,
    error: null, seq: "1", can_switch_upscaler: true, age: 1.0,
    live_keys: ["FrameGen.Enabled", "Upscalers.Dx12Upscaler"],
    fps: 40.4, fg_enabled: true, frames: 12000, backend_entries: 1,
    upscaler: { dx12: "fsr31", dx11: null, vulkan: null },
    pending_backend: null,
    // What the in-game plugin read out of State: the frame generators the FFX
    // SDK offered *this* game, which is what the FFX FG control lists when
    // there is a game to ask.
    schema: 4, can_change_fg: true, fg_index: 1,
    ffx_fg_versions: ["4.0.0", "3.1.6"],
  },
  switch_upscaler: { ok: true, sent: true, backend: "xess" },
  get_pref: { key: "launch_options", value: null },
  set_pref: { ok: true },
  get_live_log: { lines: ["decky_optiscaler_live loaded", "config at 0x1234"] },
  install_live: { ok: true },
  get_fsr4_info: { status: { files: {}, ready: false, required: [] }, sources: [], gpu: {} },
  verify_install: {
    ok: true, path: "/x", complete: true, problems: [],
    files: [{ name: "dxgi.dll", present: true, matches_payload: true, size: 1, expected_size: 1 }],
    ffx_upscaler: { present: true, version: "4.1.1.2740", fsr4_capable: true },
  },
  search_wiki: { results: [
    { name: "Forza Horizon 5", page: "Forza-Horizon-5", compatibility: "OK", inputs: "DLSS", score: 1 },
  ], entry_count: 685, meta: { error: null } },
  set_wiki_entry: { ok: true },
  import_fsr4_files: { ok: true, imported: ["amdxcffx64.dll"] },
  set_logging: { ok: true },
  browse: { path: "/home/deck", parent: "/home", entries: [{ path: "/home/deck/Games", name: "Games" }] },
  add_custom_library: { ok: true },
  remove_custom_library: { ok: true },
  set_game_target: { ok: true },
  install: { ok: true },
});

// ---- harness ---------------------------------------------------------------
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function findAll(node: Element, selector: string) {
  return Array.from(node.querySelectorAll(selector));
}

async function render(name: string, element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return { name, host, root };
}

(async () => {
  console.log("=== rendering QuickPanel (game running, installed) ===");
  const qp = await render(
    "QuickPanel",
    <QuickPanel
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onOpenManager={() => {}}
    />
  );
  const toggles = findAll(qp.host, '[data-mock="ToggleField"]').length;
  const drops = findAll(qp.host, '[data-mock="DropdownItem"]').length;
  console.log(`  controls: ${toggles} toggles, ${drops} dropdowns`);
  console.log(`  text includes game name: ${qp.host.textContent!.includes("Cyberpunk 2077")}`);

  // The sidebar panel is the plugin's front door, so the tabs and the games
  // list have to be here and not only on the full page.
  const qpTabs = findAll(qp.host, "[data-tab]").map((n) => n.getAttribute("data-tab"));
  console.log(`  sidebar tabs: ${qpTabs.join(", ")}`);
  const activeTab = findAll(qp.host, '[data-tab][data-active="true"]')[0];
  console.log(`  opens on the running game: ${activeTab?.getAttribute("data-tab") === "now"}`);
  console.log(`  live fps shown: ${/\d+(\.\d+)?\s*(fps|FPS)/.test(qp.host.textContent!)}`);

  // The frame-generation state has to sit with the toggle that changes it,
  // not in a section the user has to scroll back to.
  console.log(`  frame generation state shown inline: ${/In game:\s*(ON|OFF)/.test(qp.host.textContent!)}`);
  // The FFX FG list is the running game's answer, not the shipped ini's, and
  // it is named the way the overlay's own combo names it.
  console.log(`  ffx fg versions come from the running game: ${
    qp.host.textContent!.includes("FSR 3.1.6")}`);

  const upscalerDrop = findAll(
    qp.host,
    '[data-mock="DropdownItem"][data-label="Override upscaler with"]'
  )[0];
  const upscalerLabels = findAll(upscalerDrop, "[data-opt]").map((n) => n.textContent);
  console.log(`  DLSS not offered on an AMD GPU: ${!upscalerLabels.includes("DLSS")}`);

  // The switch is an action, not a permanent control: it appears only once a
  // different upscaler has been picked.
  console.log(`  no upscaler switch before a change: ${!qp.host.textContent!.includes("Switch now")}`);
  await act(async () => {
    (findAll(upscalerDrop, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  picking one offers the live switch: ${qp.host.textContent!.includes("Switch now")}`);

  // FG method is read when the swapchain is created, so it cannot apply live.
  const methodDrop = findAll(qp.host, '[data-mock="DropdownItem"][data-label^="Method"]')[0];
  await act(async () => {
    (findAll(methodDrop, '[data-opt-value="xefg"]')[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  changing the FG method warns about the restart: ${
    qp.host.textContent!.includes("Restart the game to apply")}`);

  // Over a running game the controls that act now come first; the one that
  // cannot until the next launch is last, under its own heading.
  {
    const order = (label: string) =>
      findAll(qp.host, '[data-mock="DropdownItem"]').findIndex(
        (n) => n.getAttribute("data-label") === label
      );
    console.log(`  restart-only control comes after the live ones: ${
      order("Method") > order("Override upscaler with") &&
      order("Method") > order("FFX FG version")}`);
    console.log(`  and says so as a heading: ${
      qp.host.textContent!.includes("Needs a restart")}`);
  }

  const gamesTab = findAll(qp.host, '[data-tab="games"]')[0] as HTMLElement;
  await act(async () => {
    gamesTab.click();
  });
  await settle();
  const qpGames = qp.host.textContent!;
  // "Now Playing" is the tab's own label, so the body is what has to change.
  console.log(`  switching to Games swaps the body: ${!qpGames.includes("All settings & logs")}`);
  console.log(`  sidebar lists games: ${qpGames.includes("Test Game 01")}`);
  console.log(`  sidebar pages at 20: ${qpGames.includes("Test Game 19") && !qpGames.includes("Test Game 20")}`);
  console.log(`  sidebar offers the next page: ${/Show next \d+ of \d+ more/.test(qpGames)}`);
  console.log(`  sidebar links to the full page: ${qpGames.includes("Libraries & all settings")}`);
  // Filters, not tabs: they narrow the same list rather than swapping the view.
  // Recent is absent here because the harness has no Steam client to ask for a
  // last-played time, which is exactly when it must not be offered.
  const filters = findAll(qp.host, "[data-filter]").map((n) => n.getAttribute("data-filter"));
  console.log(`  sidebar filters: ${filters.join(", ")}`);
  await act(async () => {
    (findAll(qp.host, '[data-filter="setup"]')[0] as HTMLElement).click();
  });
  await settle();
  const setUpOnly = qp.host.textContent!;
  console.log(`  filtering to the ones set up drops the rest: ${
    setUpOnly.includes("Cyberpunk 2077") && !setUpOnly.includes("Test Game 01")}`);
  await act(async () => {
    (findAll(qp.host, '[data-filter="all"]')[0] as HTMLElement).click();
  });
  await settle();

  // And back, without losing the running game.
  const nowTab = findAll(qp.host, '[data-tab="now"]')[0] as HTMLElement;
  await act(async () => {
    nowTab.click();
  });
  await settle();
  console.log(`  switching back restores Now Playing: ${
    qp.host.textContent!.includes("All settings & logs")}`);

  console.log("\n=== rendering ManagerPage (main page) ===");
  const mp = await render("ManagerPage", <ManagerPage />);
  const mpTabs = findAll(mp.host, "[data-tab]").map((n) => n.getAttribute("data-tab"));
  console.log(`  main tabs: ${mpTabs.join(", ")}`);
  const mpText = mp.host.textContent!;
  // Every tab's content is rendered by the mock, so all three are visible here.
  console.log(`  games listed by name: ${mpText.includes("Cyberpunk 2077")}`);
  console.log(`  library shown for each game: ${mpText.includes("Internal Storage")}`);
  console.log(`  custom library listed: ${mpText.includes("SD Card")}`);
  console.log(`  games are paged, not all 28 at once: ${!mpText.includes("Test Game 27")}`);
  console.log(`  first page shows 20: ${mpText.includes("Test Game 19") && !mpText.includes("Test Game 20")}`);
  console.log(`  offers the next page: ${/Show next \d+ of \d+ more/.test(mpText)}`);
  console.log(`  running game leads the page: ${mpText.includes("Cyberpunk 2077")}`);
  console.log(`  no dead steam-menu status row: ${!mpText.includes("Steam menu shortcut")}`);

  // -- opening the page at one game -----------------------------------------
  // Picking a game used to land on the page's Now Playing tab: the deep link
  // travelled as a query string and the Steam client's router does not hand
  // that back to the route it renders. It travels in-process now, so both the
  // Quick Access panel (folder and name) and the Steam context menu (an app id
  // to look up) reach the game they named.
  console.log("\n=== opening the page at one game ===");
  {
    const { openManager } = await import("../src/navigation");
    openManager({ path: detail.path, name: detail.name, appid: "1091500" });
    const deep = await render("ManagerPage (deep link)", <ManagerPage />);
    console.log(`  a named game opens its own page, not Now Playing: ${
      findAll(deep.host, '[data-tab="now"]').length === 0 &&
      deep.host.textContent!.includes("Installed as")}`);

    // Nothing named: the library list, as before.
    const plain = await render("ManagerPage (no target)", <ManagerPage />);
    console.log(`  opening it with no game still lists them: ${
      findAll(plain.host, '[data-tab="games"]').length === 1}`);

    // The context menu knows only the app id, and the page is already open.
    await act(async () => {
      openManager({ appid: "1091500" });
    });
    await settle();
    console.log(`  an app id is looked up, even while the page is open: ${
      findAll(plain.host, '[data-tab="now"]').length === 0 &&
      plain.host.textContent!.includes("Installed as")}`);
  }

  console.log("\n=== steam library context menu ===");
  {
    const { __testing: menu } = await import("../src/libraryContextMenu");
    // The shapes Steam actually renders: a game menu carries an item whose
    // handler mentions launchSource, and Properties mentions AppProperties.
    const gameMenu = () => [
      { key: "a", props: { onSelected: () => "launchSource: LibraryDetails" } },
      { key: "b", props: { onSelected: () => "AddToHiddenCollection" } },
      { key: "properties", props: { onSelected: () => "AppProperties(x)" } },
    ];
    const screenshotMenu = [
      { key: "s1", props: { onSelected: () => "UploadScreenshot" } },
      { key: "s2", props: { onSelected: () => "DeleteScreenshot" } },
    ];

    console.log(`  game menu recognised: ${menu.isAppContextMenu(gameMenu())}`);
    console.log(`  other menus left alone: ${!menu.isAppContextMenu(screenshotMenu)}`);

    const items = gameMenu();
    menu.spliceMenuItem(items, 1091500);
    const idx = items.findIndex((x: any) => x?.key === menu.MARKER);
    const propIdx = items.findIndex((x: any) => x?.key === "properties");
    console.log(`  entry inserted: ${idx !== -1}`);
    console.log(`  entry sits above Properties: ${idx !== -1 && idx < propIdx}`);
    console.log(`  entry is labelled "${menu.MENU_LABEL}": ${
      (items[idx] as any)?.props?.children === menu.MENU_LABEL}`);

    // Steam re-renders the same menu; it must not stack duplicates.
    menu.removeExisting(items);
    menu.spliceMenuItem(items, 1091500);
    console.log(`  no duplicates after a re-render: ${
      items.filter((x: any) => x?.key === menu.MARKER).length === 1}`);

    // The appid captured on first render goes stale when Steam reuses the menu.
    const stale = 1018880;
    const withOverview: any[] = [
      { _owner: { pendingProps: { overview: { appid: 1091500 } } }, props: {} },
    ];
    console.log(`  stale appid replaced from the menu's own overview: ${
      menu.resolveAppid(withOverview, stale) === 1091500}`);
    const newClient: any[] = [{ props: { children: { app: { appid: 2358720 } } } }];
    console.log(`  newer clients resolved through props.children: ${
      menu.resolveAppid(newClient, undefined) === 2358720}`);
    const noAppid = menu.patchMenuItems([], undefined);
    console.log(`  nothing inserted without an appid: ${noAppid === undefined}`);
  }

  console.log("\n=== rendering GameDetail with every tab ===");
  const { GameDetail } = await import("../src/components/GameDetail");
  const gd = await render(
    "GameDetail",
    <GameDetail
      gamePath="/games/Cyberpunk 2077"
      gameName="Cyberpunk 2077"
      appid="1091500"
      status={fixtures.get_status}
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onBack={() => {}}
    />
  );
  const tabs = findAll(gd.host, "[data-tab]").map((n) => n.getAttribute("data-tab"));
  console.log(`  tabs (basic mode): ${tabs.join(", ")}`);
  console.log(`  basic FG controls present: ${gd.host.textContent!.includes("Frame multiplier")}`);
  console.log(`  basic upscaler presets named as OptiScaler names them: ${["FSR 3.X/4", "FSR 2.2.1", "XeSS"].every((n) => gd.host.textContent!.includes(n))}`);
  // Driving the running game is the Quick Access panel's job; this page is for
  // setting a game up, so it must not offer the live switch at all.
  console.log(`  settings tab has no live upscaler switch: ${!gd.host.textContent!.includes("Switch now")}`);
  console.log(`  settings tab drops the hotkey advice: ${!gd.host.textContent!.includes("in game")}`);
  console.log(`  basic FG methods named as OptiScaler names them: ${["FSR FG", "XeFG", "DLSSG via Streamline"].every((n) => gd.host.textContent!.includes(n))}`);
  console.log(`  no invented FG name for DLSSG: ${!gd.host.textContent!.includes("DLSS Frame Generation")}`);
  {
    const order = (label: string) =>
      findAll(gd.host, '[data-mock="DropdownItem"]').findIndex(
        (n) => n.getAttribute("data-label") === label
      );
    // Nothing on this page applies live, so there is nothing to sort by: the
    // method stays where it belongs, with the rest of frame generation.
    console.log(`  the full page keeps the FG method in its own section: ${
      order("Method") < order("Override upscaler with") &&
      !gd.host.textContent!.includes("Needs a restart")}`);
  }
  console.log(`  basic 2X/3X/4X multiplier is a dropdown: ${gd.host.textContent!.includes("2X") && gd.host.textContent!.includes("4X")}`);
  console.log(`  FSR4 reported from bundled SDK: ${gd.host.textContent!.includes("4.1.1.2740")}`);
  console.log(`  no false 'FSR4 missing file' claim: ${!gd.host.textContent!.includes("does not ship")}`);

  // Flip to advanced mode and re-render.
  (globalThis as any).window.localStorage.setItem("decky-optiscaler:advanced", "1");
  const gdAdv = await render("GameDetailAdvanced",
    <GameDetail gamePath="/games/Cyberpunk 2077" gameName="Cyberpunk 2077" appid="1091500"
      status={fixtures.get_status}
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onBack={() => {}} />);
  const advTabs = findAll(gdAdv.host, "[data-tab]").map((n) => n.getAttribute("data-tab"));
  console.log(`  tabs (advanced mode): ${advTabs.join(", ")}`);
  const advText = gdAdv.host.textContent!;
  console.log(`  advanced shows real upscaler names: ${advText.includes("FSR 3.X/4")}`);
  console.log(`  advanced shows OptiScaler's own FG input names: ${advText.includes("FSR 3.1 FG") && advText.includes("DLSSG via Streamline")}`);
  console.log(`  raw internal ids no longer bare: ${!/\bfsr31\b(?! —)/.test(advText.split("Filename override")[0])}`);
  (globalThis as any).window.localStorage.setItem("decky-optiscaler:advanced", "0");
  console.log(`  toggles: ${findAll(gd.host, '[data-mock="ToggleField"]').length}`);
  console.log(`  dropdowns: ${findAll(gd.host, '[data-mock="DropdownItem"]').length}`);
  console.log(`  sliders: ${findAll(gd.host, '[data-mock="SliderField"]').length}`);
  console.log(`  wiki recommendation shown: ${gd.host.textContent!.includes("wiki entry")}`);

  // -- setting a game up, as a checklist ------------------------------------
  // The Setup tab is the same three steps before and after: what will happen,
  // then what did. Everything else it used to hold is one row away.
  const setupTab = findAll(gd.host, '[data-tab="install"]')[0] as HTMLElement;
  await act(async () => { setupTab.click(); });
  await settle();
  const setupText = gd.host.textContent!;
  console.log(`  monitor is no longer a tab: ${!tabs.includes("monitor")}`);
  console.log(`  setup states what is installed: ${
    setupText.includes("Installed as") && setupText.includes("dxgi.dll")}`);
  console.log(`  the wiki step is a toggle, off until asked for: ${
    findAll(gd.host, '[data-mock="ToggleField"][data-label^="Not following the wiki"]').length === 1}`);
  console.log(`  and says what turning it on would do: ${
    setupText.includes("let the wiki keep the ones this game needs")}`);
  // Removing has to be findable without hunting: it is on the tab, not behind
  // the manual page it used to live on.
  console.log(`  removing and resetting stay on the setup tab: ${
    setupText.includes("Remove") && setupText.includes("Reset settings")}`);
  console.log(`  setup no longer shows the manual install controls: ${
    !setupText.includes("Filename override")}`);
  // Not running is not a step of setting a game up, and was being listed as
  // the last one. What the log says lives on the Logs row either way.
  console.log(`  "not running" is not a setup step: ${!setupText.includes("Not running")}`);

  // "Manual setup" opens in the tab's place, and comes back.
  await act(async () => {
    (findAll(gd.host, '[data-mock="Field"][data-label="Manual setup"]')[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  "manual setup" restores every install control: ${
    gd.host.textContent!.includes("Filename override") &&
    gd.host.textContent!.includes("Reinstall as dxgi.dll") &&
    gd.host.textContent!.includes("Steam Launch Options")}`);
  const manualText = gd.host.textContent!;
  console.log(`  and the live-control panel with them: ${
    manualText.includes("Live in-game control")}`);
  console.log(`  the launch options are spelled out there: ${
    manualText.includes("WINEDLLOVERRIDES")}`);
  console.log(`  legacy ini warning shown: ${manualText.includes("FGType")}`);
  console.log(`  backup folder mentioned: ${
    manualText.includes("decky_optiscaler_backup_files")}`);
  console.log(`  RDNA2 warning present: ${manualText.includes("RDNA 2")}`);
  // The manual panel is several screens long, so the way out is at both ends.
  console.log(`  the way back is at both ends of it: ${
    findAll(gd.host, '[data-back="setup"]').length === 2}`);
  await act(async () => {
    (findAll(gd.host, '[data-back="setup"]')[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  and back returns to the checklist: ${
    gd.host.textContent!.includes("Installed as") &&
    !gd.host.textContent!.includes("Filename override")}`);

  // The old Monitor tab, now a row.
  await act(async () => {
    (findAll(gd.host, '[data-mock="Field"][data-label="Logs"]')[0] as HTMLElement).click();
  });
  await settle();
  const logsText = gd.host.textContent!;
  console.log(`  the logs row opens what the Monitor tab used to show: ${
    logsText.includes("Write OptiScaler log")}`);
  console.log(`  with the runtime state it read out of the log: ${
    logsText.includes("FSR 4.0.2")}`);
  await act(async () => {
    (findAll(gd.host, '[data-back="setup"]')[0] as HTMLElement).click();
  });
  await settle();

  // -- a game that is not set up yet ----------------------------------------
  fixtures.get_game = { ...detail, install: { ...detail.install, installed: false } };
  const gdFresh = await render("GameDetail (not set up)",
    <GameDetail gamePath="/games/Cyberpunk 2077" gameName="Cyberpunk 2077" appid="1091500"
      status={fixtures.get_status}
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onBack={() => {}} />);
  const freshText = gdFresh.host.textContent!;
  console.log(`  a matched game says so before anything is written: ${
    freshText.includes("can be set up automatically")}`);
  console.log(`  three steps, named: ${
    freshText.includes("Install OptiScaler as") &&
    freshText.includes("Set the Steam launch options") &&
    freshText.includes("Apply the 2 settings")}`);
  console.log(`  the install step is required, the other two are toggles: ${
    findAll(gdFresh.host, '[data-mock="ToggleField"][data-label^="Set the Steam launch options"]').length === 1 &&
    findAll(gdFresh.host, '[data-mock="ToggleField"][data-label^="Apply the 2 settings"]').length === 1 &&
    freshText.includes("required")}`);
  console.log(`  the launch options are shown in full, with the wiki's flag: ${
    freshText.includes('WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12')}`);
  console.log(`  the wiki's settings are named before they are applied: ${
    freshText.includes("Dxgi=false") && freshText.includes("DLSSG via Streamline → FSR FG")}`);
  console.log(`  the button counts what will run: ${freshText.includes("Do all three")}`);
  // Switching a step off has to change what the button promises, or the
  // toggles are decoration.
  const wikiStep = findAll(gdFresh.host,
    '[data-mock="ToggleField"][data-label^="Apply the 2 settings"]')[0];
  await act(async () => {
    (findAll(wikiStep, "[data-toggle]")[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  turning one off narrows the button: ${
    gdFresh.host.textContent!.includes("Do both")}`);
  fixtures.get_game = detail;

  // -- automatic settings mode ----------------------------------------------
  const settingsTab = findAll(gd.host, '[data-tab="basic"]')[0] as HTMLElement;
  await act(async () => { settingsTab.click(); });
  await settle();
  const autoToggle = findAll(gd.host, '[data-mock="ToggleField"][data-label="Automatic"]')[0];
  console.log(`  settings offer the automatic toggle: ${Boolean(autoToggle)}`);
  console.log(`  automatic is off until asked for: ${
    !gd.host.textContent!.includes("The wiki recommends")}`);
  await act(async () => {
    (findAll(autoToggle, "[data-toggle]")[0] as HTMLElement).click();
  });
  await settle();
  const autoText = gd.host.textContent!;
  // The wiki's pair is the better starting answer, but which generator runs is
  // the user's call in either mode -- so it is printed as a recommendation
  // under the control rather than instead of it.
  console.log(`  automatic keeps the FG method, and says what the wiki advises: ${
    findAll(gd.host, '[data-mock="DropdownItem"][data-label="Method"]').length === 1 &&
    autoText.includes("The wiki recommends") &&
    autoText.includes("DLSSG via Streamline → FSR FG")}`);
  // The four the user still owns.
  console.log(`  automatic keeps frame generation on/off: ${
    findAll(gd.host, '[data-mock="ToggleField"][data-label="Frame generation"]').length === 1}`);
  console.log(`  automatic keeps the 2X/3X/4X multiplier: ${
    findAll(gd.host, '[data-mock="DropdownItem"][data-label="Frame multiplier"]').length === 1}`);
  console.log(`  automatic keeps the upscaler choice: ${
    findAll(gd.host, '[data-mock="DropdownItem"][data-label="Override upscaler with"]').length === 1}`);
  console.log(`  automatic keeps the FFX FG version: ${
    findAll(gd.host, '[data-mock="DropdownItem"][data-label="FFX FG version"]').length === 1}`);
  console.log(`  automatic says what the wiki set: ${autoText.includes("Dxgi=false")}`);
  await act(async () => {
    (findAll(autoToggle, "[data-toggle]")[0] as HTMLElement).click();
  });
  await settle();
  console.log(`  turning it off gives every option back: ${
    findAll(gd.host, '[data-mock="DropdownItem"][data-label="Method"]').length === 1}`);

  // A game with no compatibility entry has nothing to be automatic about, so
  // neither the mode strip nor the toggle exists and the panel is unchanged.
  const matchedPlan = fixtures.get_auto_plan;
  fixtures.get_auto_plan = {
    recommendation: { ...matchedPlan.recommendation, matched: false, game: null,
                      detail: {}, near_misses: [{ name: "Cyberpunk 2078", page: null, score: 0.6 }] },
    plan: { ...matchedPlan.plan, available: false, game: null, settings: [],
            framegen: null, unresolved: [], launch_flags: [] },
  };
  const gdNoEntry = await render("GameDetail (no wiki entry)",
    <GameDetail gamePath="/games/Cyberpunk 2077" gameName="Cyberpunk 2077" appid="1091500"
      status={fixtures.get_status} runningGame={null} onBack={() => {}} />);
  const noEntryText = gdNoEntry.host.textContent!;
  console.log(`  no entry means no mode choice: ${
    findAll(gdNoEntry.host, '[data-tab="auto"]').length === 0}`);
  console.log(`  no entry says so on the checklist: ${
    noEntryText.includes("No wiki entry matched this game")}`);
  console.log(`  no entry offers no automatic toggle: ${
    findAll(gdNoEntry.host, '[data-mock="ToggleField"][data-label="Automatic"]').length === 0}`);
  console.log(`  no entry points at setting it up by hand: ${
    noEntryText.includes("Manual setup")}`);
  fixtures.get_auto_plan = matchedPlan;

  // Live in-game control: the connected state must replace the restart advice.
  const liveText = gd.host.textContent!;
  console.log(`  live state is reported on the setup tab: ${
    liveText.includes("Live control connected")}`);
  console.log(`  live connected state shown: ${liveText.includes("Live control is connected")}`);
  console.log(`  live path avoids restart nag: ${!liveText.includes("restart the game to apply")}`);

  fixtures.get_live_status = {
    ...fixtures.get_live_status, attached: false, state: "failed",
    error: "could not locate OptiScaler's config object", can_switch_upscaler: false,
  };
  const gdOffline = await render("GameDetailLiveOffline",
    <GameDetail gamePath="/games/Cyberpunk 2077" gameName="Cyberpunk 2077" appid="1091500"
      status={fixtures.get_status}
      runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
      onBack={() => {}} />);
  const offlineText = gdOffline.host.textContent!;
  console.log(`  live failure explained: ${offlineText.includes("could not attach")}`);
  console.log(`  live frame rate shown: ${gd.host.textContent!.includes("40.4 fps")}`);
  console.log(`  frame generation state shown: ${gd.host.textContent!.includes("Frame generation")}`);
  console.log(`  live upscaler named as OptiScaler names it: ${gd.host.textContent!.includes("FSR 3.X/4")}`);
  console.log(`  live readout stays read-only here: ${!gd.host.textContent!.includes("Switch now")}`);
  console.log(`  FidelityFX version surfaced: ${gd.host.textContent!.includes("4.1.1.2740")}`);
  // Nothing to say about live control when it is not connected and the game is
  // not being driven from here: the failure notice above is the whole message.
  console.log(`  no hotkey advice when disconnected: ${!offlineText.includes("in game")}`);

  // The Basic/Advanced switch: reachable with the D-pad means it has to be one
  // of Steam's own buttons, and it names both modes so the other one is on
  // offer rather than a secret.
  {
    (globalThis as any).window.localStorage.setItem("decky-optiscaler:advanced", "0");
    const gdMode = await render("GameDetailModeSwitch",
      <GameDetail gamePath="/games/Cyberpunk 2077" gameName="Cyberpunk 2077" appid="1091500"
        status={fixtures.get_status} runningGame={null} onBack={() => {}} />);
    const modeSwitch = findAll(gdMode.host, "[data-mode-switch]")[0];
    console.log(`  the mode switch is a real button: ${
      modeSwitch?.getAttribute("data-mock") === "DialogButton"}`);
    console.log(`  it names both modes: ${
      modeSwitch?.textContent === "BasicAdvanced"}`);
    console.log(`  and starts on basic: ${
      modeSwitch?.getAttribute("data-mode-switch") === "basic"}`);
    await act(async () => {
      (modeSwitch as HTMLElement).click();
    });
    await settle();
    console.log(`  pressing it opens every option: ${
      findAll(gdMode.host, "[data-tab]").map((n) => n.getAttribute("data-tab"))
        .includes("framegen")}`);
    (globalThis as any).window.localStorage.setItem("decky-optiscaler:advanced", "0");
  }

  console.log("\n=== backend calls made ===");
  console.log("  " + Array.from(new Set(calls)).join(", "));

  const real = errors.filter((e) => !e.includes("not wrapped in act"));
  console.log(`\n=== React errors/warnings: ${real.length} ===`);
  real.slice(0, 12).forEach((e) => console.log("  ! " + e.slice(0, 300)));
  process.exit(real.length > 0 ? 1 : 0);
})();
