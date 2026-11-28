import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixtures, invocations } from "@decky/api";
import {
  applyManagedLaunchOptions,
  hasOverride,
  mergeWineOverrides,
  preserveExistingInstall,
  reconcileLaunchOptions,
  stripLaunchOptions,
  stripOverride,
} from "../src/launchOptions";

function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function effectiveWineValue(
  launchOptions: string,
  pathPrefix = "",
): string {
  const command = `sh -c ${shellQuote('printf "%s" "$WINEDLLOVERRIDES"')}`;
  const concrete = launchOptions.replace(/%command%/gi, command);
  const environment = {
    ...process.env,
    PATH: [pathPrefix, process.env.PATH ?? ""].filter(Boolean).join(":"),
  };
  const result = spawnSync("sh", ["-c", concrete], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr || `shell exited ${result.status}`);
  return result.stdout;
}

console.log("=== launch options parser ===");

const native = mergeWineOverrides(
  "WINEDLLOVERRIDES=foo=n,b %command%",
  ["dxgi"],
);
assert.ok(native);
check("native assignment merge quotes the combined semicolon value",
  /WINEDLLOVERRIDES="foo=n,b;dxgi=n,b"/.test(native));
check("native assignment reaches the game with both clauses",
  effectiveWineValue(native) === "foo=n,b;dxgi=n,b");
check("only ordered n,b is recognized as the plugin clause",
  hasOverride(native, "dxgi.dll") &&
    !hasOverride('WINEDLLOVERRIDES="dxgi=b,n" %command%', "dxgi.dll"));
check("DLL stems remain case-insensitive",
  hasOverride('WINEDLLOVERRIDES="DXGI=n,b" %command%', "dxgi.dll"));

const lowercaseVariable = mergeWineOverrides(
  "winedlloverrides=foo=n,b %command%",
  ["dxgi"],
);
assert.ok(lowercaseVariable);
check("a lowercase lookalike stays independent from WINEDLLOVERRIDES",
  lowercaseVariable.includes('winedlloverrides=foo=n,b WINEDLLOVERRIDES="dxgi=n,b" %command%') &&
    effectiveWineValue(lowercaseVariable) === "dxgi=n,b" &&
    !hasOverride('winedlloverrides="dxgi=n,b" %command%', "dxgi.dll"));

const envWrapped = mergeWineOverrides(
  "env WINEDLLOVERRIDES=foo=n,b lsfg-run %command%",
  ["dxgi"],
);
assert.ok(envWrapped);
check("env wrapper updates its effective Wine assignment",
  envWrapped.includes('env WINEDLLOVERRIDES="foo=n,b;dxgi=n,b" lsfg-run %command%'));
const temporaryDir = mkdtempSync(path.join(tmpdir(), "launch-options-"));
try {
  const wrapperPath = path.join(temporaryDir, "lsfg-run");
  writeFileSync(wrapperPath, "#!/bin/sh\nexec \"$@\"\n", "utf8");
  chmodSync(wrapperPath, 0o755);
  check("env wrapper passes the merged value through its wrapper",
    effectiveWineValue(envWrapped, temporaryDir) === "foo=n,b;dxgi=n,b");
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}

const repeated = mergeWineOverrides(
  "WINEDLLOVERRIDES=old=n,b WINEDLLOVERRIDES=foo=n,b %command%",
  ["dxgi"],
);
assert.ok(repeated);
check("repeated assignments merge into the last effective assignment",
  repeated.includes('WINEDLLOVERRIDES=old=n,b WINEDLLOVERRIDES="foo=n,b;dxgi=n,b"'));
check("the shell uses the merged last assignment",
  effectiveWineValue(repeated) === "foo=n,b;dxgi=n,b");

const duplicatePlugin =
  'WINEDLLOVERRIDES="dxgi=n,b" WINEDLLOVERRIDES="dxgi=n,b;d3d11=n,b" %command%';
