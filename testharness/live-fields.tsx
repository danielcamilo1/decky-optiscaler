/**
 * The Quick Access panel's live controls, against a backend that behaves like
 * the real one: read_config returns a *copy* of the ini, write_config applies
 * the changes to it the way the Python writer does (rejecting anything the
 * schema will not take), and the live status is re-polled with a fresh object
 * every time.
 *
 * The thing under test is that a control shows what was picked. A dropdown
 * whose value is derived from the ini has to agree with the choice the moment
 * it is made, keep agreeing across a live-status poll, and still agree after
 * the debounced write has come back.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { fixtures } from "@decky/api";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { QuickPanel } from "../src/components/QuickPanel";
import { forgetWrites } from "../src/config/writeRecord";

// ---- a backend that keeps state -------------------------------------------
const ini: Record<string, Record<string, string>> = {};
for (const o of GENERATED_OPTIONS) {
  ini[o.section] = ini[o.section] ?? {};
  ini[o.section][o.key] = "auto";
}
ini.FrameGen.Enabled = "true";
ini.FrameGen.FGInput = "fsrfg";
ini.FrameGen.FGOutput = "fsrfg";
ini.Upscalers.Dx12Upscaler = "fsr31";
ini.FSR.Fsr4Update = "false";

const SCHEMA = new Map(GENERATED_OPTIONS.map((o) => [`${o.section}.${o.key}`, o]));

/** The same check py_modules/optiscaler/schema.py:valid() makes. */
function accepts(section: string, key: string, value: string) {
  const meta: any = SCHEMA.get(`${section}.${key}`);
  if (!meta || value === "auto") return true;
  // schema.INDEX_RANGES: the reference ini names the FFX generators and FSR
  // versions the reference build had, but both lists are per-game, so these are
  // indexes rather than the closed enums the ini makes them look like.
  if (section === "FSR" && (key === "FGIndex" || key === "UpscalerIndex")) {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index <= 15;
  }
  if (meta.type === "bool") return ["true", "false"].includes(value.toLowerCase());
  if (meta.type === "enum") return !meta.options?.length || meta.options.includes(value);
  if (meta.type === "int" || meta.type === "float") return Number.isFinite(Number(value));
  return true;
}

const detail = {
  path: "/games/Cyberpunk 2077",
  name: "Cyberpunk 2077",
  target: "/games/Cyberpunk 2077/bin/x64",
  install: {
    path: "/games/Cyberpunk 2077/bin/x64",
    installed: true, filename: "dxgi.dll", managed: true, version: "0.9.4",
    ini_present: true, log_present: true, candidates: ["dxgi.dll"], extra_proxies: [],
    backed_up: [],
    // The library the shipped OptiScaler release actually carries, which is a
    // later version than the reference ini it documents itself with.
    fsr4: {
      files: {}, ready: false, required: [],
      ffx: { present: true, name: "amd_fidelityfx_upscaler_dx12.dll",
             version: "4.1.1.2740", fsr4_capable: true },
    },
  },
  gpu: { name: "Van Gogh (Steam Deck)", vendor: "amd", generation: "RDNA2", fsr4: "unsupported" },
  wiki_entry: null,
};

// Three generators, which is one more than the shipped ini documents — the
// running game is the authority on this list and a real one can be longer.
const FFX_VERSIONS: string[] = ["4.0.0", "3.1.6", "3.1.4"];
// The same again for the FSR versions the FidelityFX runtime reports, one
// longer than the ini's three, and with the trailing marker the SDK's own name
// carries — OptiScaler prints those names verbatim and so does this.
const FSR_VERSIONS: string[] = ["4.1.1 *", "4.0.2", "3.1.5", "2.3.4"];
let liveFgIndex = 0;
let liveUpscalerIndex = 0;
let liveBackend = "fsr31";
let liveFgEnabled = true;
let liveBaseFps: number | null = 20.2;
let liveTotalFps: number | null = 40.4;
let liveCountedFps = 40.4;

