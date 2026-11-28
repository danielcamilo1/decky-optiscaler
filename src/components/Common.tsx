import { Field, Focusable, PanelSectionRow } from "@decky/ui";
import type { ReactNode } from "react";

export type NoticeTone = "info" | "warn" | "error" | "success";
export type PillTone = "neutral" | NoticeTone;

export const TONE_COLORS: Record<NoticeTone, string> = {
  info: "#1a9fff",
  warn: "#e8a33d",
  error: "#e05c5c",
  success: "#5ba85b",
};

export const TONE_BACKGROUNDS: Record<NoticeTone, string> = {
  info: "rgba(26,159,255,0.10)",
  warn: "rgba(232,163,61,0.12)",
  error: "rgba(224,92,92,0.12)",
  success: "rgba(91,168,91,0.12)",
};

export const PILL_TONES: Record<PillTone, { background: string; color?: string }> = {
  neutral: { background: "rgba(255,255,255,0.12)" },
  info: { background: "#3a6ea5" },
  warn: { background: "#5a4a20" },
  error: { background: "#6b2f2f" },
  success: { background: "#2f6b3f" },
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

export function Pill({
  children,
  color,
  tone,
}: {
  children: ReactNode;
  color?: string;
  tone?: PillTone;
}) {
  const styleTone = tone ? PILL_TONES[tone] : undefined;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: "9px",
        fontSize: "11px",
        fontWeight: 600,
        background: color ?? styleTone?.background ?? PILL_TONES.neutral.background,
        color: styleTone?.color,
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
