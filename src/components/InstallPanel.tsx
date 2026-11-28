import { hasPbzIdentity, normalizeGamePath, pbzTargetMismatch } from "../gameTarget";
import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { install, setGameTarget, setWikiEntry } from "../api";
import {
  applyManagedLaunchOptions,
  currentLaunchOptions,
  launchOptionFor,
  mergeLaunchOptions,
  preserveExistingInstall,
  reconcileLaunchOptions,
  recordedValue,
} from "../launchOptions";
import {
  PREF_INSTALL_LAUNCH,
  getAppliedLaunchMetadata,
  isRemembering,
  readAppliedLaunchMetadata,
  recall,
  remember,
} from "../prefs";
import type { AppliedLaunchMetadata } from "../prefs";
import { useAutoPlan } from "../hooks/useAutoPlan";
import { useI18n } from "../i18n";
import type { GameDetail, LiveStatus, PayloadStatus } from "../types";
import { shortenPath, stripWikiMarkup } from "../utils/format";
import { KeyValue, Mono, Notice, Pill } from "./Common";
import { Fsr4Panel } from "./Fsr4Panel";
import { LivePanel } from "./LivePanel";
import { OptipatcherPanel } from "./OptipatcherPanel";
import { WikiSearch } from "./WikiSearch";
import { BADGE_COLORS, mergedWikiNotes } from "./setup/helpers";

type AutoPlanState = Pick<
  ReturnType<typeof useAutoPlan>,
  "plan" | "recommendation" | "loading" | "reload"
> &
  Partial<ReturnType<typeof useAutoPlan>>;

interface Props {
  detail: GameDetail;
  status: PayloadStatus | null;
  appid: string | null;
  live: LiveStatus | null;
  running: boolean;
  autoPlan?: AutoPlanState;
  onBeforeMutation?: () => Promise<void> | void;
  onChanged: () => Promise<void> | void;
}

/**
 * Asked once, right after an install that needs it.
 *
 * Without the override Proton loads its own copy of the DLL and OptiScaler
 * never runs at all, so this is the difference between an install that works
 * and one that silently does nothing — worth interrupting for, but not worth
 * asking twice, hence "Remember my choice".
 */
function LaunchOptionsPrompt({
  filename,
  launchOption,
  needsProxy = true,
  cleanupOnly = false,
  canRemember,
  closeModal,
  onDecide,
}: Readonly<{
  filename: string;
  launchOption: string;
  needsProxy?: boolean;
  cleanupOnly?: boolean;
  /** False once the user has turned remembering off under Settings. */
  canRemember: boolean;
  closeModal?: () => void;
  onDecide: (apply: boolean, remember: boolean) => void;
}>) {
  const { t } = useI18n();
  const [rememberIt, setRememberIt] = useState(false);
  const promptText = cleanupOnly
    ? t("{filename} needs no override. Updated Steam launch options preview:", { filename })
    : !needsProxy
      ? t("Wiki launch options for {filename}. Merged preview:", { filename })
      : t("Proton loads its own {filename} without this override. Merged preview:", { filename });
  return (
    <ConfirmModal
      strTitle={t("Set the Steam launch options?")}
      strOKButtonText={t("Set them for me")}
      strCancelButtonText={t("Not now")}
      closeModal={closeModal}
      onOK={() => onDecide(true, rememberIt)}
      onCancel={() => onDecide(false, rememberIt)}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        {promptText}
        <div style={{ margin: "8px 0" }}>
          <Mono>{launchOption || t("(empty)")}</Mono>
        </div>
      </div>
      {canRemember ? (
        <ToggleField
          label={t("Remember my choice")}
          checked={rememberIt}
          bottomSeparator="none"
          onChange={setRememberIt}
        />
      ) : null}
    </ConfirmModal>
  );
}

/**
 * Everything about one install that is not the three steps: which file name,
 * which folder, OptiPatcher, FSR 4 files, the wiki entry to follow and the
 * launch options. Reached from "Manual setup" on the setup checklist,
 * which is where the majority of games never have to come.
 */