const strippedDuplicates = stripOverride(duplicatePlugin, "dxgi.dll");
check("stripping duplicate assignments cannot reveal an earlier plugin clause",
  !hasOverride(strippedDuplicates, "dxgi.dll") &&
    effectiveWineValue(strippedDuplicates) === "d3d11=n,b");

const argumentOnly = mergeWineOverrides("-dx12", ["dxgi"], ["-dx12"]);
assert.ok(argumentOnly);
check("argument-only launch options put %command% before the game argument",
  /%command%\s+-dx12/.test(argumentOnly) &&
    argumentOnly.slice(argumentOnly.indexOf("%command%") + "%command%".length).trim() === "-dx12");

const afterCommand = mergeWineOverrides(
  "%command% ASSIGNMENT=value -dx12",
  ["dxgi"],
);
assert.ok(afterCommand);
check("assignment-looking game arguments after %command% stay in argv",
  afterCommand.endsWith("%command% ASSIGNMENT=value -dx12"));

const wrapperFlagMerge = mergeWineOverrides(
  "gamescope -dx12 %command%",
  ["dxgi"],
  ["-dx12"],
);
assert.ok(wrapperFlagMerge);
check("a wrapper flag does not satisfy the game's matching wiki flag",
  wrapperFlagMerge.includes("gamescope -dx12 %command% -dx12"));
const wrapperFlagStripped = stripLaunchOptions(
  wrapperFlagMerge,
  "dxgi.dll",
  ["-dx12"],
  [],
  "gamescope -dx12 %command%",
);
check("removing the wiki flag preserves the same flag on the wrapper",
  wrapperFlagStripped.includes("gamescope -dx12 %command%") &&
    !wrapperFlagStripped.slice(wrapperFlagStripped.indexOf("%command%") + "%command%".length).includes("-dx12"));

const mixedModes =
  'WINEDLLOVERRIDES="dxgi=n,b;dxgi=b,n;d3d11=n,b" %command%';
const exactStrip = stripOverride(mixedModes, "dxgi.dll");
check("exact stripping keeps reverse-order and unrelated DLL clauses",
  exactStrip === 'WINEDLLOVERRIDES="dxgi=b,n;d3d11=n,b" %command%');
check("unsupported env options fail closed",
  mergeWineOverrides("env -i WINEDLLOVERRIDES=foo %command%", ["dxgi"]) === null);

console.log("=== launch options parser complete ===");

check("expanded Wine values are never requoted during stripping",
  stripOverride('WINEDLLOVERRIDES="dxgi=n,b;$USER_DLLS" %command%', "dxgi.dll") ===
    'WINEDLLOVERRIDES="dxgi=n,b;$USER_DLLS" %command%');

const plusArguments = mergeWineOverrides("+fps_max 60", ["dxgi"]);
assert.ok(plusArguments);
check("plus-prefixed game arguments follow the placeholder", plusArguments.endsWith("%command% +fps_max 60"));
check("plus-prefixed arguments do not become an executable", effectiveWineValue(plusArguments) === "dxgi=n,b");
const originalDx12 = mergeWineOverrides("-dx12", ["dxgi"], ["-dx12"]);
assert.ok(originalDx12);
check("removing a planned flag preserves the user's original argument-only flag",
  stripLaunchOptions(originalDx12, "dxgi.dll", ["-dx12"], [], "-dx12").includes("-dx12"));
check("ambiguous command text without a placeholder is left for manual setup",
  mergeWineOverrides("gamescope -W 1280", ["dxgi"]) === null);

