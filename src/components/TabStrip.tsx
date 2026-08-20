import { DialogButton, Focusable } from "@decky/ui";
import { useState } from "react";
import type { ReactNode } from "react";

export interface StripTab {
  id: string;
  title: string;
  /** Small count or state shown after the title, e.g. the number of games. */
  badge?: ReactNode;
}

/**
 * `data-*` markers so the UI harness can find and press a tab.
 *
 * They are not part of DialogButton's declared props — Steam's button forwards
 * what it does not recognise to the element it renders — so they are attached
 * through one cast rather than by widening the component's type.
 */
/**
 * `onFocus`/`onBlur` are not in `DialogButtonProps` either, for the same
 * reason: they are DOM handlers Steam's button forwards to the element it
 * renders. This strip needs them because it paints the focused tab itself.
 */
function focusHandlers(onFocus: () => void, onBlur: () => void) {
  return { onFocus, onBlur } as Record<string, () => void>;
}

function marker(name: string, id: string, active: boolean) {
  return { [`data-${name}`]: id, "data-active": active ? "true" : "false" } as Record<
    string,
    string
  >;
}

/**
 * A compact tab switcher for the Quick Access panel.
 *
 * `Tabs` from @decky/ui is built for a full-screen page: it wants a tall
 * container it can own, and its tab bar is sized for the library view. The QAM
 * panel is a ~310px column that scrolls as one piece, so this is a row of
 * buttons instead.
 *
 * They are `DialogButton`s rather than styled `Focusable`s. A bare `Focusable`
 * is itself a focus target in this UI — that is exactly what `Notice` relies on
 * — so a row of them nested inside another one gave the D-pad a container to
 * land on and no way to reach the tabs inside it. `DialogButton` is a real
 * button: focus goes to the buttons, and A activates the one that has it.
 *
 * Only the active tab's content is rendered by the caller, which matters here:
 * the games list and the running game's live poll should not both be running
 * because the panel is open.
 */
export function TabStrip({
  tabs,
  active,
  onChange,
  marker: markerName = "tab",
}: {
  tabs: StripTab[];
  active: string;
  onChange: (id: string) => void;
  /** What the harness markers are called: tabs switch views, filters do not. */
  marker?: string;
}) {
  // Which tab the D-pad is on. Steam marks that with a class; this strip has to
  // know it too, because it sets the background the class expects to own.
  const [focus, setFocus] = useState<string | null>(null);

  return (
    <Focusable
      style={{ display: "flex", gap: "4px", padding: "6px 14px 8px" }}
      // Left and right move between the tabs; up and down leave the strip.
      flow-children="horizontal"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const focused = tab.id === focus;
        return (
          <DialogButton
            key={tab.id}
            {...marker(markerName, tab.id, selected)}
            onClick={() => onChange(tab.id)}
            onOKActionDescription={`Show ${tab.title}`}
            {...focusHandlers(
              () => setFocus(tab.id),
              () => setFocus((current) => (current === tab.id ? null : current))
            )}
            style={{
              flex: "1 1 0",
              minWidth: 0,
              padding: "8px 4px",
              fontSize: "12px",
              lineHeight: 1.1,
              fontWeight: selected ? 700 : 400,
              // Steam's own focus class paints the button's *text* dark and
              // expects the background to become light with it. An inline
              // background beats that class, so a focused tab kept this
              // translucent dark fill and became dark-on-dark. Both halves of
              // the pair are therefore set here: focus wins over selection and
              // brings its own foreground with it.
              background: focused
                ? "rgba(255,255,255,0.95)"
                : selected
                  ? "rgba(255,255,255,0.22)"
                  : "rgba(255,255,255,0.08)",
              color: focused ? "#1a1c20" : "#ffffff",
              // No dimming: an unselected tab is told apart by weight and fill,
              // never by being harder to read.
              opacity: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tab.title}
            {tab.badge != null ? (
              <span style={{ opacity: 0.7, marginLeft: "4px" }}>{tab.badge}</span>
            ) : null}
          </DialogButton>
        );
      })}
    </Focusable>
  );
}