Object.assign(fixtures, {
  find_running_game: () => ({ found: true, appid: "1091500", detail }),
  get_auto_plan: { recommendation: { matched: false }, plan: { available: false } },
  get_pref: { key: "auto", value: null },
  read_config: () => ({
    ok: true, path: "/x/OptiScaler.ini",
    values: JSON.parse(JSON.stringify(ini)), modified: 1,
  }),
  write_config: (_dir: string, changes: any[]) => {
    const applied: any[] = [];
    const rejected: any[] = [];
    for (const c of changes) {
      const value = c.value === null || c.value === "" ? "auto" : String(c.value);
      if (!accepts(c.section, c.key, value)) {
        rejected.push({ ...c, value });
        continue;
      }
      ini[c.section] = ini[c.section] ?? {};
      ini[c.section][c.key] = value;
      applied.push({ section: c.section, key: c.key, value });
    }
    return { ok: true, applied, rejected, live: { sent: true, deferred: [], attached: true } };
  },
  get_live_status: () => ({
    asi_installed: true, asi_available: true, asi_current: true,
    attached: true, ready: true, state: "ready",
    load_enabled: true, loaded_by_optiscaler: true, error: null, seq: "1",
    can_switch_upscaler: true, can_change_fg: true, can_change_ffx_upscaler: true,
    age: 1.0,
    live_keys: [
      "FrameGen.Enabled", "Upscalers.Dx12Upscaler", "FSR.FGIndex", "FSR.UpscalerIndex",
    ],
    // Frame generation is on and doubling, so there are two frame rates: what
    // the game renders and what reaches the screen.
    fps: liveCountedFps, base_fps: liveBaseFps, total_fps: liveTotalFps,
    rendered_ms: 49.5, presented_ms: 24.8,
    fg_enabled: liveFgEnabled, frames: 12000, backend_entries: 1,
    upscaler: { dx12: liveBackend, dx11: null, vulkan: null },
    pending_backend: null, schema: 5, fg_index: liveFgIndex,
    ffx_fg_versions: FFX_VERSIONS,
    ffx_upscaler_versions: FSR_VERSIONS, ffx_upscaler_index: liveUpscalerIndex,
  }),
  switch_upscaler: (_dir: string, code: string) => {
    liveBackend = code;
    return { ok: true, sent: true, backend: code };
  },
});

// ---- harness ---------------------------------------------------------------
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[ok]" : "[FAIL]"} ${label}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}

