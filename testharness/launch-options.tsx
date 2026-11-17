import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hasOverride,
  mergeWineOverrides,
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
