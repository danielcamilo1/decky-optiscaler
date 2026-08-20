import { DialogButton, Focusable } from "@decky/ui";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * One compact row instead of a stack of PanelSections.
 *
 * On a handheld every row of chrome is a row of settings you cannot see, so the
 * back action, title, status and mode switch all share ~32px.
 */
export function DetailHeader({
  title,
  badges,
  onBack,
  action,
}: {
  title: string;
  badges?: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
}) {
  return (
    <Focusable
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "2px 12px 4px",
        flexShrink: 0,
        minHeight: "30px",
      }}
    >
      {/* A DialogButton, not a bare <button>: only Steam's own buttons are
          reachable with the D-pad, and a back action nothing can focus is a
          back action a controller does not have. */}
      {onBack ? (
        <DialogButton
          onClick={onBack}
          onOKActionDescription="Back to the games list"
          {...({ "data-back": "games" } as Record<string, string>)}
          style={{
            width: "auto",
            minWidth: 0,
            flexShrink: 0,
            fontSize: "12px",
            padding: "3px 9px",
          }}
        >
          ‹ Back
        </DialogButton>
      ) : null}
      <span
        style={{
          fontSize: "15px",
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {title}
      </span>
      <span style={{ flexShrink: 0 }}>{badges}</span>
      <span style={{ marginLeft: "auto", flexShrink: 0 }}>{action}</span>
    </Focusable>
  );
}

/**
 * The Basic/Advanced switch, as a two-state toggle rather than a label.
 *
 * It used to be a bare `<button>` printing whichever mode was current, which
 * left it both unreachable with the D-pad — Steam only routes gamepad focus to
 * its own focusable components — and mute about there being another mode at
 * all. Both halves are drawn, so the one that is not lit is the offer, and
 * activating it moves to that one.
 */
export function ModeSwitch({
  advanced,
  onChange,
}: {
  advanced: boolean;
  onChange: (advanced: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);

  const segment = (label: string, on: boolean) => (
    <span
      style={{
        padding: "2px 9px",
        borderRadius: "8px",
        // Focus paints the button light and its text dark, so the lit segment
        // has to invert with it or it turns into a light block on light.
        background: on ? (focused ? "#1a1c20" : "#1a9fff") : "transparent",
        color: on ? (focused ? "#ffffff" : "#06121d") : "inherit",
        opacity: on ? 1 : 0.75,
        fontWeight: on ? 700 : 500,
      }}
    >
      {label}
    </span>
  );

  return (
    <DialogButton
      onClick={() => onChange(!advanced)}
      onOKActionDescription={advanced ? "Show basic settings" : "Show every option"}
      // Neither the focus handlers nor the harness marker are declared props:
      // Steam's button forwards what it does not recognise to the element it
      // renders, so both go through one cast rather than by widening its type.
      {...({
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        "data-mode-switch": advanced ? "advanced" : "basic",
      } as Record<string, unknown>)}
      style={{
        width: "auto",
        minWidth: 0,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "2px",
        borderRadius: "10px",
        fontSize: "11px",
        padding: "2px 3px",
        whiteSpace: "nowrap",
      }}
    >
      {segment("Basic", !advanced)}
      {segment("Advanced", advanced)}
    </DialogButton>
  );
}
