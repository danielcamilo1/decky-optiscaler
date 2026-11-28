import { act } from "react";
import { createRoot } from "react-dom/client";
import { toasts } from "@decky/api";
import { GENERATED_OPTIONS } from "../src/config/generatedSchema";
import { keyName } from "../src/config/keys";
import { OptionControl } from "../src/components/OptionControl";
import { TABS, UNGROUPED_SECTIONS, optionsInSection } from "../src/config/tabs";
import type { ConfigValues, OptionMeta } from "../src/types";

const errors: string[] = [];
const failedChecks: string[] = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...a: any[]) => {
  errors.push(a.map(String).join(" "));
  originalError(...a);
};
console.warn = (...a: any[]) => {
  errors.push(a.map(String).join(" "));
  originalWarn(...a);
};

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failedChecks.push(detail ? `${label} (${detail})` : label);
  console.log(`  ${ok ? "[ok]" : "[FAIL]"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(input, value);
}

async function editAndBlur(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) return;
  await act(async () => {
    input.focus();
    setNativeInputValue(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    input.blur();
  });
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

function findOption(section: string, key: string): OptionMeta {
  const found = GENERATED_OPTIONS.find((o) => o.section === section && o.key === key);
  if (!found) throw new Error(`Missing option ${section}.${key}`);
  return found;
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
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  // 3. Interactive OptionControl behavior (toggle, dropdown, slider, text validation, keyName)
  {
    const boolOpt = findOption("FrameGen", "Enabled");
    const enumOpt = findOption("Upscalers", "Dx12Upscaler");
    const sliderOpt = GENERATED_OPTIONS.find(
      (o) => o.type === "float" && o.min !== undefined && o.max !== undefined,
    )!;
    const halfOpenIntOpt = GENERATED_OPTIONS.find(
      (o) => o.type === "int" && o.min !== undefined && o.max === undefined,
    )!;
    const halfOpenFloatOpt = GENERATED_OPTIONS.find(
      (o) => o.type === "float" && o.min !== undefined && o.max === undefined,
    )!;
    const unboundedFloatOpt: OptionMeta = {
      section: "Test",
      key: "UnboundedFloat",
      label: "Unbounded Float",
      type: "float",
      default: "auto",
      description: "Test unbounded float input",
    };
    const keycodeOpt = GENERATED_OPTIONS.find((o) => o.type === "keycode")!;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const recorded: Array<{ id: string; value: string }> = [];
    const customValues: ConfigValues = {
      [boolOpt.section]: { [boolOpt.key]: "false" },
      [enumOpt.section]: { [enumOpt.key]: "auto" },
      [sliderOpt.section]: { [sliderOpt.key]: String(sliderOpt.min!) },
      [halfOpenIntOpt.section]: { [halfOpenIntOpt.key]: String(halfOpenIntOpt.min! + 1) },
      [halfOpenFloatOpt.section]: { [halfOpenFloatOpt.key]: "1.5" },
      [unboundedFloatOpt.section]: { [unboundedFloatOpt.key]: "auto" },
      [keycodeOpt.section]: { [keycodeOpt.key]: "0x41" },
    };

    const renderGroup = async () => {
      await act(async () => {
        root.render(
          <>
            {[boolOpt, enumOpt, sliderOpt, halfOpenIntOpt, halfOpenFloatOpt, unboundedFloatOpt, keycodeOpt].map((opt) => (
              <OptionControl
                key={`${opt.section}.${opt.key}`}
                option={opt}
                values={customValues}
                onChange={(changed, val) => {
                  recorded.push({ id: `${changed.section}.${changed.key}`, value: val });
                }}
              />
            ))}
          </>,
        );
      });
    };
    await renderGroup();

    // Toggle
    const toggleControl = host.querySelector<HTMLElement>(
      `[data-mock="ToggleField"][data-label^="${boolOpt.label}"] [data-toggle]`,
    );
    check("bool OptionControl renders clickable toggle", Boolean(toggleControl));
    await act(async () => { toggleControl?.click(); });
    check("bool OptionControl emits toggled value",
      recorded.some((r) => r.id === `${boolOpt.section}.${boolOpt.key}` && r.value === "true"));

    // Enum dropdown
    const targetEnumChoice = enumOpt.options![0];
    const enumChoice = host.querySelector<HTMLElement>(
      `[data-mock="DropdownItem"][data-label^="${enumOpt.label}"] [data-opt-value="${targetEnumChoice}"]`,
    );
    check("enum OptionControl renders selectable option", Boolean(enumChoice));
    await act(async () => { enumChoice?.click(); });
    check("enum OptionControl emits picked value",
      recorded.some((r) => r.id === `${enumOpt.section}.${enumOpt.key}` && r.value === targetEnumChoice));

    // Slider
    const sliderInput = host.querySelector<HTMLInputElement>(
      `[data-mock="SliderField"][data-label^="${sliderOpt.label}"] input[data-slider]`,
    );
    check("bounded numeric OptionControl renders SliderField input", Boolean(sliderInput));
    const mid = Number(((sliderOpt.min! + sliderOpt.max!) / 2).toFixed(3));
    await act(async () => {
      if (sliderInput) {
        setNativeInputValue(sliderInput, String(mid));
        sliderInput.dispatchEvent(new window.Event("input", { bubbles: true }));
        sliderInput.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
    });
    check("SliderField change emits formatted numeric value",
      recorded.some((r) => r.id === `${sliderOpt.section}.${sliderOpt.key}` && r.value === mid.toFixed(3)),
      JSON.stringify(recorded));

    // Half-open int validation (reject decimal and below-min, accept valid int)
    const intBox = host.querySelector<HTMLElement>(
      `[data-mock="TextField"][data-label^="${halfOpenIntOpt.label}"]`,
    );
    const intInput = intBox?.querySelector<HTMLInputElement>("input[data-text-input]");
    check("half-open int OptionControl renders TextField input", Boolean(intInput));
    const beforeIntCount = recorded.length;
    const toastsBefore = toasts.length;
    await editAndBlur(intInput, "2.5");
    check("half-open int rejects decimal on blur without calling onChange",
      recorded.length === beforeIntCount && toasts.length > toastsBefore &&
        (intBox?.textContent?.includes("whole number") ?? false));

    const belowMin = String(halfOpenIntOpt.min! - 1);
    await editAndBlur(intInput, belowMin);
    check("half-open int rejects below-min value on blur",
      recorded.length === beforeIntCount &&
        (intBox?.textContent?.includes(`at least ${halfOpenIntOpt.min}`) ?? false));

    const validInt = String(halfOpenIntOpt.min! + 5);
    await editAndBlur(intInput, validInt);
    check("half-open int commits valid whole number on blur",
      recorded.some((r) => r.id === `${halfOpenIntOpt.section}.${halfOpenIntOpt.key}` && r.value === validInt));

    const validHexInt = `0x${Math.max(0x2d, halfOpenIntOpt.min! + 16).toString(16).toUpperCase()}`;
    await editAndBlur(intInput, validHexInt);
    check("half-open int still accepts 0x hex notation matching Python int(v, 0)",
      recorded.some((r) => r.id === `${halfOpenIntOpt.section}.${halfOpenIntOpt.key}` && r.value === validHexInt));

    // Half-open float validation
    const floatBox = host.querySelector<HTMLElement>(
      `[data-mock="TextField"][data-label^="${halfOpenFloatOpt.label}"]`,
    );
    const floatInput = floatBox?.querySelector<HTMLInputElement>("input[data-text-input]");
    const beforeFloatCount = recorded.length;
    await editAndBlur(floatInput, String(halfOpenFloatOpt.min! - 1));
    check("half-open float rejects below-min value on blur",
      recorded.length === beforeFloatCount &&
        (floatBox?.textContent?.includes(`at least ${halfOpenFloatOpt.min}`) ?? false));

    await editAndBlur(floatInput, "3.25");
    check("half-open float commits valid number on blur",
      recorded.some((r) => r.id === `${halfOpenFloatOpt.section}.${halfOpenFloatOpt.key}` && r.value === "3.25"));

    // Unbounded float strict Python float() decimal syntax validation
    const unboundedFloatBox = host.querySelector<HTMLElement>(
      `[data-mock="TextField"][data-label^="${unboundedFloatOpt.label}"]`,
    );
    const unboundedFloatInput = unboundedFloatBox?.querySelector<HTMLInputElement>("input[data-text-input]");
    check("unbounded float OptionControl renders TextField input", Boolean(unboundedFloatInput));

    for (const invalidFloat of ["0x10", "0b10", "0o10", "NaN", "Infinity", "1e309"]) {
      const countBefore = recorded.length;
      const toastsCountBefore = toasts.length;
      await editAndBlur(unboundedFloatInput, invalidFloat);
      check(`float rejects non-decimal/non-finite "${invalidFloat}" without calling onChange`,
        recorded.length === countBefore &&
          toasts.length > toastsCountBefore &&
          (unboundedFloatBox?.textContent?.includes("valid number") ?? false));
    }

    for (const validFloat of ["1.5", "-0.5", ".25", "1e-3"]) {
      await editAndBlur(unboundedFloatInput, validFloat);
      check(`float accepts valid decimal "${validFloat}"`,
        recorded.some((r) => r.id === `${unboundedFloatOpt.section}.${unboundedFloatOpt.key}` && r.value === validFloat));
    }

    // Keycode description uses keyName() and rejects non-integer input
    const keyBox = host.querySelector<HTMLElement>(
      `[data-mock="TextField"][data-label^="${keycodeOpt.label}"]`,
    );
    const keyInput = keyBox?.querySelector<HTMLInputElement>("input[data-text-input]");
    check("keycode OptionControl shows readable keyName() in description",
      Boolean(keyBox?.textContent?.includes("Key: A.")));
    check("keyName() maps 0x30-0x39 and 0x41-0x5A without mis-mapping 0x3A..0x40",
      keyName("0x41") === "A" && keyName("0x30") === "0" &&
        keyName("0x3A") === "key 0x3a" && keyName("0x2D") === "Insert");
    const beforeKeyCount = recorded.length;
    await editAndBlur(keyInput, "45.5");
    check("keycode OptionControl rejects fractional key code on blur",
      recorded.length === beforeKeyCount);
    await editAndBlur(keyInput, "0x2D");
    check("keycode OptionControl commits valid hex key code on blur",
      recorded.some((r) => r.id === `${keycodeOpt.section}.${keycodeOpt.key}` && r.value === "0x2D"));

    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  // 4. Enum dropdowns must always contain the current value
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

  // 5. Sliders need a sane range
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
