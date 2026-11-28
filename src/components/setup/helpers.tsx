import { DialogButton, Field, Focusable, PanelSection, PanelSectionRow } from "@decky/ui";
import type { ReactNode } from "react";
import { FaCheck } from "react-icons/fa";
import { t as translate, useI18n } from "../../i18n";
import { liveStatusMessage } from "../../liveControl";
import type { AutoPlan, LiveStatus, PlannedReframework, Recommendation } from "../../types";
import { stripWikiMarkup } from "../../utils/format";
import { Notice, Pill } from "../Common";

/** Shared badge & status colors aligned with Common.tsx semantic tones. */
export const BADGE_COLORS = {
  success: "#2f6b3f",
  warn: "#8a5a2b",
  info: "#3a6ea5",
  dangerText: "#e05c5c",
} as const;

/** The numbered circle before a step, or a tick once it is done. */
export function Mark({ n, done }: Readonly<{ n?: number; done?: boolean }>) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        height: "22px",
        borderRadius: "50%",
        marginRight: "9px",
        flexShrink: 0,
        fontSize: "11px",
        fontWeight: 700,
        background: done ? BADGE_COLORS.success : "transparent",
        border: done ? "none" : "1.5px solid rgba(255,255,255,0.3)",
        color: done ? "#fff" : "rgba(255,255,255,0.65)",
      }}
    >
      {done ? <FaCheck size={11} /> : n}
    </span>
  );
}

export function StepLabel({
  n,
  done,
  children,
}: Readonly<{
  n?: number;
  done?: boolean;
  children: ReactNode;
}>) {
  return (
    <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
      <Mark n={n} done={done} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </span>
  );
}

/**
 * Why live control is not answering, in the same cases the live panel
 * separates — each has a different fix.
 */
export function liveReason(live: LiveStatus | null) {
  const state = liveStatusMessage(live);
  return `${state.title}. ${state.detail}`;
}

/** What the wiki asks to be written, as one readable line. */
export function settingsSummary(plan: AutoPlan) {
  return plan.settings.map((item) => `${item.key}=${item.value}`).join(", ");
}

/**
 * The REFramework step, said in one line.
 */
export function reframeworkSummary(ref: PlannedReframework) {
  const build =
    ref.variant === "pd-upscaler"
      ? translate("the pd-upscaler build for this game")
      : translate("praydog's nightly build");
  if (ref.automatic) {
    return translate("Downloads {build} and puts {dll} next to the executable.", {
      build,
      dll: ref.dll,
    });
  }
  const why = ref.reason ?? translate("it cannot be downloaded from here");
  return translate("{why} — get {build} from {page}, and put {dll} next to the executable yourself.", {
    why: `${why.charAt(0).toUpperCase()}${why.slice(1)}`,
    build,
    page: ref.page,
    dll: ref.dll,
  });
}

/**
 * Why there is no plan: the list could not be downloaded, or this game is not
 * on it.
 */
export function WikiTrouble({
  recommendation,
  busy,
  onRetry,
}: Readonly<{
  recommendation: Recommendation | null;
  busy: boolean;
  onRetry: () => void;
}>) {
  const { t } = useI18n();
  const unreachable = recommendation !== null && !recommendation.list_available;
  if (!unreachable) {
    return (
      <Notice tone="warn" title={t("No wiki entry matched this game")}>
        {t(
          "OptiScaler still works with most DLSS/FSR2+/XeSS games. Use Manual setup (dxgi.dll is usual) or search the wiki list.",
        )}
      </Notice>
    );
  }
  return (
    <>
      <Notice tone="error" title={t("The compatibility list could not be downloaded")}>
        {t(
          "This is not the same as your game being missing — the wiki could not be checked. {error} Check network and try again, or use Manual setup.",
          { error: recommendation?.list_meta?.error ?? t("Wiki unreachable.") },
        )}
      </Notice>
      <Focusable style={{ display: "flex", marginTop: "6px" }}>
        <DialogButton
          disabled={busy}
          onClick={onRetry}
          onOKActionDescription={t("Download the compatibility list again")}
          style={{ flexGrow: 1 }}
        >
          {busy ? t("Trying…") : t("Try again")}
        </DialogButton>
      </Focusable>
    </>
  );
}

/**
 * Deduplicate and combine `recommendation.notes` and `recommendation.detail.Notes`
 * into a single cleaned wiki notes string.
 */
