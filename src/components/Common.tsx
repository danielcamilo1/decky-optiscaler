import { Field, Focusable, PanelSectionRow } from "@decky/ui";
import type { ReactNode } from "react";

type NoticeTone = "info" | "warn" | "error" | "success";

const TONE_COLORS: Record<NoticeTone, string> = {
  info: "#1a9fff",
  warn: "#e8a33d",
  error: "#e05c5c",
  success: "#5ba85b",
};

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  // Focusable, not a plain div: the Steam UI only scrolls to follow the focused
  // element, so a notice sitting after the last control on a page is otherwise
  // unreachable with the D-pad and the page appears to stop scrolling there.
  return (
    <Focusable
      focusWithinClassName="gpfocuswithin"
      style={{
        borderLeft: `3px solid ${TONE_COLORS[tone]}`,
        background: "rgba(255,255,255,0.04)",
        padding: "8px 10px",
        margin: "6px 0",
        borderRadius: "3px",
        fontSize: "13px",
        lineHeight: 1.45,
      }}
    >
      {title ? <div style={{ fontWeight: 600, marginBottom: "2px" }}>{title}</div> : null}
      <div style={{ opacity: 0.9 }}>{children}</div>
    </Focusable>
  );
}

export function KeyValue({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        padding: "3px 0",
        fontSize: "13px",
      }}
    >
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span style={{ textAlign: "right", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

export function Pill({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: "9px",
        fontSize: "11px",
        fontWeight: 600,
        background: color ?? "rgba(255,255,255,0.12)",
        marginRight: "5px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code style={{ fontFamily: "monospace", fontSize: "12px", wordBreak: "break-all" }}>
      {children}
    </code>
  );
}

/** A tappable row used for lists of libraries, games and folders. */
export function RowButton({
  onClick,
  label,
  description,
  right,
  disabled,
}: {
  onClick: () => void;
  label: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <PanelSectionRow>
      <Field
        label={label}
        description={description}
        onClick={disabled ? undefined : onClick}
        onActivate={disabled ? undefined : onClick}
        focusable={!disabled}
        bottomSeparator="standard"
        childrenLayout="inline"
        childrenContainerWidth="min"
      >
        {right}
      </Field>
    </PanelSectionRow>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <Focusable style={{ padding: "24px", textAlign: "center", opacity: 0.75 }}>
      {children}
    </Focusable>
  );
}