export function InstallPanel({
  detail,
  status,
  appid,
  live,
  running,
  autoPlan,
  onBeforeMutation,
  onChanged,
}: Props) {
  const { t } = useI18n();
  const [filename, setFilename] = useState(detail.install.filename ?? "dxgi.dll");
  const [target, setTarget] = useState(detail.target);
  const [preserveIni, setPreserveIni] = useState(false);
  const [optipatcher, setOptipatcher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  /**
   * What Steam is passing right now, or null when no source could say.
   */
  const [launchNow, setLaunchNow] = useState<string | null>(null);
  const [launchRead, setLaunchRead] = useState(false);
  const [persistedLaunch, setPersistedLaunch] = useState<AppliedLaunchMetadata>({
    flags: [],
    extraOverrides: [],
  });
  const launchRequest = useRef(0);
  const activeAppid = useRef(appid);
  activeAppid.current = appid;
  const proxies = status?.proxy_filenames ?? ["dxgi.dll"];
  const runtimeCurrent = detail.install.managed && detail.install.runtime_current === true;
  const fallbackAutoPlan = useAutoPlan(detail.path, detail.name, !autoPlan);
  const {
    plan,
    recommendation,
    loading: loadingWiki,
    reload: lookup,
  } = autoPlan ?? fallbackAutoPlan;

  const isPbzGame = detail.is_pbz ?? hasPbzIdentity(detail);
  const targetRequirement = plan?.required_target ?? (isPbzGame ? "PBZ/platform/steam" : null);
  const inspectedTarget = detail.install.installed ? detail.install.path : target;
  const requiredTargetMismatch = pbzTargetMismatch(detail, Boolean(targetRequirement), inspectedTarget);
  const targetWritable =
    detail.candidates.find(
      (candidate) => normalizeGamePath(candidate.path) === normalizeGamePath(target),
    )?.writable ??
    (normalizeGamePath(target) === normalizeGamePath(detail.target) && detail.writable);

  useEffect(() => {
    setTarget(detail.target);
    if (detail.install.filename) setFilename(detail.install.filename);
  }, [detail.target, detail.install.filename]);

  useEffect(() => {
    if (recommendation && !detail.install.installed) setFilename(recommendation.filename);
  }, [recommendation, detail.install.installed]);

  const refreshLaunchOptions = useCallback(async () => {
    const request = ++launchRequest.current;
    setLaunchRead(false);
    try {
      const [value, persisted] = await Promise.all([
        currentLaunchOptions(appid),
        getAppliedLaunchMetadata(appid),
      ]);
      if (activeAppid.current !== appid || launchRequest.current !== request) return;
      setLaunchNow(value);
      setLaunchRead(true);
      setPersistedLaunch(persisted);
    } catch {
      if (activeAppid.current === appid && launchRequest.current === request) {
        setLaunchNow(null);
        setLaunchRead(true);
        setPersistedLaunch({ flags: [], extraOverrides: [] });
      }
    }
  }, [appid]);

  useEffect(() => {
    void refreshLaunchOptions();
  }, [refreshLaunchOptions, detail.install.installed]);

  // An .asi build is loaded by an ASI loader, so Proton has no proxy DLL to
  // shadow, though a wiki plan can still require game flags or extra overrides.
  const plannedFlags = plan?.launch_flags ?? [];
  const extraOverrides = plan?.reframework?.override ? [plan.reframework.override] : [];
  const needsProxyFor = (name: string) => !name.toLowerCase().endsWith(".asi");
  const needsLaunchFor = (name: string) =>
    needsProxyFor(name) || plannedFlags.length > 0 || extraOverrides.length > 0;
  const fallbackLaunchCommandFor = (name: string) => {
    if (
      plan?.available &&
      plan.filename.toLowerCase() === name.toLowerCase() &&
      plan.launch_options
    ) {
      return plan.launch_options;
    }
    if (!needsLaunchFor(name)) return launchOptionFor(name);
    return mergeLaunchOptions("", name, plannedFlags, extraOverrides) ?? launchOptionFor(name);
  };

  // Standalone launch-options UI always targets the DLL actually installed on
  // disk; changing the filename dropdown alone does not move files on disk.
  const installedFilename = detail.install.installed
    ? (detail.install.filename ?? filename)
    : filename;
  const selectedNeedsLaunch = needsLaunchFor(filename);
  const installedNeedsProxy = needsProxyFor(installedFilename);
  const installedNeedsLaunch = needsLaunchFor(installedFilename);
  const hasStalePersistedLaunch =
    persistedLaunch.flags.length > 0 || persistedLaunch.extraOverrides.length > 0;
  const launchDisplayRequired =
    installedNeedsLaunch || (detail.install.installed && hasStalePersistedLaunch);
  const launchReadRequired = Boolean(appid && (detail.install.installed || selectedNeedsLaunch));
  const launchUnavailable = launchReadRequired && (!launchRead || launchNow === null);
  const fallbackLaunchCommand = fallbackLaunchCommandFor(installedFilename);
  const mergedLaunchOption =
    launchNow === null
      ? null
      : reconcileLaunchOptions({
          current: launchNow,
          oldFilename: detail.install.installed ? detail.install.filename : null,
          nextFilename: installedFilename,
          nextFlags: plannedFlags,
          nextExtraOverrides: extraOverrides,
          persisted: persistedLaunch,
          recordedOriginal: recordedValue(detail.install.launch_record),
          applyNext: installedNeedsLaunch,
        }).value;
  const launchManualMergeRequired =
    launchDisplayRequired && launchNow !== null && mergedLaunchOption === null;
  const launchCommand = mergedLaunchOption ?? fallbackLaunchCommand;

  const beforeManagedMutation = async () => {
    await onBeforeMutation?.();
    if (!detail.install.installed) return;
    const preserved = await preserveExistingInstall(detail.install.path, detail.path, appid);
    if (!preserved.ok) {
      throw new Error(preserved.error ?? t("Could not preserve the current install."));
    }
  };

  const changeInstallTarget = async (nextTarget: string) => {
    if (detail.install.installed) return;
    if (normalizeGamePath(nextTarget) === normalizeGamePath(target)) return;
    const previousTarget = target;
    setTarget(nextTarget);
    setBusy(true);
    try {
      const result = await setGameTarget(detail.path, nextTarget);
      if (!result.ok) {
        setTarget(previousTarget);
        toaster.toast({
          title: t("Could not save install location"),
          body: String(result.error ?? t("The selected folder could not be saved.")),
        });
        return;
      }
      await onChanged();
    } catch (exc) {
      setTarget(previousTarget);
      toaster.toast({ title: t("Could not save install location"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const doInstall = async () => {
    if (running) return;
    setBusy(true);
    try {
      if (requiredTargetMismatch) {
        throw new Error(t("Choose the main PBZ.exe folder at PBZ/platform/steam first."));
      }
      if (!targetWritable) throw new Error(t("The chosen install folder is not writable."));
      await beforeManagedMutation();
      const targetFilename = filename;
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      if (!detail.install.installed && appid && needsLaunchFor(targetFilename)) {
        if (launchAtInstall === null) {
          throw new Error(
            t("Steam launch options could not be read. The install was left unchanged."),
          );
        }
      }
      if (appid && launchAtInstall !== null) {
        setLaunchNow(launchAtInstall);
        setLaunchRead(true);
      }
      const firstInstall = !detail.install.installed;
      const previousFilename = detail.install.installed ? detail.install.filename : null;
      const result = await install(
        target,
        targetFilename,
        firstInstall ? preserveIni : true,
        optipatcher,
        detail.path,
        launchAtInstall,
        false,
      );
      if (result.ok) {
        toaster.toast({
          title: t("OptiScaler installed"),
          body: `${targetFilename} in ${target.split("/").slice(-2).join("/")}`,
        });
        await onChanged();
        await offerLaunchOptions(
          true,
          previousFilename,
          recordedValue(detail.install.launch_record) ?? launchAtInstall,
          targetFilename,
        );
      } else {
        toaster.toast({ title: t("Install failed"), body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: t("Install failed"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * The one thing an install cannot do for itself without being asked.
   * Answered already? Honour that answer and say nothing.
   */
  const offerLaunchOptions = async (
    justInstalled = false,
    oldFilename?: string | null,
    recordedAtInstall?: string | null,
    targetFilename = installedFilename,
  ) => {
    if (!appid) return;
    const nextFilename = targetFilename;
    const nextNeedsProxy = needsProxyFor(nextFilename);
    const nextNeedsLaunch = needsLaunchFor(nextFilename);
    const effectiveOldFilename =
      oldFilename !== undefined
        ? oldFilename
        : detail.install.installed
          ? detail.install.filename
          : null;
    const trimmedOld = (effectiveOldFilename ?? "").trim();
    const filenameChanged =
      Boolean(trimmedOld) && trimmedOld.toLowerCase() !== nextFilename.trim().toLowerCase();
    const oldNeededProxy = Boolean(trimmedOld) && needsProxyFor(trimmedOld);

    const [latest, persistedResult] = await Promise.all([
      currentLaunchOptions(appid),
      readAppliedLaunchMetadata(appid),
    ]);
    if (latest !== null) {
      setLaunchNow(latest);
      setLaunchRead(true);
    }
    if (persistedResult.ok) {
      setPersistedLaunch(persistedResult.metadata);
    }
    const effectiveRecordedOriginal =
      recordedAtInstall !== undefined
        ? recordedAtInstall
        : recordedValue(detail.install.launch_record);
    const reconciled =
      latest === null || !persistedResult.ok
        ? null
        : reconcileLaunchOptions({
            current: latest,
            oldFilename: effectiveOldFilename,
            nextFilename,
            nextFlags: plannedFlags,
            nextExtraOverrides: extraOverrides,
            persisted: persistedResult.metadata,
            recordedOriginal: effectiveRecordedOriginal,
            applyNext: nextNeedsLaunch,
          });
    const oldNeedsCleanup =
      (filenameChanged && oldNeededProxy) ||
      Boolean(
        reconciled &&
          (reconciled.removedFlags.length > 0 ||
            reconciled.removedExtraOverrides.length > 0 ||
            reconciled.value === null),
      ) ||
      (!persistedResult.ok && Boolean(trimmedOld));
    if (!nextNeedsLaunch && !oldNeedsCleanup) return;

    const fallbackOpt = fallbackLaunchCommandFor(nextFilename);
    const preview =
      latest === null
        ? nextNeedsLaunch
          ? fallbackOpt
          : ""
        : !persistedResult.ok
          ? t("Saved launch option records could not be read. Try again before updating Steam.")
          : reconciled && reconciled.value !== null
            ? reconciled.value
            : nextNeedsLaunch
              ? t("Manual merge required. Add this override to your existing launch options: {opt}", {
                  opt: fallbackOpt,
                })
              : t(
                  "Manual cleanup required. Remove the previous OptiScaler override/flags in Steam manually.",
                );
    const remembered = await recall(PREF_INSTALL_LAUNCH);
    if (remembered === "never") return;
    const applyOptions = {
      confirmedTarget: justInstalled ? target : undefined,
      oldFilename: effectiveOldFilename,
      nextFilename,
      applyNext: nextNeedsLaunch,
      recordedOriginal: effectiveRecordedOriginal,
    };
    if (remembered === "always") {
      await applyLaunchOptions(applyOptions);
      return;
    }
    const canRemember = await isRemembering();
    showModal(
      <LaunchOptionsPrompt
        filename={nextFilename}
        launchOption={preview}
        needsProxy={nextNeedsProxy}
        cleanupOnly={!nextNeedsLaunch}
        canRemember={canRemember}
        onDecide={(apply, rememberIt) => {
          if (rememberIt) void remember(PREF_INSTALL_LAUNCH, apply ? "always" : "never");
          if (apply) void applyLaunchOptions(applyOptions);
        }}
      />,
    );
  };

  const applyLaunchOptions = async (options?: {
    confirmedTarget?: string;
    oldFilename?: string | null;
    nextFilename?: string;
    applyNext?: boolean;
    recordedOriginal?: string | null;
  }) => {
    const confirmedTarget = options?.confirmedTarget;
    if (requiredTargetMismatch || (!detail.install.managed && !confirmedTarget)) return false;
    if (!appid) {
      toaster.toast({
        title: t("Could not read Steam launch options"),
        body: t("The current value is unknown, so it was left unchanged."),
      });
      return false;
    }
    const targetFilename = options?.nextFilename ?? installedFilename;
    const targetApplyNext =
      options?.applyNext !== undefined ? options.applyNext : needsLaunchFor(targetFilename);
    const recordTarget =
      detail.install.installed || confirmedTarget
        ? (confirmedTarget ?? detail.install.path)
        : null;
    const effectiveRecordedOriginal =
      options?.recordedOriginal !== undefined
        ? options.recordedOriginal
        : recordedValue(detail.install.launch_record);
    const applied = await applyManagedLaunchOptions({
      appid,
      oldFilename:
        options?.oldFilename !== undefined
          ? options.oldFilename
          : detail.install.installed
            ? detail.install.filename
            : null,
      nextFilename: targetFilename,
      nextFlags: plannedFlags,
      nextExtraOverrides: extraOverrides,
      recordedOriginal: effectiveRecordedOriginal,
      recordTarget,
      applyNext: targetApplyNext,
    });
    if (applied.ok) {
      launchRequest.current += 1;
      setLaunchNow(applied.value);
      setLaunchRead(true);
      setPersistedLaunch(applied.nextOwned);
      toaster.toast({
        title: targetApplyNext
          ? t("Launch options updated")
          : t("OptiScaler launch options removed"),
        body: applied.value || detail.name,
      });
      return true;
    }
    if (applied.reason === "unreadable") {
      toaster.toast({
        title: t("Could not read Steam launch options"),
        body: t("The current value is unknown, so it was left unchanged."),
      });
    } else if (applied.reason === "metadata_unreadable") {
      toaster.toast({
        title: t("Could not read saved launch option records"),
        body: t("Steam was left unchanged so previous flags are not lost. Try again."),
      });
    } else if (applied.reason === "preserve_failed") {
      toaster.toast({
        title: t("Could not preserve launch options"),
        body: t("Steam was not changed."),
      });
    } else if (applied.reason === "manual_merge") {
      toaster.toast({
        title: t("Merge launch options manually"),
        body: targetApplyNext
          ? t(
              "Steam was left unchanged because its shell syntax cannot be merged safely. Required override: {opt}",
              { opt: fallbackLaunchCommandFor(targetFilename) },
            )
          : t(
              "Steam was left unchanged because its shell syntax cannot be cleaned up safely. Remove the previous OptiScaler override/flags manually in Steam.",
            ),
      });
    } else {
      toaster.toast({
        title: t("Could not set launch options"),
        body: t("Set them manually in Steam."),
      });
    }
    return false;
  };

  const wikiNotes = mergedWikiNotes(recommendation);
  const matchedCandidate = detail.candidates.find(
    (candidate) => normalizeGamePath(candidate.path) === normalizeGamePath(target),
  );
  const selectedLocationOption = matchedCandidate?.path ?? target;
  const locationOptions = [
    ...detail.candidates.map((candidate) => ({
      data: candidate.path,
      label: `${candidate.relative === "." ? t("game root") : candidate.relative} (${
        candidate.executables[0] ?? t("no exe")
      })`,
    })),
    ...(!matchedCandidate && target
      ? [
          {
            data: target,
            label: `${shortenPath(target, 2)}${detail.target_is_saved ? t(" (saved)") : ""}`,
          },
        ]
      : []),
  ];
  const showLocationSelector =
    detail.candidates.length > 1 ||
    detail.target_is_saved ||
    (detail.candidates.length === 1 &&
      normalizeGamePath(detail.candidates[0].path) !== normalizeGamePath(target));

  return (
    <>
      <PanelSection title={t("Compatibility")}>
        <PanelSectionRow>
          {loadingWiki ? (
            <Notice tone="info">{t("Checking the OptiScaler wiki…")}</Notice>
          ) : recommendation?.matched ? (
            <div style={{ padding: "2px 0" }}>
              <div style={{ marginBottom: "6px" }}>
                <Pill color={BADGE_COLORS.info}>{recommendation.compatibility ?? "?"}</Pill>
                <Pill>{recommendation.game}</Pill>
                {recommendation.optipatcher ? <Pill color="#5b4a85">OptiPatcher</Pill> : null}
              </div>
              <KeyValue
                label={t("Recommended file")}
                value={<Mono>{recommendation.filename}</Mono>}
              />
              <KeyValue label={t("Source")} value={recommendation.filename_source} />
              {recommendation.alternatives.length > 0 ? (
                <KeyValue
                  label={t("Also reported")}
                  value={recommendation.alternatives.join(", ")}
                />
              ) : null}
              {recommendation.inputs ? (
                <KeyValue label={t("Upscaler inputs")} value={recommendation.inputs} />
              ) : null}
              {recommendation.detail?.["FG Inputs"] ? (
                <KeyValue label={t("FG inputs")} value={recommendation.detail["FG Inputs"]} />
              ) : null}
              {wikiNotes ? (
                <Notice tone="info" title={t("Wiki notes")}>
                  {wikiNotes}
                </Notice>
              ) : null}
              {recommendation.detail?.["Known Issues"] &&
              recommendation.detail["Known Issues"] !== "-" ? (
                <Notice tone="warn" title={t("Known issues")}>
                  {stripWikiMarkup(recommendation.detail["Known Issues"])}
                </Notice>
              ) : null}
            </div>
          ) : recommendation && !recommendation.list_available ? (
            <Notice tone="error" title={t("Could not load the compatibility list")}>
              {recommendation.list_meta?.error ?? t("The wiki could not be reached.")}{" "}
              {t("Check the network and use “Refresh from wiki”.")}
            </Notice>
          ) : (
            <Notice tone="warn" title={t("No entry matched automatically")}>
              Checked {(recommendation?.searched ?? []).map((n) => `“${n}”`).join(" and ")} (
              {recommendation?.entry_count ?? 0} entries). Pick it below, or install manually (
              <Mono>dxgi.dll</Mono> is usually best).
            </Notice>
          )}
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={loadingWiki} onClick={() => void lookup(true)}>
            {t("Refresh from wiki")}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setSearching((value) => !value)}>
            {searching ? t("Hide search") : t("Find this game in the list myself")}
          </ButtonItem>
        </PanelSectionRow>
        {searching ? (
          <WikiSearch
            initialQuery={detail.name}
            current={detail.wiki_entry}
            onPick={async (entryName) => {
              try {
                const result = await setWikiEntry(detail.path, entryName);
                if (!result.ok) {
                  throw new Error(result.error ?? t("Could not save the wiki entry."));
                }
                setSearching(false);
                await onChanged();
                await lookup(false);
                toaster.toast({ title: t("Compatibility entry set"), body: entryName });
              } catch (exc) {
                toaster.toast({
                  title: t("Could not save compatibility entry"),
                  body: String(exc),
                });
              }
            }}
          />
        ) : null}
      </PanelSection>

      <PanelSection title={detail.install.installed ? t("Installation") : t("Install OptiScaler")}>
        {requiredTargetMismatch && targetRequirement ? (
          <PanelSectionRow>
            <Notice tone="error" title={t("This game needs a different install folder")}>
              {detail.install.installed ? (
                <>
                  Installed in <Mono>{shortenPath(detail.install.path)}</Mono>, but this game
                  requires <Mono>{targetRequirement}</Mono>.{" "}
                  {detail.install.managed
                    ? t("Remove this install first")
                    : t("Remove those external files manually first")}
                  , then pick the <Mono>PBZ.exe</Mono> folder.
                </>
              ) : (
                <>
                  Selected <Mono>{shortenPath(target)}</Mono>, but this game requires{" "}
                  <Mono>{targetRequirement}</Mono>. Pick the <Mono>PBZ.exe</Mono> folder before
                  installing.
                </>
              )}
            </Notice>
          </PanelSectionRow>
        ) : null}
        {detail.install.installed ? (
          <PanelSectionRow>
            <div style={{ padding: "2px 0" }}>
              <KeyValue label={t("Installed as")} value={<Mono>{detail.install.filename}</Mono>} />
              <KeyValue label={t("Version")} value={detail.install.version ?? t("unknown build")} />
              <KeyValue
                label={t("Managed by")}
                value={detail.install.managed ? t("this plugin") : t("installed externally")}
              />
              <KeyValue label={t("Folder")} value={<Mono>{shortenPath(detail.install.path)}</Mono>} />
              {detail.install.backed_up.length > 0 ? (
                <KeyValue
                  label={t("Files set aside")}
                  value={t("{count} in {dir}/", {
                    count: detail.install.backed_up.length,
                    dir: detail.install.backup_dir.split("/").pop() ?? "",
                  })}
                />
              ) : null}
              {detail.install.extra_proxies.length > 0 ? (
                <Notice tone="warn" title={t("Duplicate OptiScaler copies")}>
                  {t(
                    "Also found {extras}. Duplicate copies can crash the game — reinstall to clean up.",
                    { extras: detail.install.extra_proxies.join(", ") },
                  )}
                </Notice>
              ) : null}
            </div>
          </PanelSectionRow>
        ) : null}

        {showLocationSelector ? (
          <PanelSectionRow>
            <DropdownItem
              label={t("Install location")}
              description={t("Must sit next to the game's rendering executable.")}
              disabled={busy || detail.install.installed}
              bottomSeparator="standard"
              rgOptions={locationOptions}
              selectedOption={selectedLocationOption}
              onChange={(selected) => void changeInstallTarget(String(selected.data))}
            />
          </PanelSectionRow>
        ) : null}

        <PanelSectionRow>
          <DropdownItem
            label={t("Filename override")}
            description={t("Proxy filename the game loads.")}
            disabled={busy}
            bottomSeparator="standard"
            rgOptions={proxies.map((name) => ({
              data: name,
              label:
                recommendation?.matched && name === recommendation.filename
                  ? t("{name} — recommended", { name })
                  : name,
            }))}
            selectedOption={filename}
            onChange={(selected) => setFilename(String(selected.data))}
          />
        </PanelSectionRow>

        {detail.ini_info?.legacy ? (
          <PanelSectionRow>
            <Notice tone="warn" title={t("Existing config looks out of date")}>
              {t("Config uses old FGType key; upgrading migrates supported values while keeping comments.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {detail.install.installed ? null : (
          <PanelSectionRow>
            <ToggleField
              label={t("Also install OptiPatcher")}
              description={t(
                "Exposes DLSS/DLSS-FG inputs in supported games (e.g. RDR2) without GPU spoofing; harmless elsewhere.",
              )}
              checked={optipatcher}
              disabled={busy}
              bottomSeparator="standard"
              onChange={setOptipatcher}
            />
          </PanelSectionRow>
        )}

        {detail.install.installed ? (
          <PanelSectionRow>
            <Notice tone="info" title={t("Existing settings are preserved")}>
              {t("Upgrades keep your OptiScaler.ini and migrate supported settings.")}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {detail.install.installed ? null : (
          <PanelSectionRow>
            <ToggleField
              label={t("Keep existing OptiScaler.ini")}
              description={t("Keep settings from a prior install instead of writing defaults.")}
              checked={preserveIni}
              disabled={busy}
              bottomSeparator="standard"
              onChange={setPreserveIni}
            />
          </PanelSectionRow>
        )}

        {!detail.install.installed ? (
          <PanelSectionRow>
            <Notice tone="info" title={t("Nothing gets lost")}>
              {t(
                "Overwritten game files are backed up to decky_optiscaler_backup_files/ and restored on uninstall.",
              )}
            </Notice>
          </PanelSectionRow>
        ) : null}

        {!targetWritable ? (
          <PanelSectionRow>
            <Notice tone="error" title={t("Folder is not writable")}>
              <Mono>{shortenPath(target)}</Mono>
            </Notice>
          </PanelSectionRow>
        ) : null}

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={
              busy || running || !targetWritable || launchUnavailable || requiredTargetMismatch
            }
            description={running ? t("Close the game first.") : undefined}
            onClick={doInstall}
          >
            {busy
              ? t("Working…")
              : detail.install.installed
                ? !runtimeCurrent
                  ? t("Upgrade runtime as {filename}", { filename })
                  : detail.install.filename === filename
                    ? t("Reinstall as {filename}", { filename })
                    : t("Switch to {filename}", { filename })
                : t("Install as {filename}", { filename })}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {detail.install.installed ? (
        <Fsr4Panel
          targetDir={detail.install.path}
          sources={detail.fsr4_sources ?? []}
          gpu={detail.gpu}
          running={running}
          readOnly={!runtimeCurrent}
          onBeforeMutation={beforeManagedMutation}
          onChanged={onChanged}
        />
      ) : null}

      {detail.install.installed ? (
        <LivePanel
          targetDir={detail.install.path}
          status={live}
          running={running}
          onBeforeMutation={beforeManagedMutation}
          onChanged={onChanged}
        />
      ) : null}

      {detail.install.installed ? (
        <OptipatcherPanel
          targetDir={detail.install.path}
          running={running}
          readOnly={!runtimeCurrent}
          onBeforeMutation={beforeManagedMutation}
          onChanged={onChanged}
        />
      ) : null}

      <PanelSection title={t("Steam Launch Options")}>
        <PanelSectionRow>
          <Notice tone={!launchDisplayRequired ? "info" : "warn"}>
            {!launchDisplayRequired ? (
              t("An .asi build is loaded by an ASI loader and needs no override.")
            ) : launchManualMergeRequired ? (
              installedNeedsLaunch ? (
                <>
                  {t("Current Steam options use complex shell syntax. Add this override manually:")}
                  <div style={{ marginTop: "6px" }}>
                    <Mono>{fallbackLaunchCommand}</Mono>
                  </div>
                </>
              ) : (
                t(
                  "Current Steam options use complex shell syntax. Remove the previous OptiScaler override/flags manually in Steam.",
                )
              )
            ) : (
              <>
                {installedNeedsProxy
                  ? t("Proton loads its own {filename} without this override:", {
                      filename: installedFilename,
                    })
                  : installedNeedsLaunch
                    ? t("Wiki launch options for {filename}:", { filename: installedFilename })
                    : t("Previous OptiScaler launch options can be cleaned up:")}
                <div style={{ marginTop: "6px" }}>
                  <Mono>{launchCommand || t("(empty)")}</Mono>
                </div>
                {launchNow === null && appid ? (
                  <div style={{ marginTop: "6px", opacity: 0.8 }}>
                    {t(
                      "Current Steam options could not be read, so Steam will not be overwritten automatically.",
                    )}
                  </div>
                ) : null}
              </>
            )}
          </Notice>
        </PanelSectionRow>
        {appid ? (
          <PanelSectionRow>
            <Focusable
              focusWithinClassName="gpfocuswithin"
              style={{ padding: "2px 0", width: "100%" }}
            >
              <KeyValue
                label={t("Steam is passing")}
                value={
                  !launchRead ? (
                    t("reading…")
                  ) : launchNow === null ? (
                    t("Steam would not say")
                  ) : launchNow === "" ? (
                    t("nothing")
                  ) : (
                    <Mono>{launchNow}</Mono>
                  )
                }
              />
              <KeyValue
                label={t("Before the install")}
                value={
                  !detail.install.installed ? (
                    "—"
                  ) : detail.install.launch_record?.recorded ? (
                    detail.install.launch_record.value ? (
                      <Mono>{detail.install.launch_record.value}</Mono>
                    ) : (
                      t("nothing")
                    )
                  ) : (
                    t("not recorded")
                  )
                }
              />
            </Focusable>
          </PanelSectionRow>
        ) : null}
        {appid && detail.install.installed && launchDisplayRequired ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={
                busy ||
                !detail.install.managed ||
                !launchRead ||
                launchNow === null ||
                requiredTargetMismatch
              }
              onClick={() => void applyLaunchOptions()}
            >
              {t("Set launch options for me")}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        {appid && launchRead && launchNow === null ? (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void refreshLaunchOptions()}>
              {t("Retry reading Steam launch options")}
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        {!appid ? (
          <PanelSectionRow>
            <Focusable style={{ fontSize: "12px", opacity: 0.7, padding: "4px 0" }}>
              {t("Custom folder game — add this override in your launcher.")}
            </Focusable>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    </>
  );
}
