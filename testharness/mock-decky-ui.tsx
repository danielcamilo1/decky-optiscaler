// Minimal stand-ins for the Steam UI components, enough to render the tree.
import React from "react";

/**
 * Steam's Field takes any node as its label — the setup checklist puts a step
 * marker in front of the text, and the quick panel marks one control "restart"
 * — so the double flattens whatever it is given to text. Tests match on it
 * with a prefix selector rather than an exact one.
 */
function labelText(label: any): string | undefined {
  if (typeof label === "string") return label.trim() || undefined;
  if (typeof label === "number") return String(label);
  if (Array.isArray(label)) {
    const parts = label.map(labelText).filter(Boolean);
    return parts.length ? parts.join(" ") : undefined;
  }
  if (label && typeof label === "object" && label.props) return labelText(label.props.children);
  return undefined;
}

const box = (name: string) =>
  function Mock(props: any) {
    const { children, label, description, title, ...rest } = props;
    // data-* attributes and the activation handlers are forwarded so tests can
    // find a control and press it. Everything else is dropped: passing Steam's
    // own props through to a <div> only produces React warnings.
    const passthrough: Record<string, any> = {};
    for (const key of Object.keys(rest)) {
      if (key.startsWith("data-")) passthrough[key] = rest[key];
    }
    const activate = rest.onClick ?? rest.onActivate;
    if (activate) passthrough.onClick = activate;
    return (
      <div
        data-mock={name}
        data-label={labelText(label)}
        {...passthrough}
      >
        {title ? <div data-title>{title}</div> : null}
        {label ? <div data-label-text>{label}</div> : null}
        {description ? <div data-desc>{description}</div> : null}
        {children}
        {/* Options are rendered as clickable spans so a test can actually pick
            one: several controls only appear once a selection has changed. */}
        {rest.rgOptions
          ? rest.rgOptions.map((o: any, i: number) => (
              <span
                key={i}
                data-opt
                data-opt-value={String(o.data)}
                onClick={() => rest.onChange?.({ data: o.data, label: o.label })}
              >
                {String(o.label)}
              </span>
            ))
          : null}
        {/* Same idea for a toggle: ToggleField takes neither onClick nor
            onActivate, so without this there is no way for a test to flip one,
            and a control that cannot be pressed cannot be tested. */}
        {typeof rest.checked === "boolean" && rest.onChange
          ? (
              <span
                data-toggle
                data-checked={rest.checked ? "true" : "false"}
                onClick={() => {
                  if (!rest.disabled) rest.onChange(!rest.checked);
                }}
              />
            )
          : null}
      </div>
    );
  };

export const PanelSection = box("PanelSection");
export const PanelSectionRow = box("PanelSectionRow");
export const ButtonItem = box("ButtonItem");
export const ToggleField = box("ToggleField");
export const SliderField = box("SliderField");
export const TextField = box("TextField");
export const DropdownItem = box("DropdownItem");
export const Field = box("Field");
export const Focusable = box("Focusable");
export const DialogButton = box("DialogButton");
export const ConfirmModal = box("ConfirmModal");
export function showModal(_modal: any) {
  return { Close() {}, Update() {} };
}
export const Dropdown = box("Dropdown");
export const Navigation = { Navigate() {}, CloseSideMenus() {} };
export const Router = { MainRunningApp: undefined as any, RunningApps: [] as any[] };
export const staticClasses = { Title: "title" };

export function Tabs(props: any) {
  // Render every tab's content so all option controls are exercised.
  return (
    <div data-mock="Tabs">
      {props.tabs.map((t: any) => (
        <div key={t.id} data-tab={t.id}>
          {t.content}
        </div>
      ))}
    </div>
  );
}

// The Steam library context-menu patch cannot run outside the Steam client, so
// the harness stands in for the webpack lookups it needs: nothing is found,
// which is exactly the path the plugin has to survive.
export const MenuItem = box("MenuItem");
export function findModuleExport(_filter: (e: any) => boolean) {
  return undefined;
}
export function findModuleByExport(_filter: (e: any) => boolean) {
  return undefined;
}
export function fakeRenderComponent(_fn: Function) {
  return undefined;
}
/**
 * Real implementations, not stubs: the context-menu patch is mostly tree
 * walking, so stubbing these would make its tests meaningless.
 */
export const findInTree = (
  parent: any,
  filter: (node: any) => boolean,
  opts: { walkable?: string[]; ignore?: string[] } = {},
): any => {
  const seen = new Set<any>();
  const walk = (node: any): any => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (filter(node)) return node;
    const keys = opts.walkable ?? Object.keys(node);
    for (const key of keys) {
      if (opts.ignore?.includes(key)) continue;
      const hit = walk(node[key]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(parent);
};

export const findInReactTree = (node: any, filter: (n: any) => boolean) =>
  findInTree(node, filter, { walkable: ["props", "children"] });
export function afterPatch(_target: any, _method: string, _hook: any, _opts?: any) {
  return { unpatch() {} };
}
export type Patch = { unpatch(): void };