export function mergedWikiNotes(recommendation: Recommendation | null): string | null {
  const parts: string[] = [];
  for (const raw of [recommendation?.notes, recommendation?.detail?.Notes]) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "-") continue;
    const cleaned = stripWikiMarkup(trimmed);
    if (!cleaned || cleaned === "-") continue;
    const lower = cleaned.toLowerCase();
    if (parts.some((existing) => existing.toLowerCase().includes(lower))) continue;
    const supersededIndex = parts.findIndex((existing) => lower.includes(existing.toLowerCase()));
    if (supersededIndex >= 0) {
      parts[supersededIndex] = cleaned;
    } else {
      parts.push(cleaned);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Filter out autoplan warnings that merely repeat checklist items already shown
 * on the Setup screen (REFramework, PDPerfPlugin.dll, Known Issues), while
 * keeping standalone warnings such as "❌ not working".
 */
function filterRedundantWarnings(
  plan: AutoPlan,
  hasKnownIssues: boolean,
): string[] {
  const raw = plan.warnings ?? [];
  const pluginLower = plan.reframework?.plugin?.toLowerCase() ?? null;
  const dllLower = plan.reframework?.dll?.toLowerCase() ?? null;
  return raw.filter((warning) => {
    const cleaned = stripWikiMarkup(warning).toLowerCase();
    if (!cleaned) return false;
    if (plan.reframework && (
      cleaned.includes("needs reframework") ||
      (dllLower && cleaned.includes(dllLower) && cleaned.includes("reframework"))
    )) {
      return false;
    }
    if (pluginLower && cleaned.includes(pluginLower)) {
      return false;
    }
    if (hasKnownIssues && (
      cleaned.includes("known issues on the wiki") ||
      cleaned.includes("read them on the setup tab")
    )) {
      return false;
    }
    return true;
  });
}

export function PlanRequirements({
  plan,
  recommendation,
  installed,
}: Readonly<{
  plan: AutoPlan;
  recommendation: Recommendation | null;
  installed: boolean;
}>) {
  const { t } = useI18n();
  const knownIssuesRaw = recommendation?.detail?.["Known Issues"];
  const knownIssues =
    knownIssuesRaw && knownIssuesRaw.trim() !== "-" ? stripWikiMarkup(knownIssuesRaw) : null;
  const hasKnownIssues = Boolean(knownIssues && knownIssues !== "-");
  const wikiNotes = mergedWikiNotes(recommendation);
  const warnings = filterRedundantWarnings(plan, hasKnownIssues);
  const unresolved = plan.unresolved ?? [];
  const steps = plan.manual_steps ?? [];
  // When not yet installed, PreInstallChecklist already renders the blocked
  // error notice at the top of the page. Keep it here when installed.
  const showRuntimeBlocked =
    installed && Boolean(plan.runtime_supported === false || plan.blocked_reason);

  if (
    !wikiNotes &&
    !hasKnownIssues &&
    warnings.length === 0 &&
    unresolved.length === 0 &&
    steps.length === 0 &&
    !showRuntimeBlocked &&
    !plan.required_version &&
    !plan.required_target
  ) {
    return null;
  }

  return (
    <PanelSection title={t("Requirements and notes")}>
      {plan.required_version || plan.required_target ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Runtime requirement")}>
            {plan.required_version
              ? t("OptiScaler {version} or newer", { version: plan.required_version })
              : t("A supported OptiScaler runtime")}
            {plan.required_target
              ? t(" · required game folder: {target}", { target: plan.required_target })
              : ""}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {showRuntimeBlocked ? (
        <PanelSectionRow>
          <Notice tone="error" title={t("Automatic setup is blocked")}>
            {plan.blocked_reason ?? t("The bundled runtime does not meet this game's requirement.")}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {steps.map((step, index) => (
        <PanelSectionRow key={`manual-${index}`}>
          <Notice tone="warn" title={index === 0 ? t("Required manual steps") : undefined}>
            {stripWikiMarkup(step)}
          </Notice>
        </PanelSectionRow>
      ))}
      {wikiNotes ? (
        <PanelSectionRow>
          <Notice tone="info" title={t("Wiki notes")}>
            {wikiNotes}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {hasKnownIssues && knownIssues ? (
        <PanelSectionRow>
          <Notice tone="warn" title={t("Known issues")}>
            {knownIssues}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {warnings.map((warning, index) => (
        <PanelSectionRow key={`warning-${index}`}>
          <Notice tone="warn" title={t("Setup warning")}>
            {stripWikiMarkup(warning)}
          </Notice>
        </PanelSectionRow>
      ))}
      {unresolved.map((item, index) => (
        <PanelSectionRow key={`unresolved-${index}`}>
          <Notice tone="warn" title={t("Manual setting needed")}>
            {stripWikiMarkup(item.text)}
            {item.source ? ` · ${stripWikiMarkup(item.source)}` : ""}
          </Notice>
        </PanelSectionRow>
      ))}
    </PanelSection>
  );
}

/**
 * The one file in this whole flow that cannot be automatic (e.g. PureDark's
 * UpscalerBasePlugin on Nexus Mods behind a login). Rendered as a single
 * unified warning row when missing, or a ticked step row when present.
 */
/* The prop is `wanted`, not `ref`: React reserves `ref` on JSX props. */
export function PluginStep({
  wanted,
  present,
}: Readonly<{ wanted: PlannedReframework; present: boolean }>) {
  const { t } = useI18n();
  if (!wanted.plugin) return null;
  if (!present) {
    return (
      <PanelSectionRow>
        <Notice
          tone="warn"
          title={
            <StepLabel>
              {t("Add {plugin} yourself", { plugin: wanted.plugin })}
            </StepLabel>
          }
        >
          {t(
            "This game will not upscale yet: {plugin} ({name}) is behind a Nexus Mods login and must be downloaded from {url} into the game folder. Until then, the panel will connect and report normally while nothing on screen changes.",
            {
              plugin: wanted.plugin,
              name: wanted.plugin_name ?? "",
              url: wanted.plugin_url ?? "",
            },
          )}
        </Notice>
      </PanelSectionRow>
    );
  }
  return (
    <PanelSectionRow>
      <Field
        label={
          <StepLabel done>
            {t("{plugin} is there", { plugin: wanted.plugin })}
          </StepLabel>
        }
        description={t("From {name}. Nothing else to do for this step.", {
          name: wanted.plugin_name ?? "",
        })}
        bottomSeparator="standard"
        childrenLayout="inline"
        childrenContainerWidth="min"
        focusable
      >
        <Pill color={BADGE_COLORS.success}>{t("done")}</Pill>
      </Field>
    </PanelSectionRow>
  );
}

/**
 * What the plan will do to the overlay's shortcut key, said out loud.
 */
export function HotkeyNote({ plan }: Readonly<{ plan: AutoPlan }>) {
  const { t } = useI18n();
  const hotkey = plan.hotkey;
  if (!hotkey) return null;
  const key = hotkey.name ?? hotkey.value;
  return (
    <PanelSectionRow>
      <Notice tone="info" title={t("The overlay opens on a different key")}>
        {t("Overlay key moves to {key}{reason}. Press {key} in game, not Insert.", {
          key,
          reason: plan.reframework ? t(" (avoids REFramework Insert conflict)") : "",
        })}
      </Notice>
    </PanelSectionRow>
  );
}

export function FoldRows({
  installed,
  logSummary,
  logPill,
  onManual,
  onLogs,
}: Readonly<{
  installed: boolean;
  logSummary: string;
  logPill: ReactNode;
  onManual: () => void;
  onLogs: () => void;
}>) {
  const { t } = useI18n();
  return (
    <PanelSection>
      <PanelSectionRow>
        <Field
          label={t("Manual setup")}
          description={t("File name, folder, OptiPatcher, FSR 4 files, launch options.")}
          onClick={onManual}
          onActivate={onManual}
          focusable
          bottomSeparator="standard"
          childrenLayout="inline"
          childrenContainerWidth="min"
        >
          <span style={{ opacity: 0.5 }}>›</span>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <Field
          label={t("Logs")}
          description={
            installed
              ? logSummary
              : t("What OptiScaler loaded, the GPU it found, and any errors.")
          }
          onClick={onLogs}
          onActivate={onLogs}
          focusable
          bottomSeparator="standard"
          childrenLayout="inline"
          childrenContainerWidth="min"
        >
          {installed ? logPill : <Pill>{t("no log yet")}</Pill>}
        </Field>
      </PanelSectionRow>
    </PanelSection>
  );
}
