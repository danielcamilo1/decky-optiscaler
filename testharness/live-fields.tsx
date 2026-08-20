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
  // schema.INDEX_RANGES: the reference ini names the two FFX generators the
  // reference build had, but the list is per-game, so this one is an index.
  if (section === "FSR" && key === "FGIndex") {
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
    backed_up: [], fsr4: { files: {}, ready: false, required: [] },
  },
  gpu: { name: "Van Gogh (Steam Deck)", vendor: "amd", generation: "RDNA2", fsr4: "unsupported" },
  wiki_entry: null,
};

// Three generators, which is one more than the shipped ini documents — the
// running game is the authority on this list and a real one can be longer.
const FFX_VERSIONS: string[] = ["4.0.0", "3.1.6", "3.1.4"];
let liveFgIndex = 0;
let liveBackend = "fsr31";
let liveFgEnabled = true;

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
    asi_installed: true, asi_available: true, attached: true, ready: true, state: "ready",
    load_enabled: true, loaded_by_optiscaler: true, error: null, seq: "1",
    can_switch_upscaler: true, can_change_fg: true, age: 1.0,
    live_keys: ["FrameGen.Enabled", "Upscalers.Dx12Upscaler", "FSR.FGIndex"],
    fps: 40.4, fg_enabled: liveFgEnabled, frames: 12000, backend_entries: 1,
    upscaler: { dx12: liveBackend, dx11: null, vulkan: null },
    pending_backend: null, schema: 4, fg_index: liveFgIndex,
    ffx_fg_versions: FFX_VERSIONS,
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

  const real = errors.filter((e) => !e.includes("not wrapped in act"));
  console.log(`\nreal React errors: ${real.length}`);
  for (const e of real) console.log(`  ${e}`);
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  // The panel polls; without this the intervals keep node alive for ever.
  await act(async () => root.unmount());
  process.exit(failures > 0 || real.length > 0 ? 1 : 0);
})();
