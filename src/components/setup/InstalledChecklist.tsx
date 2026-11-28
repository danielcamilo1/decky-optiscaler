import {
  DialogButton,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { liveStatusMessage } from "../../liveControl";
import type {
  AutoPlan,
  GameDetail,
  LiveStatus,
  PlannedReframework,
  Recommendation,
} from "../../types";
import { shortenPath } from "../../utils/format";
import { Mono, Notice, Pill } from "../Common";
import { RecoverySection } from "./RecoverySection";
import {
  BADGE_COLORS,
  FoldRows,
  HotkeyNote,
  PlanRequirements,
  PluginStep,
  StepLabel,
  WikiTrouble,
  liveReason,
  reframeworkSummary,
  settingsSummary,
} from "./helpers";

interface InstalledChecklistProps {
  detail: GameDetail;
  appid: string | null;
  planned: AutoPlan | null;
  recommendation: Recommendation | null;
  loadingWiki: boolean;
  auto: boolean;
  autoBusy: boolean;
  live: LiveStatus | null;
  busy: boolean;
  running: boolean;
  runtimeBlocked: boolean;
  runtimeCurrent: boolean;
  requiredTarget: string | null;
  expectedPbzTarget: string | null;
  requiredTargetMismatch: boolean;
  needsOverride: boolean;
  overrideSet: boolean;
  launchNow: string | null;
  launchWanted: string;
  launchCommand: string;
  launchManualMergeRequired: boolean;
  launchReadable: boolean;
  launchLoaded: boolean;
  refWanted: PlannedReframework | null;
  refPresent: boolean;
  pluginPresent: boolean;
  logSummary: string;
  logPill: ReactNode;
  removeError: string | null;
  hasRemoveRetry: boolean;
  restoreBusy: boolean;
  restoreError?: string | null;
  onSetAuto: (enabled: boolean) => Promise<void> | void;
  onApplyLaunchOptions: (enabled: boolean) => void;
  onRefreshLaunch: () => void;
  onAddReframework: () => void;
  onDropReframework: () => void;
  onRetryWiki: () => void;
  onReapply: () => void;
  onConfirmReset: () => void;
  onConfirmUninstall: () => void;
  onRetryUninstall: () => void;
  onRestore?: () => Promise<void> | void;
  onRetryRestoreLaunchOptions?: () => void;
  onManual: () => void;
  onLogs: () => void;
}

export function InstalledChecklist({
  detail,
  appid,
  planned,
  recommendation,
  loadingWiki,
  auto,
  autoBusy,
  live,
  busy,
  running,
  runtimeBlocked,
  runtimeCurrent,
  requiredTarget,
  expectedPbzTarget,
  requiredTargetMismatch,
  needsOverride,
  overrideSet,
  launchNow,
  launchWanted,
  launchCommand,
  launchManualMergeRequired,
  launchReadable,
  launchLoaded,
  refWanted,
  refPresent,
  pluginPresent,
  logSummary,
  logPill,
  removeError,
  hasRemoveRetry,
  restoreBusy,
  restoreError,
  onSetAuto,
  onApplyLaunchOptions,
  onRefreshLaunch,
  onAddReframework,
  onDropReframework,
  onRetryWiki,
  onReapply,
  onConfirmReset,
  onConfirmUninstall,
  onRetryUninstall,
  onRestore,
  onRetryRestoreLaunchOptions,
  onManual,
  onLogs,
}: Readonly<InstalledChecklistProps>) {
  const { t } = useI18n();
  const backedUp = detail.install.backed_up.length;
  const managed = detail.install.managed;
  const refRevision = detail.reframework?.revision ?? detail.install.reframework?.revision ?? null;
  const refManuallyPlaced = detail.install.reframework?.managed === false;
  const refDllName = detail.reframework?.dll ?? refWanted?.dll ?? "dinput8.dll";

  return (
    <>
      <PanelSection title={detail.name}>
        <PanelSectionRow>
          <Field
            label={
              <StepLabel done>
                {t("Installed as {filename}", { filename: detail.install.filename ?? "" })}
              </StepLabel>
            }
            description={[
              detail.install.version ?? t("unknown build"),
              backedUp > 0
                ? t(backedUp === 1 ? "{count} file set aside" : "{count} files set aside", {
                    count: backedUp,
                  })
                : null,
              managed ? t("managed by this plugin") : t("installed externally"),
            ]
              .filter(Boolean)
              .join(" · ")}
            onClick={onManual}
            onActivate={onManual}
            focusable
            bottomSeparator="standard"
            childrenLayout="inline"
            childrenContainerWidth="min"
          >
            <Pill>{t("change")}</Pill>
          </Field>
        </PanelSectionRow>

        {requiredTargetMismatch && requiredTarget ? (
          <PanelSectionRow>
            <Notice tone="error" title={t("This install is in the wrong game folder")}>
              OptiScaler · <Mono>{shortenPath(detail.install.path)}</Mono> →{" "}
              <Mono>{expectedPbzTarget ? shortenPath(expectedPbzTarget) : requiredTarget}</Mono>.{" "}
              {managed
                ? t("Remove this install first")
                : t("Remove those external files manually first")}
              . {t("Pick the PBZ.exe folder in Manual setup; setup is paused until it matches.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {needsOverride && appid ? (
          launchReadable ? (
            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel done={overrideSet}>
                    {overrideSet ? t("Launch options set") : t("Launch options not set")}
                  </StepLabel>
                }
                description={
                  !managed
                    ? t("External install — manage Steam launch options manually.")
                    : overrideSet
                      ? launchNow ?? launchWanted
                      : launchManualMergeRequired
                        ? t("Complex shell syntax — add {wanted} in Steam manually.", {
                            wanted: launchWanted,
                          })
                        : detail.install.filename?.toLowerCase().endsWith(".asi")
                          ? t("Wiki entry requires {cmd}.", { cmd: launchCommand })
                          : t("Needed so Proton loads {filename}: {cmd}.", {
                              filename: detail.install.filename ?? "",
                              cmd: launchCommand,
                            })
                }
                checked={overrideSet}
                disabled={busy || !managed || requiredTargetMismatch}
                bottomSeparator="standard"
                onChange={onApplyLaunchOptions}
              />
            </PanelSectionRow>
          ) : (
            <>
              <PanelSectionRow>
                <Notice tone="error" title={t("Steam launch options could not be read")}>
                  {t("Current value is unknown, so it was left unchanged. Retry before modifying it.")}
                </Notice>
              </PanelSectionRow>
              <PanelSectionRow>
                <Focusable style={{ display: "flex" }}>
                  <DialogButton
                    disabled={busy}
                    onClick={onRefreshLaunch}
                    onOKActionDescription={t("Read Steam launch options again")}
                    style={{ flexGrow: 1 }}
                  >
                    {t("Read again")}
                  </DialogButton>
                </Focusable>
              </PanelSectionRow>
            </>
          )
        ) : null}

        {refWanted ? (
          <>
            {refPresent && refManuallyPlaced ? (
              <PanelSectionRow>
                <Field
                  label={<StepLabel done>{t("REFramework installed")}</StepLabel>}
                  description={[
                    refRevision
                      ? t("Build {rev}", { rev: refRevision.slice(0, 12) })
                      : refWanted.variant === "pd-upscaler"
                        ? t("pd-upscaler build")
                        : t("nightly build"),
                    t("added manually outside this plugin"),
                    t("move {dll} out of the game folder manually to disable", { dll: refDllName }),
                  ].join(" · ")}
                  focusable
                  bottomSeparator="standard"
                  childrenLayout="inline"
                  childrenContainerWidth="min"
                >
                  <Pill>{t("manual")}</Pill>
                </Field>
              </PanelSectionRow>
            ) : refWanted.automatic || refPresent ? (
              <PanelSectionRow>
                <ToggleField
                  label={
                    <StepLabel done={refPresent}>
                      {refPresent ? t("REFramework installed") : t("REFramework is missing")}
                    </StepLabel>
                  }
                  description={
                    running
                      ? t("Close the game first.")
                      : refPresent
                        ? [
                            refRevision
                              ? t("Build {rev}", { rev: refRevision.slice(0, 12) })
                              : refWanted.variant === "pd-upscaler"
                                ? t("pd-upscaler build")
                                : t("nightly build"),
                            t("installed by this plugin"),
                            t("turn off if the game stops launching"),
                          ].join(" · ")
                        : t(
                            "Required by “{source}” — without it OptiScaler won't affect the image. {summary}",
                            { source: refWanted.source, summary: reframeworkSummary(refWanted) },
                          )
                  }
                  checked={refPresent}
                  disabled={busy || running}
                  bottomSeparator="standard"
                  onChange={(checked) => (checked ? onAddReframework() : onDropReframework())}
                />
              </PanelSectionRow>
            ) : (
              <PanelSectionRow>
                <Field
                  label={<StepLabel done={false}>{t("REFramework is missing")}</StepLabel>}
                  description={t(
                    "Required by “{source}” — without it OptiScaler won't affect the image. {summary}",
                    { source: refWanted.source, summary: reframeworkSummary(refWanted) },
                  )}
                  focusable
                  bottomSeparator="standard"
                  childrenLayout="inline"
                  childrenContainerWidth="min"
                >
                  <Pill color={BADGE_COLORS.warn}>{t("you")}</Pill>
                </Field>
              </PanelSectionRow>
            )}
            <PluginStep wanted={refWanted} present={pluginPresent} />
          </>
        ) : null}

        {planned && auto ? <HotkeyNote plan={planned} /> : null}

        {!planned && !loadingWiki ? (
          recommendation && !recommendation.list_available ? (
            <PanelSectionRow>
              <WikiTrouble
                recommendation={recommendation}
                busy={busy}
                onRetry={onRetryWiki}
              />
            </PanelSectionRow>
          ) : (
            <PanelSectionRow>
              <Field
                label={<StepLabel>{t("No wiki entry matched this game")}</StepLabel>}
                description={t("Pick an entry under Manual setup, or manage settings yourself.")}
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
          )
        ) : null}

        {planned ? (
          <PanelSectionRow>
            <ToggleField
              label={
                <StepLabel done={auto}>
                  {autoBusy
                    ? t("Applying wiki settings…")
                    : auto
                      ? t("Using the wiki entry's settings")
                      : t("Not using the wiki entry's settings")}
                </StepLabel>
              }
              description={
                !runtimeCurrent
                  ? t("Upgrade runtime in Setup before using automatic settings.")
                  : auto
                    ? t("{summary} — applied on setup, enable, or re-apply (not continuously).", {
                        summary: settingsSummary(planned) || t("No special settings"),
                      })
                    : t(
                        "Manual control. Turn on to apply the wiki settings once; re-apply anytime for updates.",
                      )
              }
              checked={auto}
              disabled={
                busy || autoBusy || runtimeBlocked || !runtimeCurrent || requiredTargetMismatch
              }
              bottomSeparator="standard"
              onChange={(checked) => void onSetAuto(checked)}
            />
          </PanelSectionRow>
        ) : null}

        {running ? (
          <PanelSectionRow>
            <Field
              label={
                <StepLabel done={liveStatusMessage(live).ready}>
                  {liveStatusMessage(live).ready
                    ? t("Running now")
                    : t("Running, without live control")}
                </StepLabel>
              }
              description={
                liveStatusMessage(live).ready
                  ? t("Live control connected. {summary}", { summary: logSummary })
                  : liveReason(live)
              }
              onClick={onLogs}
              onActivate={onLogs}
              focusable
              bottomSeparator="standard"
              childrenLayout="inline"
              childrenContainerWidth="min"
            >
              {logPill}
            </Field>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {planned ? <PlanRequirements plan={planned} recommendation={recommendation} installed /> : null}

      <RecoverySection
        detail={detail}
        appid={appid}
        runtimeCurrent={runtimeCurrent}
        busy={busy}
        running={running}
        restoreBusy={restoreBusy}
        restoreError={restoreError}
        launchNow={launchNow}
        launchLoaded={launchLoaded}
        onRestore={onRestore}
        onRetryRestoreLaunchOptions={onRetryRestoreLaunchOptions}
      />

      <FoldRows
        installed
        logSummary={logSummary}
        logPill={logPill}
        onManual={onManual}
        onLogs={onLogs}
      />

      {removeError && hasRemoveRetry ? (
        <PanelSection title={t("Removal needs a retry")}>
          <PanelSectionRow>
            <Notice tone="error" title={t("OptiScaler is still installed")}>
              {removeError}
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable style={{ display: "flex" }}>
              <DialogButton
                disabled={busy || running}
                onClick={onRetryUninstall}
                onOKActionDescription={t("Retry the Steam update and remove OptiScaler")}
                style={{ flexGrow: 1 }}
              >
                {t("Retry Steam update and removal")}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection>
        {!managed ? (
          <PanelSectionRow>
            <Notice tone="warn" title={t("Installed outside this plugin")}>
              {requiredTargetMismatch && requiredTarget
                ? t(
                    "External install — Remove is disabled to protect unmanaged files. Delete manually from {dir} before selecting {target} in Manual setup.",
                    { dir: shortenPath(detail.install.path), target: requiredTarget },
                  )
                : t(
                    "External install — Remove is disabled to protect unmanaged files. Delete manually from {dir}.",
                    { dir: shortenPath(detail.install.path) },
                  )}
            </Notice>
          </PanelSectionRow>
        ) : null}
        {running ? (
          <PanelSectionRow>
            <Notice tone="warn">
              {t("Close the game before re-applying or removing OptiScaler files.")}
            </Notice>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <Focusable style={{ display: "flex", gap: "8px" }} flow-children="horizontal">
            {planned ? (
              <DialogButton
                disabled={busy || running || runtimeBlocked || requiredTargetMismatch}
                onClick={onReapply}
                onOKActionDescription={
                  runtimeCurrent
                    ? t("Set up again from the wiki")
                    : t("Upgrade the OptiScaler runtime and apply the wiki settings")
                }
                style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
              >
                {runtimeCurrent ? t("Set up again") : t("Upgrade runtime and re-apply")}
              </DialogButton>
            ) : null}
            <DialogButton
              disabled={busy || !runtimeCurrent}
              onClick={onConfirmReset}
              onOKActionDescription={t("Reset settings to stock")}
              style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
            >
              {t("Reset settings")}
            </DialogButton>
            <DialogButton
              disabled={busy || running || !managed}
              onClick={onConfirmUninstall}
              onOKActionDescription={t("Remove OptiScaler")}
              style={{
                flex: "1 1 0",
                minWidth: 0,
                fontSize: "13px",
                padding: "8px 6px",
                color: BADGE_COLORS.dangerText,
              }}
            >
              {t("Remove")}
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable
            focusWithinClassName="gpfocuswithin"
            style={{ fontSize: "12px", opacity: 0.6, padding: "4px 0", lineHeight: 1.45 }}
          >
            {!managed
              ? t("External install — remove files manually from the game folder.")
              : backedUp > 0
                ? t(
                    backedUp === 1
                      ? "Removing puts back the {count} file it set aside."
                      : "Removing puts back the {count} files it set aside.",
                    { count: backedUp },
                  )
                : t("Removing takes every file it installed back out.")}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