async function settle(ms = 5) {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

/**
 * Rewrite the ini behind the plugin's back, as a fresh session would find it.
 *
 * The plugin remembers what it wrote so that reopening the panel does not read
 * a file the write has not reached yet, and that record outlives a render root.
 * Editing the fixture directly is the harness playing a different session, so
 * it has to drop the record too — otherwise the previous case's writes are
 * still, correctly, winning.
 */
function setIni(entries: Record<string, Record<string, string>>) {
  for (const [section, keys] of Object.entries(entries)) {
    ini[section] = { ...(ini[section] ?? {}), ...keys };
  }
  forgetWrites(detail.install.path);
}

const all = (node: Element, selector: string) => Array.from(node.querySelectorAll(selector));
const control = (host: Element, label: string) =>
  all(host, `[data-mock][data-label="${label}"]`)[0];
const selected = (host: Element, label: string) =>
  control(host, label)?.getAttribute("data-selected");

/**
 * The value shown in one of the live tiles, found by the label above it.
 *
 * The tiles are plain markup rather than Steam controls, so there is no mock
 * marker to look for — a tile is a div whose first child is the label and whose
 * second is the number.
 */
const tile = (host: Element, label: string) => {
  for (const node of all(host, "div")) {
    const [head, body] = Array.from(node.children);
    if (head?.textContent === label && body) return body.textContent;
  }
  return null;
};

(async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();

  console.log("=== the upscaler dropdown ===");
  check("opens on what the ini says", selected(host, "Override upscaler with"), "fsr31");
  const upscaler = control(host, "Override upscaler with");
  await act(async () => {
    (all(upscaler, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle();
  check("shows the pick straight away", selected(host, "Override upscaler with"), "xess");
  // Past the debounce, so the write has been made and answered.
  await settle(200);
  check("still shows it after the write", selected(host, "Override upscaler with"), "xess");
  check("the ini has it", ini.Upscalers.Dx12Upscaler, "xess");

  console.log("=== the FFX FG version dropdown ===");
  const ffx = control(host, "FFX FG version");
  console.log(`  options: ${all(ffx, "[data-opt]").map((n) => n.textContent).join(", ")}`);
  await act(async () => {
    (all(ffx, '[data-opt-value="2"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows the third generator", selected(host, "FFX FG version"), "2");
  // The shipped ini documents two generators because that is what the
  // reference build offered; the running game is the authority on the list.
  check("and the ini records it", ini.FSR.FGIndex, "2");

  console.log("=== the FSR version dropdown ===");
  // The second half of the upscaler question. "fsr31" is every FSR from 2.3.4
  // to 4.1.1, so which one is running is a separate choice, and the running
  // game is the authority on what the choices are.
  const fsrVersion = control(host, "FSR version");
  check("the versions are the ones the game reports, named as OptiScaler names them",
    all(fsrVersion, "[data-opt]").map((n) => n.textContent).join(", "),
    "FSR 4.1.1 *, FSR 4.0.2, FSR 3.1.5, FSR 2.3.4");
  // Start from the FSR 3.X preset's position, where the FSR 4 upgrade path is
  // off -- asking for FSR 4 from here has to switch it back on, or OptiScaler
  // falls back to FSR 3 without saying so.
  setIni({ FSR: { Fsr4Update: "false" } });
  await act(async () => {
    (all(fsrVersion, '[data-opt-value="3"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows the version picked", selected(host, "FSR version"), "3");
  // The shipped ini documents three versions because that is what the
  // reference build offered; a fourth has to be writable all the same.
  check("and the ini records it past the end of the ini's own list",
    ini.FSR.UpscalerIndex, "3");
  check("an older version leaves the FSR 4 upgrade path alone",
    ini.FSR.Fsr4Update, "false");

  const toFsr4 = control(host, "FSR version");
  await act(async () => {
    (all(toFsr4, '[data-opt-value="0"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("asking for FSR 4 records the version", ini.FSR.UpscalerIndex, "0");
  // Without this, OptiScaler reaches FSR 4 only on RDNA4 and the request falls
  // back to FSR 3 on a Deck with nothing said about it.
  check("and switches on the path that makes it reachable",
    ini.FSR.Fsr4Update, "true");

  console.log("=== the live tiles ===");
  // The backend id cannot say which FSR is running and OptiScaler's own name
  // for it — "FSR 3.X/4" — says so out loud. The version list can, and the game
  // is still on the one it built, not the one just written to the file.
  check("the upscaler tile names the exact version the game is running",
    tile(host, "upscaler"), "FSR 4.1.1 *");
  check("frame generation splits the frame rate in two",
    `${tile(host, "base fps")} / ${tile(host, "with fg")}`, "20 / 40");

  console.log("=== the frame multiplier ===");
  // Only the XeSS FG output can do more than 2X, so switch to it first.
  const method = control(host, "Method");
  await act(async () => {
    (all(method, '[data-opt-value="xefg"]')[0] as HTMLElement).click();
  });
  await settle(200);
  const mult = control(host, "Frame multiplier");
  check("the multiplier is usable on XeFG", mult?.getAttribute("data-disabled"), "null");
  await act(async () => {
    (all(mult, '[data-opt-value="3"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("shows 3X", selected(host, "Frame multiplier"), "3");

  console.log("=== the frame generation toggle ===");
  const fg = all(host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
  await act(async () => {
    (all(fg, "[data-toggle]")[0] as HTMLElement).click();
  });
  await settle(200);
  const fgNow = all(host, '[data-mock="ToggleField"][data-label="Frame generation"]')[0];
  check("turns off", all(fgNow, "[data-toggle]")[0].getAttribute("data-checked"), "false");
  check("and the ini agrees", ini.FrameGen.Enabled, "false");

  console.log("=== an ini the presets have no name for ===");
  // The Advanced page and the wiki plan write the same file. A value with no
  // preset used to be displayed as "Auto", which is the opposite of the truth.
  setIni({
    Upscalers: { Dx12Upscaler: "fsr21" },
    FSR: { Fsr4Update: "auto" },
    FrameGen: { Enabled: "true", FGInput: "dlssg", FGOutput: "xefg" },
  });
  const host3 = document.createElement("div");
  document.body.appendChild(host3);
  const root3 = createRoot(host3);
  await act(async () => {
    root3.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  check("the upscaler is not passed off as Auto",
    selected(host3, "Override upscaler with"), "fsr21");
  const shown = (host: Element, label: string) => {
    const node = control(host, label);
    const value = node?.getAttribute("data-selected");
    return all(node!, `[data-opt-value="${value}"]`)[0]?.textContent;
  };
  console.log(`  and is named: ${shown(host3, "Override upscaler with")}`);
  check("the FG pair is not passed off as FSR FG",
    selected(host3, "Method"), "dlssg \u2192 xefg");
  console.log(`  and is named: ${shown(host3, "Method")}`);
  await act(async () => root3.unmount());

  console.log("=== a write the backend will not take ===");
  // A rejected write reaches neither the file nor the running game. The control
  // has to go back to what the file says and the panel has to say why — and the
  // re-read that does it must not blank the controls on the way past.
  setIni({
    Upscalers: { Dx12Upscaler: "fsr31" },
    FSR: { Fsr4Update: "false" },
    FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "fsrfg" },
    XeFG: { InterpolationCount: "auto" },
  });
  const host4 = document.createElement("div");
  document.body.appendChild(host4);
  const root4 = createRoot(host4);
  await act(async () => {
    root4.render(
      <QuickPanel
        runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
        onOpenManager={() => {}}
      />
    );
  });
  await settle();
  // Nothing in the panel offers an unacceptable value, so one is forced in the
  // one place a real ini can also disagree with the schema: an out-of-range
  // FFX FG index, which is what the game reporting a shorter list looks like.
  let refused = true;
  fixtures.write_config = (_dir: string, changes: any[]) => {
    if (!refused) return { ok: true, applied: changes, rejected: [], live: { sent: true, deferred: [] } };
    return { ok: true, applied: [], rejected: changes, live: { sent: false, deferred: [] } };
  };
  const before = selected(host4, "Override upscaler with");
  const target = control(host4, "Override upscaler with");
  await act(async () => {
    (all(target, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("the panel stays up through the re-read",
    Boolean(control(host4, "Override upscaler with")), true);
  check("the control goes back to the file",
    selected(host4, "Override upscaler with"), before);
  check("and the refusal is reported",
    /would not accept/.test(host4.textContent ?? ""), true);

  // And once the backend accepts again, an edit sticks.
  refused = false;
  const retry = control(host4, "Override upscaler with");
  await act(async () => {
    (all(retry, '[data-opt-value="xess"]')[0] as HTMLElement).click();
  });
  await settle(200);
  check("a later edit sticks", selected(host4, "Override upscaler with"), "xess");
  await act(async () => root4.unmount());

  console.log("=== closing the panel while the write is in flight ===");
  // Closing the Quick Access panel unmounts everything, which is what you do to
  // look at the game after changing something. Reopening starts a read that can
  // be issued before the write has landed, and the panel then comes up showing
  // the value from before the change — one step behind, for ever.
  setIni({
    Upscalers: { Dx12Upscaler: "xess" },
    FSR: { Fsr4Update: "false" },
    FrameGen: { Enabled: "true", FGInput: "fsrfg", FGOutput: "fsrfg" },
  });
  let releaseWrite: () => void = () => {};
  fixtures.write_config = async (_dir: string, changes: any[]) => {
    await new Promise<void>((r) => {
      releaseWrite = r;
    });
    for (const c of changes) {
      ini[c.section] = ini[c.section] ?? {};
      ini[c.section][c.key] = String(c.value);
    }
    return { ok: true, applied: changes, rejected: [], live: { sent: true, deferred: [] } };
  };

  const open = async () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const r = createRoot(node);
    await act(async () => {
      r.render(
        <QuickPanel
          runningGame={{ appid: 1091500, name: "Cyberpunk 2077", gameid: "1091500" }}
          onOpenManager={() => {}}
        />
      );
    });
    await settle();
    return { node, root: r };
  };

  let panel = await open();
  check("opens on XeSS", selected(panel.node, "Override upscaler with"), "xess");
  await act(async () => {
    (all(control(panel.node, "Override upscaler with"), '[data-opt-value="fsr4"]')[0] as HTMLElement)
      .click();
  });
  await settle();
  // Close it before the write has been answered, exactly as the panel closing
  // over a running game does.
  await act(async () => panel.root.unmount());
  panel = await open();
  check("reopening does not show the value from before the change",
    selected(panel.node, "Override upscaler with"), "fsr4");
  // Now let the write through and reopen once more: the file agrees, and the
  // record retires itself.
  await act(async () => {
    releaseWrite();
    await new Promise((r) => setTimeout(r, 5));
  });
  await settle();
  await act(async () => panel.root.unmount());
  panel = await open();
  check("and still agrees once the write lands",
    selected(panel.node, "Override upscaler with"), "fsr4");
  check("the file has it", ini.Upscalers.Dx12Upscaler, "fsr31");

  console.log("=== the FFX FG control on a game with one generator ===");
  FFX_VERSIONS.length = 0;
  FFX_VERSIONS.push("3.1.6");
  await act(async () => panel.root.unmount());
  panel = await open();
  const single = control(panel.node, "FFX FG version");
  check("the control is still there", Boolean(single), true);
  check("but there is nothing to pick", single?.getAttribute("data-disabled"), "true");
  await act(async () => panel.root.unmount());

  console.log("=== frame generation on, but not generating ===");
  // OptiScaler can have the setting on and not have engaged the generator --
  // it reports FSR-FG as off until the game selects frame generation in its
  // own options -- and the two rates then measure the same frames. Both are
  // still shown, because both were asked for; what stops two identical numbers
  // reading as a fault is the frame-generation tile saying why.
  liveBaseFps = 40.4;
  liveTotalFps = 40.4;
  panel = await open();
  check("both rates are still shown",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "40 / 40");
  // The tile reads "ON idle": still on, and saying why the two match.
  check("and the frame generation tile says the generator is not running",
        tile(panel.node, "frame gen"), "ON idle");
  await act(async () => panel.root.unmount());

  // An in-game plugin older than this one reports no frame intervals at all,
  // and so does a generator that was created but has never presented: the
  // rendered slot stays at zero and the host withholds the derived rate. The
  // pair is what was asked for, so the second tile is still there saying it has
  // no reading -- a pair of counters that quietly becomes one counter is
  // indistinguishable from the feature never having shipped.
  liveBaseFps = null;
  liveTotalFps = null;
  panel = await open();
  check("an unmeasured base rate still gets its tile",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "— / 40");
  check("and the frame generation tile says there is no reading",
        tile(panel.node, "frame gen"), "ON no reading");
  await act(async () => panel.root.unmount());

  // The frame counter does not always count the frames that reach the screen.
  // When it counts the rendered ones instead, the total is the derived number
  // and the raw count is the *base* -- showing the count as the total is what
  // put the rendered rate under a "with fg" label while the base stayed blank.
  liveBaseFps = 30.0;
  liveTotalFps = 60.0;
  liveCountedFps = 30.0;
  panel = await open();
  check("a counter on the rendered side does not become the total",
        `${tile(panel.node, "base fps")} / ${tile(panel.node, "with fg")}`, "30 / 60");
  await act(async () => panel.root.unmount());
  liveCountedFps = 40.4;

  // With frame generation off there is only ever one rate to show.
  liveFgEnabled = false;
  liveBaseFps = 20.2;
  liveTotalFps = 40.4;
  panel = await open();
  check("with frame generation off there is one rate",
        tile(panel.node, "fps"), "40");
  check("and no second tile", tile(panel.node, "base fps"), "null");
  await act(async () => panel.root.unmount());

  console.log("=== a version list that arrives after the control does ===");
  // The full page mounts its settings before the first live poll lands, so the
  // FidelityFX lists start as the shipped ini's snapshot and are replaced under
  // an index that does not move: 0 goes from "FSR 4.0.2", which is what the
  // reference ini documents, to what the game actually has. Steam's dropdown
  // builds its label once, so a control keyed on the value alone kept showing
  // the ini's name for ever -- which is why the page and the Quick Access
  // panel disagreed about the same install.
  setIni({ FSR: { UpscalerIndex: "0" } });
  const promptly = fixtures.get_live_status;
  fixtures.get_live_status = async (...args: any[]) => {
    await new Promise((r) => setTimeout(r, 60));
    return (promptly as any)(...args);
  };
  panel = await open();
  const versionControl = control(panel.node, "FSR version");
  // Not the reference ini's "FSR 4.0.2": the library sitting next to the game
  // is 4.1.1, and that is readable without the game running at all.
  check("the installed library names the newest one before the game answers",
        versionControl?.getAttribute("data-shown"), "FSR 4.1.1");
  await settle(30);
  check("and the game's own name replaces it once it does",
        control(panel.node, "FSR version")?.getAttribute("data-shown"), "FSR 4.1.1 *");
  fixtures.get_live_status = promptly;
  await act(async () => panel.root.unmount());

  const real = errors.filter((e) => !e.includes("not wrapped in act"));
  console.log(`\nreal React errors: ${real.length}`);
  for (const e of real) console.log(`  ${e}`);
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  // The panel polls; without this the intervals keep node alive for ever.
  await act(async () => root.unmount());
  process.exit(failures > 0 || real.length > 0 ? 1 : 0);
})();
