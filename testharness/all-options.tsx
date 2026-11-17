import React from "react";
import { createRoot } from "react-dom/client";
// React 18.3 exports act itself; the react-dom/test-utils re-export logs a
// deprecation warning on every run, which the pass condition below counts.
import { act } from "react";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { OptionControl } from "../src/components/OptionControl";
import { TABS, UNGROUPED_SECTIONS, optionsInSection } from "../src/config/tabs";
import type { ConfigValues } from "../src/types";

const errors: string[] = [];
const failedChecks: string[] = [];
const original = console.error;
console.error = (...a: any[]) => {
  const text = a.map(String).join(" ");
  if (!text.includes("not wrapped in act") && !text.includes("ReactDOMTestUtils.act")) errors.push(text);
  original(...a);
};

function check(label: string, ok: boolean) {
  if (!ok) failedChecks.push(label);
  console.log(`  ${ok ? "[ok]" : "[FAIL]"} ${label}`);
}

// Every option unset ("auto") plus a second pass with explicit values.
const autoValues: ConfigValues = {};
const setValues: ConfigValues = {};
for (const o of GENERATED_OPTIONS) {
  autoValues[o.section] = autoValues[o.section] ?? {};
  autoValues[o.section][o.key] = "auto";
  setValues[o.section] = setValues[o.section] ?? {};
  setValues[o.section][o.key] =
    o.type === "bool" ? "true"
    : o.type === "enum" ? (o.options?.[o.options.length - 1] ?? "auto")
    : o.type === "float" ? String(o.max ?? 1.5)
    : o.type === "int" || o.type === "keycode" ? String(o.max ?? 7)
    : "custom-value";
}

(async () => {
  // 1. Tab coverage
  const covered = new Set(TABS.flatMap((t) => t.sections));
  const all = new Set(GENERATED_OPTIONS.map((o) => o.section));
  const missing = [...all].filter((s) => !covered.has(s));
  console.log(`sections: ${all.size} total, ${covered.size} on tabs`);
  console.log(`ungrouped (not shown anywhere): ${missing.length ? missing.join(", ") : "none"}`);
  check("every generated section is reachable through a tab", missing.length === 0);
  check("UNGROUPED_SECTIONS export agrees with actual tab coverage",
    JSON.stringify(UNGROUPED_SECTIONS) === JSON.stringify(missing));
  const tabOptionIds = TABS.flatMap((t) => t.sections.flatMap((s) =>
    optionsInSection(s).map((o) => `${o.section}.${o.key}`)));
  const optionsOnTabs = tabOptionIds.length;
  console.log(`options reachable through tabs: ${optionsOnTabs} / ${GENERATED_OPTIONS.length}`);
  check("every generated option is reachable exactly once",
    optionsOnTabs === GENERATED_OPTIONS.length &&
      new Set(tabOptionIds).size === GENERATED_OPTIONS.length);

  // 2. Render every control, in both states
  for (const [name, values] of [["auto", autoValues], ["explicit", setValues]] as const) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const changes: string[] = [];
    await act(async () => {
      root.render(
        <>
          {GENERATED_OPTIONS.map((o) => (
            <OptionControl
              key={`${o.section}.${o.key}`}
              option={o}
              values={values}
              onChange={(opt, v) => changes.push(`${opt.key}=${v}`)}
            />
          ))}
        </>
      );
    });
    const rendered = host.querySelectorAll("[data-mock]").length;
    console.log(`  [${name}] rendered ${rendered} controls for ${GENERATED_OPTIONS.length} options`);
    check(`[${name}] renders one control for every generated option`,
      rendered === GENERATED_OPTIONS.length);
    root.unmount();
  }

  // 3. Enum dropdowns must always contain the current value
  let badEnum = 0;
  for (const o of GENERATED_OPTIONS) {
    if (o.type !== "enum") continue;
    if (!o.options?.length) { badEnum++; console.log(`  ! enum with no options: ${o.section}.${o.key}`); }
    if (o.default !== "auto" && o.options && !o.options.includes(o.default)) {
      console.log(`  ~ default outside options: ${o.section}.${o.key} default=${o.default} options=${o.options.join("|")}`);
    }
  }
  console.log(`enum sanity: ${badEnum} broken`);
  check("every enum has at least one selectable value", badEnum === 0);

  // 4. Sliders need a sane range
  const badRange = GENERATED_OPTIONS.filter(
    (o) => (o.type === "int" || o.type === "float") && o.min !== undefined && o.max !== undefined && o.min >= o.max
  );
  console.log(`numeric ranges inverted: ${badRange.length}`);
  check("numeric options have increasing ranges", badRange.length === 0);

  console.log(`\nreal React errors: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log("  ! " + e.slice(0, 250)));
  if (failedChecks.length) {
    console.log(`\n${failedChecks.length} behavior check(s) failed: ${failedChecks.join("; ")}`);
  }
  process.exit(errors.length || failedChecks.length ? 1 : 0);
})();