check("stripping a middle wiki flag collapses its adjacent separator without double spaces",
  stripLaunchOptions(
    'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag',
    "",
    ["-dx11"],
    [],
    "",
  ) === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -myflag');

check("stripping a trailing wiki flag leaves no stray trailing space",
  stripLaunchOptions(
    'WINEDLLOVERRIDES="dxgi=n,b" %command% -myflag -dx11',
    "",
    ["-dx11"],
    [],
    "",
  ) === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -myflag' &&
    stripLaunchOptions(
      'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11',
      "",
      ["-dx11"],
      [],
      "",
    ) === 'WINEDLLOVERRIDES="dxgi=n,b" %command%');

check("stripping a leading argument-only flag leaves no leading space",
  stripLaunchOptions("-dx11 -myflag", "", ["-dx11"], [], "") === "-myflag");

check("stripping a wiki flag preserves it when present in recordedOriginal",
  stripLaunchOptions(
    'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag',
    "",
    ["-dx11"],
    [],
    "%command% -dx11",
  ) === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag');

check("stripping extra override and flag with empty primary filename preserves primary proxy",
  stripLaunchOptions(
    'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command% -dx11 -myflag',
    "",
    ["-dx11"],
    ["dinput8.dll"],
    "",
  ) === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -myflag');

console.log("=== reconcileLaunchOptions ===");

{
  const staleSwap = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command% -dx11 -myflag',
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: ["-dx12"],
    nextExtraOverrides: [],
    persisted: { flags: ["-dx11"], extraOverrides: ["dinput8.dll"] },
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions removes stale persisted flag and extra override while keeping custom flag",
    staleSwap.value === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -myflag' &&
      JSON.stringify(staleSwap.removedFlags) === JSON.stringify(["-dx11"]) &&
      JSON.stringify(staleSwap.removedExtraOverrides) === JSON.stringify(["dinput8.dll"]) &&
      JSON.stringify(staleSwap.nextOwned) === JSON.stringify({ flags: ["-dx12"], extraOverrides: [] }),
  );
}

{
  const userOwnedFlag = reconcileLaunchOptions({
    current: "%command% -vulkan -custom",
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: ["-vulkan", "-dx12"],
    nextExtraOverrides: [],
    persisted: { flags: [], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions does not steal ownership of user-added flag matching wiki flag",
    userOwnedFlag.value === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -vulkan -custom' &&
      JSON.stringify(userOwnedFlag.nextOwned) === JSON.stringify({ flags: ["-dx12"], extraOverrides: [] }),
  );

  const afterWikiDropsVulkan = reconcileLaunchOptions({
    current: userOwnedFlag.value!,
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: [],
    nextExtraOverrides: [],
    persisted: userOwnedFlag.nextOwned,
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions later removes only plugin-added -dx12 and preserves user -vulkan and -custom",
    afterWikiDropsVulkan.value === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -vulkan -custom' &&
      JSON.stringify(afterWikiDropsVulkan.nextOwned) === JSON.stringify({ flags: [], extraOverrides: [] }),
  );
}

{
  const userOwnedOverride = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dinput8=n,b" %command%',
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: [],
    nextExtraOverrides: ["dinput8.dll"],
    persisted: { flags: [], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions does not claim ownership of pre-existing user extra override",
    userOwnedOverride.value === 'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command%' &&
      JSON.stringify(userOwnedOverride.nextOwned) === JSON.stringify({ flags: [], extraOverrides: [] }),
  );
}

{
  const turnOff = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b;dinput8=n,b" %command% -dx11 -custom',
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: ["-dx11"],
    nextExtraOverrides: ["dinput8.dll"],
    persisted: { flags: ["-dx11"], extraOverrides: ["dinput8.dll"] },
    recordedOriginal: "",
    applyNext: false,
  });
  check(
    "reconcileLaunchOptions with applyNext=false strips proxy and persisted items while preserving custom flag",
    turnOff.value === "%command% -custom" &&
      JSON.stringify(turnOff.nextOwned) === JSON.stringify({ flags: [], extraOverrides: [] }),
  );
}

{
  const proxySwitch = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11',
    oldFilename: "dxgi.dll",
    nextFilename: "winmm.dll",
    nextFlags: ["-dx11"],
    nextExtraOverrides: [],
    persisted: { flags: ["-dx11"], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions strips old proxy override when filename changes and keeps persisted flag ownership",
    proxySwitch.value === 'WINEDLLOVERRIDES="winmm=n,b" %command% -dx11' &&
      JSON.stringify(proxySwitch.nextOwned) === JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
  );
}

{
  const sameProxyCaseInsensitive = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
    oldFilename: "DXGI.DLL",
    nextFilename: "dxgi.dll",
    nextFlags: [],
    nextExtraOverrides: [],
    persisted: { flags: [], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions treats filename comparison case-insensitively",
    sameProxyCaseInsensitive.value === 'WINEDLLOVERRIDES="dxgi=n,b" %command%',
  );
}

{
  const originalPreserved = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 -myflag',
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: ["-dx12"],
    nextExtraOverrides: [],
    persisted: { flags: ["-dx11"], extraOverrides: [] },
    recordedOriginal: "%command% -dx11",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions respects recordedOriginal when stripping stale persisted flag",
    originalPreserved.value === 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx12 -dx11 -myflag',
  );
}

{
  const unsupportedShell = reconcileLaunchOptions({
    current: "foo && %command%",
    oldFilename: "dxgi.dll",
    nextFilename: "dxgi.dll",
    nextFlags: ["-dx12"],
    nextExtraOverrides: [],
    persisted: { flags: [], extraOverrides: [] },
    recordedOriginal: "foo && %command%",
    applyNext: true,
  });
  check(
    "reconcileLaunchOptions fails closed on unsupported shell syntax",
    unsupportedShell.value === null,
  );
}

{
  const stripShellOp = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 && echo done',
    oldFilename: "dxgi.dll",
    nextFilename: "OptiScaler.asi",
    nextFlags: [],
    nextExtraOverrides: [],
    persisted: { flags: ["-dx11"], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: false,
  });
  check(
    "reconcileLaunchOptions fails closed on && shell operator when stripping with applyNext=false",
    stripShellOp.value === null,
  );

  const stripExpandedWine = reconcileLaunchOptions({
    current: 'WINEDLLOVERRIDES="dxgi=n,b;$USER_DLLS" %command%',
    oldFilename: "dxgi.dll",
    nextFilename: "OptiScaler.asi",
    nextFlags: [],
    nextExtraOverrides: [],
    persisted: { flags: [], extraOverrides: [] },
    recordedOriginal: "",
    applyNext: false,
  });
  check(
    "reconcileLaunchOptions fails closed on expanded $USER_DLLS override when stripping with applyNext=false",
    stripExpandedWine.value === null,
  );
}

async function testManagedLaunchOptionsFailClosed() {
  console.log("=== applyManagedLaunchOptions & preserveExistingInstall fail-closed ===");
  const prevSteam = (globalThis as any).SteamClient;
  const prefs = new Map<string, unknown>();
  const steamLaunch = new Map<number, string>();
  let steamWrites = 0;

  (globalThis as any).SteamClient = {
    Apps: {
      GetAppLaunchOptions: async (id: number) => steamLaunch.get(id) ?? "",
      SetAppLaunchOptions: (id: number, value: string) => {
        steamWrites += 1;
        steamLaunch.set(id, value);
      },
    },
  };
  fixtures.get_launch_options = (appid: string) => ({
    found: true,
    value: steamLaunch.get(Number(appid)) ?? "",
    source: "harness",
  });
  fixtures.set_pref = (key: string, value: unknown) => {
    if (value === null || value === undefined) prefs.delete(key);
    else prefs.set(key, value);
    return { ok: true };
  };
  fixtures.create_restore_point = () => ({ ok: true });

  try {
    // Comment 4726888111: transient getPref failure must fail closed without touching Steam or prefs
    const appidPrefFail = 610001;
    const originalSteam = 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11';
    steamLaunch.set(appidPrefFail, originalSteam);
    prefs.set(`applied_launch:${appidPrefFail}`, { flags: ["-dx11"], extraOverrides: [] });
    fixtures.get_pref = () => {
      throw new Error("transient backend pref read failure");
    };
    const setPrefBefore = invocations.filter((c) => c.name === "set_pref").length;
    const writesBefore = steamWrites;

    const failedReadResult = await applyManagedLaunchOptions({
      appid: String(appidPrefFail),
      oldFilename: "dxgi.dll",
      nextFilename: "dxgi.dll",
      nextFlags: ["-dx12"],
      nextExtraOverrides: [],
      recordedOriginal: "",
      applyNext: true,
    });
    check(
      "applyManagedLaunchOptions returns metadata_unreadable when getPref rejects",
      !failedReadResult.ok && failedReadResult.reason === "metadata_unreadable",
    );
    check(
      "applyManagedLaunchOptions leaves Steam and applied_launch pref untouched on getPref error",
      steamLaunch.get(appidPrefFail) === originalSteam &&
        steamWrites === writesBefore &&
        invocations.filter((c) => c.name === "set_pref").length === setPrefBefore &&
        JSON.stringify(prefs.get(`applied_launch:${appidPrefFail}`)) ===
          JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
    );

    // preserveExistingInstall also fails closed when getPref rejects
    const rpCallsBefore = invocations.filter((c) => c.name === "create_restore_point").length;
    const preserveFailed = await preserveExistingInstall(
      "/games/pref-fail/bin",
      "/games/pref-fail",
      String(appidPrefFail),
    );
    check(
      "preserveExistingInstall fails closed without calling create_restore_point when getPref rejects",
      !preserveFailed.ok &&
        invocations.filter((c) => c.name === "create_restore_point").length === rpCallsBefore,
    );

    // preserveExistingInstall passes applied_launch metadata as 4th argument when getPref succeeds
    fixtures.get_pref = (key: string, fallback?: unknown) => ({
      key,
      value: prefs.has(key) ? prefs.get(key) : fallback ?? null,
    });
    const preserveOk = await preserveExistingInstall(
      "/games/pref-ok/bin",
      "/games/pref-ok",
      String(appidPrefFail),
    );
    const rpCall = [...invocations].reverse().find((c) => c.name === "create_restore_point");
    check(
      "preserveExistingInstall forwards applied_launch metadata to create_restore_point",
      preserveOk.ok &&
        JSON.stringify(rpCall?.args[3]) ===
          JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
    );

    // Comment 4726888114: switching dxgi.dll (-dx11) -> OptiScaler.asi (applyNext: false) with
    // `&& echo done` must fail closed with manual_merge and leave Steam and applied_launch intact
    const appidShellFail = 610002;
    const shellSteam = 'WINEDLLOVERRIDES="dxgi=n,b" %command% -dx11 && echo done';
    steamLaunch.set(appidShellFail, shellSteam);
    prefs.set(`applied_launch:${appidShellFail}`, { flags: ["-dx11"], extraOverrides: [] });
    const setPrefBeforeShell = invocations.filter((c) => c.name === "set_pref").length;
    const writesBeforeShell = steamWrites;

    const shellResult = await applyManagedLaunchOptions({
      appid: String(appidShellFail),
      oldFilename: "dxgi.dll",
      nextFilename: "OptiScaler.asi",
      nextFlags: [],
      nextExtraOverrides: [],
      recordedOriginal: "",
      applyNext: false,
      skipIfUnchanged: true,
    });
    check(
      "applyManagedLaunchOptions fails closed with manual_merge on && echo done when stripping for .asi",
      !shellResult.ok && shellResult.reason === "manual_merge",
    );
    check(
      "applyManagedLaunchOptions leaves Steam and applied_launch intact on unparseable strip",
      steamLaunch.get(appidShellFail) === shellSteam &&
        steamWrites === writesBeforeShell &&
        invocations.filter((c) => c.name === "set_pref").length === setPrefBeforeShell &&
        JSON.stringify(prefs.get(`applied_launch:${appidShellFail}`)) ===
          JSON.stringify({ flags: ["-dx11"], extraOverrides: [] }),
    );
  } finally {
    (globalThis as any).SteamClient = prevSteam;
  }
}

await testManagedLaunchOptionsFailClosed();
