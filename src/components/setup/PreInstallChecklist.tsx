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
import type { AutoPlan, GameDetail, PlannedReframework, Recommendation } from "../../types";
import { shortenPath } from "../../utils/format";
import { Mono, Notice, Pill } from "../Common";
import {
  BADGE_COLORS,
  FoldRows,
  HotkeyNote,
  PlanRequirements,
  PluginStep,
  StepLabel,
  WikiTrouble,
  reframeworkSummary,
  settingsSummary,
} from "./helpers";

interface PreInstallChecklistProps {
  detail: GameDetail;
  appid: string | null;
  plan: AutoPlan | null;
  planned: AutoPlan | null;
  recommendation: Recommendation | null;
  loadingWiki: boolean;
  settling: boolean;
  busy: boolean;
  running: boolean;
  runtimeBlocked: boolean;
  requiredTarget: string | null;
  expectedPbzTarget: string | null;
  requiredTargetMismatch: boolean;
  needsOverride: boolean;
  launchWanted: string;
  launchCommand: string;
  launchManualMergeRequired: boolean;
  launchReadable: boolean;
  launchLoaded: boolean;
  withLaunch: boolean;
  withSettings: boolean;
  refWanted: PlannedReframework | null;
  refPresent: boolean;
  pluginPresent: boolean;
  logSummary: string;
  logPill: ReactNode;
  onChangeWithLaunch: (enabled: boolean) => void;
  onChangeWithSettings: (enabled: boolean) => void;
  onRun: () => void;
  onRetryWiki: () => void;
  onRefreshLaunch: () => void;
  onManual: () => void;
  onLogs: () => void;
}

export function PreInstallChecklist({
  detail,
  appid,
  plan,
  planned,
  recommendation,
  loadingWiki,
  settling,
  busy,
  running,
  runtimeBlocked,
  requiredTarget,
  expectedPbzTarget,
  requiredTargetMismatch,
  needsOverride,
  launchWanted,
  launchCommand,
  launchManualMergeRequired,
  launchReadable,
  launchLoaded,
  withLaunch,
  withSettings,
  refWanted,
  refPresent,
  pluginPresent,
  logSummary,
  logPill,
  onChangeWithLaunch,
  onChangeWithSettings,
  onRun,
  onRetryWiki,
  onRefreshLaunch,
  onManual,
  onLogs,
}: Readonly<PreInstallChecklistProps>) {
  const { t } = useI18n();
  // REFramework, when this game needs it, goes first: it is what OptiScaler
  // hooks into, so it is the step everything below depends on.
  const refStep = refWanted && refWanted.automatic ? 1 : 0;
  const steps =
    refStep +
    1 +
    (planned && needsOverride && appid && withLaunch ? 1 : 0) +
    (planned && withSettings ? 1 : 0);
  let step = 0;
  const next = () => (step += 1);
  const runLabel = busy
    ? t("Setting up…")
    : settling
      ? t("Reading this game's entry…")
      : steps === 4
        ? t("Do all four")
        : steps > 4
          ? t("Do all {count}", { count: steps })
          : steps === 3
            ? t("Do all three")
            : steps === 2
              ? t("Do both")
              : t("Just install it");

  return (
    <>
      <PanelSection title={detail.name}>
        <PanelSectionRow>
          {loadingWiki ? (
            <Notice tone="info">{t("Checking the OptiScaler wiki…")}</Notice>
          ) : planned && !runtimeBlocked ? (
            <Notice tone="success" title={t("This game can be set up automatically")}>
              {t("Matched “{game}” on the OptiScaler wiki{compat}.", {
                game: planned.game ?? "",
                compat: recommendation?.compatibility
                  ? t(" — reported {compat}", { compat: recommendation.compatibility })
                  : "",
              })}
              {settling
                ? t(" Still reading this game's own entry — the steps below may fill in shortly.")
                : ""}
            </Notice>
          ) : planned ? (
            <Notice tone="error" title={t("Automatic setup is unavailable")}>
              {plan?.blocked_reason ??
                t("The bundled runtime does not meet this game's requirements.")}
              {t(" You can continue with Manual setup.")}
            </Notice>
          ) : (
            <WikiTrouble
              recommendation={recommendation}
              busy={busy}
              onRetry={onRetryWiki}
            />
          )}
        </PanelSectionRow>
        {(!planned || runtimeBlocked) && !loadingWiki ? (
          <PanelSectionRow>
            <Focusable style={{ display: "flex" }}>
              <DialogButton
                onClick={onManual}
                onOKActionDescription={t("Set this game up by hand")}
                style={{ flexGrow: 1 }}
              >
                {t("Manual setup")}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {planned ? (
        <>
          <PanelSection>
            {requiredTargetMismatch && requiredTarget ? (
              <PanelSectionRow>
                <Notice tone="error" title={t("Choose the required game folder before setup")}>
                  {detail.target_is_saved ? t("Saved") : t("Selected")}{" "}
                  <Mono>{shortenPath(detail.target)}</Mono>,{" "}
                  <Mono>
                    {expectedPbzTarget ? shortenPath(expectedPbzTarget) : requiredTarget}
                  </Mono>
                  . {t("Pick the PBZ.exe folder in Manual setup; setup is paused until it matches.")}
                </Notice>
              </PanelSectionRow>
            ) : null}

            {refWanted ? (
              <PanelSectionRow>
                <Field
                  label={
                    <StepLabel
                      n={refWanted.automatic ? next() : undefined}
                      done={refPresent}
                    >
                      {refPresent ? t("REFramework is already here") : t("Install REFramework")}
                    </StepLabel>
                  }
                  description={
                    refPresent
                      ? t(
                          "{dll} already exists — setup backs it up before installing the wiki build.",
                          { dll: detail.reframework?.dll ?? refWanted.dll },
                        )
                      : t("Required by “{source}” so OptiScaler can hook this game. {summary}", {
                          source: refWanted.source,
                          summary: reframeworkSummary(refWanted),
                        })
                  }
                  bottomSeparator="standard"
                  childrenLayout="inline"
                  childrenContainerWidth="min"
                  focusable
                >
                  {refWanted.automatic ? (
                    <span style={{ fontSize: "11px", opacity: 0.5 }}>{t("required")}</span>
                  ) : (
                    <Pill color={BADGE_COLORS.warn}>{t("you")}</Pill>
                  )}
                </Field>
              </PanelSectionRow>
            ) : null}

            {refWanted ? <PluginStep wanted={refWanted} present={pluginPresent} /> : null}

            <PanelSectionRow>
              <Field
                label={
                  <StepLabel n={next()}>
                    {t("Install OptiScaler as {filename}", { filename: planned.filename })}
                  </StepLabel>
                }
                description={t("Into {dir}, next to the game executable.", {
                  dir: shortenPath(detail.target),
                })}
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
              >
                <span style={{ fontSize: "11px", opacity: 0.5 }}>{t("required")}</span>
              </Field>
            </PanelSectionRow>

            {needsOverride && appid ? (
              <PanelSectionRow>
                <ToggleField
                  label={<StepLabel n={next()}>{t("Set the Steam launch options")}</StepLabel>}
                  description={
                    launchManualMergeRequired
                      ? t("Complex shell syntax in Steam — add {wanted} manually.", {
                          wanted: launchWanted,
                        })
                      : planned.filename.toLowerCase().endsWith(".asi")
                        ? t("{cmd} — required by wiki entry.", { cmd: launchCommand })
                        : refWanted
                          ? t("{cmd} — required so Proton loads {filename} and {dll}.", {
                              cmd: launchCommand,
                              filename: planned.filename,
                              dll: refWanted.dll,
                            })
                          : t("{cmd} — required so Proton loads {filename}.", {
                              cmd: launchCommand,
                              filename: planned.filename,
                            })
                  }
                  checked={withLaunch}
                  disabled={busy || running || runtimeBlocked || requiredTargetMismatch}
                  bottomSeparator="standard"
                  onChange={onChangeWithLaunch}
                />
              </PanelSectionRow>
            ) : null}

            {!appid && needsOverride ? (
              <PanelSectionRow>
                <Notice tone="warn" title={t("Set the launch options yourself")}>
                  {t("Custom folder game — add {wanted} in your launcher.", {
                    wanted: launchWanted,
                  })}
                </Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel n={next()}>
                    {planned.settings.length > 0
                      ? t(
                          planned.settings.length === 1
                            ? "Apply the {count} setting the entry asks for"
                            : "Apply the {count} settings the entry asks for",
                          { count: planned.settings.length },
                        )
                      : t("Follow this game's wiki entry")}
                  </StepLabel>
                }
                description={
                  settingsSummary(planned) ||
                  t(
                    "No special settings needed. Applied on setup, enable, or re-apply (never continuously).",
                  )
                }
                checked={withSettings}
                disabled={busy || running || runtimeBlocked || requiredTargetMismatch}
                bottomSeparator="standard"
                onChange={onChangeWithSettings}
              />
            </PanelSectionRow>

            {withSettings ? <HotkeyNote plan={planned} /> : null}

            {!detail.writable ? (
              <PanelSectionRow>
                <Notice tone="error" title={t("Folder is not writable")}>
                  <Mono>{shortenPath(detail.target)}</Mono>
                </Notice>
              </PanelSectionRow>
            ) : null}

            {running ? (
              <PanelSectionRow>
                <Notice tone="warn">{t("Close the game before installing OptiScaler.")}</Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <Focusable style={{ display: "flex" }}>
                <DialogButton
                  disabled={
                    busy ||
                    running ||
                    settling ||
                    runtimeBlocked ||
                    !detail.writable ||
                    requiredTargetMismatch ||
                    (withLaunch && Boolean(appid) && needsOverride && !launchReadable)
                  }
                  onClick={onRun}
                  onOKActionDescription={t("Set this game up")}
                  style={{ flexGrow: 1 }}
                >
                  {runLabel}
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          </PanelSection>

          <PlanRequirements plan={planned} recommendation={recommendation} installed={false} />

          {needsOverride && appid && withLaunch && !launchReadable ? (
            <PanelSection>
              <PanelSectionRow>
                <Notice
                  tone={launchLoaded ? "error" : "info"}
                  title={t("Read Steam launch options before setup")}
                >
                  {launchLoaded
                    ? t("Could not read current Steam launch options — setup will not overwrite blindly.")
                    : t("Reading current Steam launch options…")}
                </Notice>
              </PanelSectionRow>
              {launchLoaded ? (
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
              ) : null}
            </PanelSection>
          ) : null}
        </>
      ) : null}

      <FoldRows
        installed={false}
        logSummary={logSummary}
        logPill={logPill}
        onManual={onManual}
        onLogs={onLogs}
      />

      <PanelSection>
        <PanelSectionRow>
          <Focusable
            focusWithinClassName="gpfocuswithin"
            style={{ fontSize: "12px", opacity: 0.6, padding: "4px 0", lineHeight: 1.45 }}
          >
            Nothing gets lost: any file OptiScaler replaces is set aside and put back when you
            remove it.
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
