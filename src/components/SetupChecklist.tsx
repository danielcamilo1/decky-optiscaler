import { canonicalPbzTarget, hasPbzIdentity, pbzTargetMismatch } from "../gameTarget";
import {
  DialogButton,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { FaCheck } from "react-icons/fa";
import {
  autoInstall,
  getMonitor,
  install,
  installReframework,
  refreshWiki,
  removeReframework,
  resetConfig,
  uninstall,
} from "../api";
import { setLaunchOptions } from "../hooks/useRunningGame";
import { liveStatusMessage } from "../liveControl";
import {
  currentLaunchOptions,
  hasOverride,
  launchChoices,
  launchOptionFor,
  mergeLaunchOptions,
  preserveExistingInstall,
  recordPreviousLaunchOptions,
  recordedValue,
  resolveChoice,
  stripLaunchOptions,
} from "../launchOptions";
import type { LaunchAction, LaunchState } from "../launchOptions";
import { PREF_REMOVE_LAUNCH, isRemembering, recallLaunchAction, remember } from "../prefs";
import type {
  AutoPlan,
  GameDetail,
  LiveStatus,
  MonitorReport,
  PlannedReframework,
  Recommendation,
} from "../types";
import { Mono, Notice, Pill } from "./Common";
import { RemovePrompt } from "./RemovePrompt";

/**
 * Setting a game up, as a checklist rather than a page of panels.
 *
 * Three things have to happen for OptiScaler to work: the DLL goes next to the
 * game's executable, Steam has to be told to load it instead of Proton's own,
 * and the settings the wiki names for this game have to reach the ini. The old
 * Setup tab had all three, spread over nine sections and a mode switch, and
 * nothing said what had been done. This says all three before they happen and
 * keeps saying them afterwards, which is the same list read twice.
 *
 * Only the first is compulsory: the launch options and the wiki's settings each
 * carry a toggle, before the install as a choice and after it as the way to
 * undo that step alone. Everything else — the file name, the folder,
 * OptiPatcher, FSR 4 files, picking a different wiki entry — is behind "Manual
 * setup", because it is a minority of set-ups and all of it has a default that
 * works.
 */
interface Props {
  detail: GameDetail;
  appid: string | null;
  plan: AutoPlan | null;
  recommendation: Recommendation | null;
  loadingWiki: boolean;
  /** True while a background wiki refresh could still change the plan below. */
  refreshing?: boolean;
  auto: boolean;
  autoBusy?: boolean;
  live: LiveStatus | null;
  /** Whether this game is the one running right now. */
  running: boolean;
  onSetAuto: (enabled: boolean) => Promise<void> | void;
  onManual: () => void;
  onLogs: () => void;
  onChanged: () => Promise<void> | void;
  onRemoved?: () => void;
  onReloadPlan: () => Promise<void> | void;
  onResetConfig: () => Promise<void> | void;
  onBeforeMutation?: () => Promise<void> | void;
  onRestore?: () => Promise<void> | void;
  restoreBusy?: boolean;
  restoreError?: string | null;
  onRetryRestoreLaunchOptions?: () => void;
}

interface RemoveRetry {
  action: LaunchAction;
  value: string;
  previous: string | null;
}

/** The numbered circle before a step, or a tick once it is done. */
function Mark({ n, done }: Readonly<{ n?: number; done?: boolean }>) {
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
        background: done ? "#3e8a4a" : "transparent",
        border: done ? "none" : "1.5px solid rgba(255,255,255,0.3)",
        color: done ? "#fff" : "rgba(255,255,255,0.65)",
      }}
    >
      {done ? <FaCheck size={11} /> : n}
    </span>
  );
}

function StepLabel({ n, done, children }: Readonly<{
  n?: number;
  done?: boolean;
  children: React.ReactNode;
}>) {
  return (
    <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
      <Mark n={n} done={done} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </span>
  );
}

function shorten(path: string, keep = 3) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}



/**
 * Why live control is not answering, in the same four cases the live panel
 * separates — each has a different fix, and "not connected" on its own sends
 * nobody anywhere.
 */
function liveReason(live: LiveStatus | null) {
  const state = liveStatusMessage(live);
  return `${state.title}. ${state.detail}`;
}

/**
 * Why there is no plan: the list could not be downloaded, or this game is not
 * on it.
 *
 * These are not the same thing and used to render identically. A game that is
 * genuinely not in the compatibility list is the ordinary case and nothing is
 * wrong; a list that would not download is a fault, usually a network one, and
 * telling the user "no wiki entry matched this game" for every game they open
 * is how "the wiki feature is not working" becomes impossible to act on. The
 * failure is printed in the words of whatever actually failed, with the one
 * button that can do anything about it.
 */
function WikiTrouble({
  recommendation,
  busy,
  onRetry,
}: Readonly<{
  recommendation: Recommendation | null;
  busy: boolean;
  onRetry: () => void;
}>) {
  const unreachable = recommendation !== null && !recommendation.list_available;
  if (!unreachable) {
    return (
      <Notice tone="warn" title="No wiki entry matched this game">
        OptiScaler still works with most DLSS, FSR 2+ and XeSS games. Set it up by hand —
        <Mono>dxgi.dll</Mono> is the usual choice — or find this game in the wiki list
        yourself.
      </Notice>
    );
  }
  return (
    <>
      <Notice tone="error" title="The compatibility list could not be downloaded">
        This is not the same as your game being missing from it — nothing could be checked at
        all. {recommendation?.list_meta?.error ? <Mono>{recommendation.list_meta.error}</Mono>
          : "The wiki could not be reached."}{" "}
        Check the Deck's network connection, then try again. Setting the game up by hand works
        either way.
      </Notice>
      <Focusable style={{ display: "flex", marginTop: "6px" }}>
        <DialogButton
          disabled={busy}
          onClick={onRetry}
          onOKActionDescription="Download the compatibility list again"
          style={{ flexGrow: 1 }}
        >
          {busy ? "Trying…" : "Try again"}
        </DialogButton>
      </Focusable>
    </>
  );
}

/** What the wiki asks to be written, as one readable line. */
function settingsSummary(plan: AutoPlan) {
  return plan.settings.map((item) => `${item.key}=${item.value}`).join(", ");
}

const PBZ_PLAN_NAMES = new Set(["pbz", "phantom blade zero", "影之刃零"]);

function isPbzPlan(plan: AutoPlan | null | undefined) {
  return Boolean(plan?.required_target && plan.game && PBZ_PLAN_NAMES.has(plan.game.trim().toLocaleLowerCase()));
}

function plainWikiText(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .trim();
}

function PlanRequirements({
  plan,
  recommendation,
}: Readonly<{ plan: AutoPlan; recommendation: Recommendation | null }>) {
  const knownIssues = recommendation?.detail?.["Known Issues"];
  const warnings = plan.warnings ?? [];
  const unresolved = plan.unresolved ?? [];
  const steps = plan.manual_steps ?? [];
  const hasNotes = Boolean(recommendation?.notes);
  const wikiDetailNotes = recommendation?.detail?.Notes;
  const hasWikiDetailNotes = Boolean(wikiDetailNotes && wikiDetailNotes !== "-");
  const hasKnownIssues = Boolean(knownIssues && knownIssues !== "-");
  if (
    !hasNotes && !hasWikiDetailNotes && !hasKnownIssues && warnings.length === 0 && unresolved.length === 0 &&
    steps.length === 0 && !plan.blocked_reason && plan.runtime_supported !== false &&
    !plan.required_version && !plan.required_target
  ) return null;

  return (
    <PanelSection title="Requirements and notes">
      {plan.required_version || plan.required_target ? (
        <PanelSectionRow>
          <Notice tone="info" title="Runtime requirement">
            {plan.required_version ? `OptiScaler ${plan.required_version} or newer` : "A supported OptiScaler runtime"}
            {plan.required_target ? ` · required game folder: ${plan.required_target}` : ""}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {plan.runtime_supported === false || plan.blocked_reason ? (
        <PanelSectionRow>
          <Notice tone="error" title="Automatic setup is blocked">
            {plan.blocked_reason ?? "The bundled runtime does not meet this game's requirement."}
          </Notice>
        </PanelSectionRow>
      ) : null}
      {steps.map((step, index) => (
        <PanelSectionRow key={`manual-${index}`}>
          <Notice tone="warn" title={index === 0 ? "Required manual steps" : undefined}>
            {plainWikiText(step)}
          </Notice>
        </PanelSectionRow>
      ))}
      {hasNotes ? (
        <PanelSectionRow>
          <Notice tone="info" title="Wiki notes">{plainWikiText(recommendation!.notes!)}</Notice>
        </PanelSectionRow>
      ) : null}
      {hasWikiDetailNotes ? (
        <PanelSectionRow>
          <Notice tone="info" title="Wiki notes">{plainWikiText(wikiDetailNotes!)}</Notice>
        </PanelSectionRow>
      ) : null}
      {hasKnownIssues ? (
        <PanelSectionRow>
          <Notice tone="warn" title="Known issues">{plainWikiText(knownIssues!)}</Notice>
        </PanelSectionRow>
      ) : null}
      {warnings.map((warning, index) => (
        <PanelSectionRow key={`warning-${index}`}>
          <Notice tone="warn" title="Setup warning">{plainWikiText(warning)}</Notice>
        </PanelSectionRow>
      ))}
      {unresolved.map((item, index) => (
        <PanelSectionRow key={`unresolved-${index}`}>
          <Notice tone="warn" title="Manual setting needed">
            {plainWikiText(item.text)}{item.source ? ` · ${plainWikiText(item.source)}` : ""}
          </Notice>
        </PanelSectionRow>
      ))}
    </PanelSection>
  );
}

/**
 * The REFramework step, said in one line.
 *
 * Which build matters and is not interchangeable: praydog's unified nightly and
 * the per-game pd-upscaler branch are different mods that happen to share a
 * filename, and the entries that want one explicitly do not work with the
 * other. Naming it is also what makes the step checkable by hand afterwards.
 */
function reframeworkSummary(ref: PlannedReframework) {
  const build =
    ref.variant === "pd-upscaler"
      ? "the pd-upscaler build for this game"
      : "praydog's nightly build";
  if (ref.automatic) return `Downloads ${build} and puts ${ref.dll} next to the executable.`;
  // The reason is a clause written to sit mid-sentence — "no build is known for
  // this game", "this plugin no longer downloads it for you" — and this is
  // where it starts one.
  const why = ref.reason ?? "it cannot be downloaded from here";
  return `${why.charAt(0).toUpperCase()}${why.slice(1)} — get ${build} from ${ref.page}, and put ${ref.dll} next to the executable yourself.`;
}

/**
 * The one file in this whole flow that cannot be automatic.
 *
 * PureDark's UpscalerBasePlugin is on Nexus Mods behind a login, so nothing
 * here can fetch it, and the pd-upscaler games do not work without it. It gets
 * a row of its own rather than a line in a warning: an install that reports
 * success and leaves the game rendering exactly as before is the failure this
 * whole feature exists to stop, and it would be absurd to reintroduce it one
 * file further down.
 */
/* The prop is `wanted`, not `ref`: React reserves `ref`, strips it from the
   props object, and the component receives nothing at all. */
function PluginStep({
  wanted,
  present,
}: Readonly<{ wanted: PlannedReframework; present: boolean }>) {
  if (!wanted.plugin) return null;
  return (
    <>
      {!present ? (
        <PanelSectionRow>
          {/* Loud, not a quiet pill. Without this file OptiScaler loads, the
              live panel connects, the frame rate reads out — and the game
              upscales nothing, which is exactly how this was reported: "it
              shows as live and connected but doesn't seem to be doing
              anything". A row nobody reads is how that happened. */}
          <Notice tone="warn" title="This game will not upscale yet">
            <Mono>{wanted.plugin}</Mono> has to be next to the executable before OptiScaler
            can do anything in this game, and it is on Nexus Mods behind a login, so nothing
            here can fetch it. Get {wanted.plugin_name} from <Mono>{wanted.plugin_url}</Mono>{" "}
            and put <Mono>{wanted.plugin}</Mono> in the game folder. Until then the panel will
            connect and report normally while nothing on screen changes.
          </Notice>
        </PanelSectionRow>
      ) : null}
    <PanelSectionRow>
      <Field
        label={
          <StepLabel done={present}>
            {present ? (
              <>
                <Mono>{wanted.plugin}</Mono> is there
              </>
            ) : (
              <>
                Add <Mono>{wanted.plugin}</Mono> yourself
              </>
            )}
          </StepLabel>
        }
        description={
          present
            ? `From ${wanted.plugin_name}. Nothing else to do for this step.`
            : `This game also needs ${wanted.plugin_name}, which is on Nexus Mods behind a
               login — nothing here can download it. Put ${wanted.plugin} next to the
               executable: ${wanted.plugin_url}`
        }
        bottomSeparator="standard"
        childrenLayout="inline"
        childrenContainerWidth="min"
        focusable
      >
        {present ? <Pill color="#2f6b3f">done</Pill> : <Pill color="#5a4a20">you</Pill>}
      </Field>
    </PanelSectionRow>
    </>
  );
}

/**
 * What the plan will do to the overlay's shortcut key, said out loud.
 *
 * Several REFramework entries ask for `ShortcutKey=0x24` because REF's own
 * overlay is on Insert as well. Applying it is right; applying it in silence is
 * not — "pressing Insert doesn't pop the OptiScaler overlay" is what a moved
 * key looks like from the outside, and it reads as the plugin being broken.
 */
function HotkeyNote({ plan }: Readonly<{ plan: AutoPlan }>) {
  const hotkey = plan.hotkey;
  if (!hotkey) return null;
  return (
    <PanelSectionRow>
      <Notice tone="info" title="The overlay opens on a different key">
        This entry asks for OptiScaler's overlay to move to{" "}
        <Mono>{hotkey.name ?? hotkey.value}</Mono>
        {plan.reframework ? ", because REFramework's overlay uses Insert too" : ""}. Press{" "}
        <Mono>{hotkey.name ?? hotkey.value}</Mono> in game, not Insert.
      </Notice>
    </PanelSectionRow>
  );
}

export function SetupChecklist({
  detail,
  appid,
  plan,
  recommendation,
  loadingWiki,
  refreshing,
  auto,
  live,
  running,
  onSetAuto,
  onManual,
  onLogs,
  onChanged,
  onRemoved,
  onReloadPlan,
  onResetConfig,
  onBeforeMutation,
  autoBusy = false,
  onRestore,
  restoreBusy = false,
  restoreError,
  onRetryRestoreLaunchOptions,
}: Readonly<Props>) {
  const installed = Boolean(detail.install.installed);
  const planned = plan?.available ? plan : null;
  const filename = detail.install.filename ?? planned?.filename ?? "dxgi.dll";
  // An .asi build is loaded by an ASI loader, so Proton has nothing to shadow
  // and there is no override to set.
  const needsOverride = !filename.toLowerCase().endsWith(".asi");
  const launchWanted = planned?.launch_options ?? launchOptionFor(filename);

  const [withLaunch, setWithLaunch] = useState(true);
  const [withSettings, setWithSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removeRetry, setRemoveRetry] = useState<RemoveRetry | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** Steam's current launch options, or null when the client will not say. */
  const [launchNow, setLaunchNow] = useState<string | null>(null);
  const [launchReadable, setLaunchReadable] = useState(false);
  const [launchLoaded, setLaunchLoaded] = useState(false);
  const [report, setReport] = useState<MonitorReport | null>(null);
  const launchRequest = useRef(0);
  const activeAppid = useRef(appid);
  activeAppid.current = appid;

  const refreshLaunch = useCallback(async () => {
    const request = ++launchRequest.current;
    if (!appid) {
      setLaunchNow(null);
      setLaunchReadable(false);
      setLaunchLoaded(true);
      return;
    }
    setLaunchLoaded(false);
    try {
      const value = await currentLaunchOptions(appid);
      if (activeAppid.current !== appid || launchRequest.current !== request) return;
      setLaunchNow(value);
      setLaunchReadable(value !== null);
      setLaunchLoaded(true);
    } catch {
      if (activeAppid.current === appid && launchRequest.current === request) {
        setLaunchNow(null);
        setLaunchReadable(false);
        setLaunchLoaded(true);
      }
    }
  }, [appid]);

  useEffect(() => {
    void refreshLaunch();
  }, [refreshLaunch]);

  useEffect(() => {
    if (!installed) return;
    void (async () => {
      try {
        setReport(await getMonitor(detail.install.path));
      } catch {
        /* the log is optional; the row falls back to what it knows */
      }
    })();
  }, [installed, detail.install.path]);

  /**
   * REFramework, when this game's entry says OptiScaler does nothing without it.
   *
   * Taken from the plan before the install and from the folder after it, which
   * are answers to two different questions: what this game needs, and what it
   * has. The second is read from the folder rather than from our own manifest
   * on purpose — somebody's existing working copy of REF counts, and
   * re-installing over it would be a worse answer than leaving it alone.
   */
  const ref = planned?.reframework ?? null;
  const launchFlags = planned?.launch_flags ?? [];
  const extraOverrides = ref?.override ? [ref.override] : [];
  const mergedLaunchOptions = launchNow === null
    ? null
    : mergeLaunchOptions(launchNow, filename, launchFlags, extraOverrides);
  const launchPreview = mergedLaunchOptions ?? (launchNow !== null
    ? `Manual merge required. Add this override to your existing launch options: ${launchWanted}`
    : launchWanted);
  const runtimeBlocked = Boolean(
    plan && (plan.runtime_supported === false || plan.blocked_reason),
  );
  // A missing or unknown runtime identity is read-only too. The backend only
  // enables schema-specific writes after matching the installed proxy hash.
  const runtimeCurrent = detail.install.managed && detail.install.runtime_current === true;
  const isPbzGame = isPbzPlan(planned) || hasPbzIdentity(detail);
  const requiredTarget = planned?.required_target ?? (isPbzGame ? "PBZ/platform/steam" : null);
  const expectedPbzTarget = canonicalPbzTarget(detail);
  const actualTarget = detail.install.installed ? detail.install.path : detail.target;
  const requiredTargetMismatch = pbzTargetMismatch(detail, Boolean(requiredTarget), actualTarget);
  const rollbackLaunchOptions = detail.install.rollback?.metadata?.launch_options;
  const canRetryRestoreLaunchOptions = typeof rollbackLaunchOptions === "string";
  const refPresent = detail.reframework?.installed ?? detail.install.reframework?.installed
    ?? false;
  const pluginPresent = detail.reframework?.plugin_installed ?? false;

  /**
   * Both overrides, not just OptiScaler's.
   *
   * REFramework needs its own `WINEDLLOVERRIDES` entry for exactly the reason
   * OptiScaler's proxy does: Proton ships a dinput8 of its own and loads that
   * in preference to the game folder. The wiki never mentions it — it is
   * written for Windows, where the folder wins — so a set-up that followed the
   * entry to the letter would put REF in place and never load it.
   */
  const overrideSet =
    launchNow !== null &&
    hasOverride(launchNow, filename) &&
    (!ref || hasOverride(launchNow, ref.override));

  /**
   * Whether this answer may still improve on its own.
   *
   * The compatibility-list row answers first and this game's own wiki page
   * arrives behind it — and the page is what names the filename to install as,
   * so acting in that window would install under the default name when the
   * entry says otherwise. Both halves matter: a page that is *pending* but no
   * longer being fetched is one the wiki would not serve, and waiting on that
   * is waiting for ever.
   */
  const settling = Boolean(recommendation?.detail_pending) && Boolean(refreshing);

  const beforeManagedMutation = async () => {
    await onBeforeMutation?.();
    if (!installed) return;
    const preserved = await preserveExistingInstall(detail.install.path, detail.path, appid);
    if (!preserved.ok) {
      throw new Error(preserved.error ?? "Could not preserve the current install.");
    }
  };

  const applyLaunchOptions = async (enabled: boolean): Promise<boolean> => {
    if (!appid) return false;
    let latest = await currentLaunchOptions(appid);
    if (latest === null) {
      toaster.toast({ title: "Could not read Steam launch options", body: "The current value is unknown, so it was left unchanged." });
      return false;
    }
    if (enabled && installed) {
      const recorded = await recordPreviousLaunchOptions(appid, detail.install.path);
      if (!recorded) {
        toaster.toast({ title: "Could not preserve launch options", body: "Steam was not changed." });
        return false;
      }
      latest = await currentLaunchOptions(appid);
      if (latest === null) {
        toaster.toast({ title: "Could not read Steam launch options", body: "Steam was not changed." });
        return false;
      }
    }
    const value = enabled
      ? mergeLaunchOptions(latest, filename, launchFlags, extraOverrides)
      : stripLaunchOptions(
          latest,
          filename,
          launchFlags,
          extraOverrides,
          recordedValue(detail.install.launch_record),
        );
    if (value === null) {
      toaster.toast({ title: "Merge launch options manually", body: `Steam was left unchanged because its shell syntax cannot be merged safely. Required override: ${launchWanted}` });
      return false;
    }
    if (setLaunchOptions(Number(appid), value)) {
      // A launch-options read can still be in flight from before this write.
      // Do not let its older disk snapshot replace the value Steam just took.
      launchRequest.current += 1;
      setLaunchNow(value);
      setLaunchReadable(true);
      setLaunchLoaded(true);
      toaster.toast({
        title: enabled ? "Launch options updated" : "OptiScaler launch options removed",
        body: value || detail.name,
      });
      return true;
    }
    toaster.toast({
      title: "Could not reach Steam",
      body: "Set the launch options manually.",
    });
    return false;
  };

  /** Step 1, plus whichever of steps 2 and 3 are switched on. */
  const run = async () => {
    if (!planned || runtimeBlocked) return;
    if (requiredTargetMismatch) {
      toaster.toast({ title: "Choose the required game folder first", body: `PBZ needs the folder at ${requiredTarget ?? "PBZ/platform/steam"}.` });
      return;
    }
    setBusy(true);
    try {
      await beforeManagedMutation();
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      if (withLaunch && appid && needsOverride && launchAtInstall === null) {
        throw new Error("Steam did not report the current launch options. Read them before setup so existing settings are preserved.");
      }
      if (withLaunch && appid && needsOverride && launchAtInstall !== null &&
          mergeLaunchOptions(launchAtInstall, filename, launchFlags, extraOverrides) === null) {
        throw new Error(`Steam uses shell syntax that cannot be merged safely. Set the launch options manually, or uncheck that step. Required override: ${launchWanted}`);
      }
      if (appid && launchAtInstall !== null) {
        setLaunchNow(launchAtInstall);
        setLaunchReadable(true);
      }
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      if (withSettings) {
        const result = await autoInstall(detail.target, detail.path, detail.name, [folder], launchAtInstall);
        if (!result.ok) {
          throw new Error(String(result.error ?? "Automatic setup failed."));
        }
      } else {
        const result = await install(
          detail.target,
          planned.filename,
          true,
          planned.optipatcher,
          detail.path,
          launchAtInstall,
          false,
        );
        if (!result.ok) {
          throw new Error(String(result.error ?? "Install failed."));
        }
        // REFramework is not one of the wiki's *settings*, so switching those
        // off must not switch it off with them: it is the reason OptiScaler
        // can hook this game at all, and an install without it is one that
        // loads, reports nothing wrong and changes nothing on screen. The
        // automatic path above places it as part of the plan; this one has to
        // ask for it separately.
        if (ref?.automatic) {
          const added = await installReframework(detail.target, detail.path, detail.name, [folder]);
          if (!added.ok) {
            throw new Error(`OptiScaler was installed, but REFramework was not: ${String(added.error ?? "install failed")}`);
          }
        }
      }
      if (withLaunch && appid && needsOverride) {
        const launchApplied = await applyLaunchOptions(true);
        if (!launchApplied) {
          await onChanged();
          await refreshLaunch();
          return;
        }
      }
      toaster.toast({
        title: `${detail.name} is set up`,
        body: `Installed as ${planned.filename}.`,
      });
      await onChanged();
    } catch (exc) {
      toaster.toast({ title: "Setup failed", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Add REFramework on its own, for a game already set up or a download that
   * failed the first time.
   *
   * Its own action rather than "install everything again" because a 13 MB
   * download over a handheld's connection is the part that fails, and making
   * somebody reinstall OptiScaler to retry it is a poor answer to a flaky
   * network.
   */
  const addReframework = async () => {
    setBusy(true);
    try {
      await beforeManagedMutation();
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      const result = await installReframework(detail.target, detail.path, detail.name, [folder]);
      if (result.ok) {
        toaster.toast({ title: "REFramework installed", body: detail.name });
        await onChanged();
      } else {
        toaster.toast({ title: "Could not install REFramework", body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: "Could not install REFramework", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Take REFramework back out, leaving OptiScaler where it is.
   *
   * The isolation test. REFramework is a third-party DLL that hooks the engine,
   * and when a game stops booting after a set-up there is no way to learn
   * whether that was OptiScaler or REF unless one of them can come out on its
   * own. Making the install all-or-nothing left exactly that: a game that would
   * not start and nothing to bisect it with.
   */
  const dropReframework = async () => {
    setBusy(true);
    try {
      await beforeManagedMutation();
      const result = await removeReframework(detail.install.path);
      if (result.ok) {
        toaster.toast({
          title: "REFramework removed",
          body: "OptiScaler is still installed. Launch the game to see which one it was.",
        });
        await onChanged();
      } else {
        toaster.toast({ title: "Could not remove REFramework", body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: "Could not remove REFramework", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /** Download the list again and rebuild this game's plan from it. */
  const retryWiki = async () => {
    setBusy(true);
    try {
      const result = await refreshWiki();
      await onReloadPlan();
      toaster.toast({
        title: result.count > 0 ? "Compatibility list downloaded" : "Still could not download it",
        body: result.count > 0
          ? `${result.count} entries.`
          : String(result.meta?.error ?? "The wiki could not be reached."),
      });
    } catch (exc) {
      toaster.toast({ title: "Still could not download it", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const reapply = async () => {
    if (!planned) return;
    if (requiredTargetMismatch) {
      toaster.toast({ title: "Choose the required game folder first", body: `PBZ needs the folder at ${requiredTarget ?? "PBZ/platform/steam"}.` });
      return;
    }
    setBusy(true);
    try {
      if (runtimeBlocked) throw new Error(plan?.blocked_reason ?? "This runtime cannot apply the wiki plan.");
      await beforeManagedMutation();
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      const folder = detail.path.split("/").filter(Boolean).pop() ?? detail.name;
      const result = await autoInstall(detail.target, detail.path, detail.name, [folder], launchAtInstall);
      if (result.ok) {
        toaster.toast({ title: "Set up again from the wiki", body: planned.game ?? detail.name });
        await onChanged();
        await onReloadPlan();
      } else {
        toaster.toast({ title: "Could not re-apply", body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: "Could not re-apply", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * What Steam is passing now, and what it was passing before the install.
   *
   * The pair is what makes the removal question answerable: with a record,
   * "put it back" is exact and "there were none" is a fact rather than a
   * guess; without one, only the override this plugin recognises comes out.
   */
  const launchState: LaunchState = {
    current: launchNow,
    recorded: recordedValue(detail.install.launch_record),
    filename: detail.install.filename ?? filename,
  };

  const doUninstall = async (
    action: LaunchAction,
    rememberIt: boolean,
    retry: RemoveRetry | null = null,
  ) => {
    setBusy(true);
    let previousValue: string | null = null;
    let desiredValue: string | null = null;
    let steamChanged = false;
    let filesRemoved = false;
    try {
      await onBeforeMutation?.();
      const current = appid ? await currentLaunchOptions(appid) : null;
      const chosen = retry
        ? retry.action === "clear" && launchState.recorded !== "" && current !== null
          ? { action: "clear" as const, value: hasOverride(current, launchState.filename)
              ? stripLaunchOptions(current, launchState.filename, [], [], launchState.recorded)
              : current }
          : { action: retry.action, value: retry.value }
        : appid
          ? launchChoices({ ...launchState, current }).find((choice) => choice.action === action)
          : undefined;
      if (appid && !chosen) {
        throw new Error("Steam launch options changed. Open Remove again and choose from the current value.");
      }
      const desired = chosen?.value ?? null;
      const previous = current;
      desiredValue = desired;
      previousValue = previous;
      if (appid && desired !== null) {
        if (current === null) {
          const pending = { action, value: desired, previous: null };
          setRemoveRetry(pending);
          setRemoveError("Steam's current value is unknown, so files were kept in place. Read it again, then retry removal.");
          toaster.toast({ title: "OptiScaler was not removed", body: "Steam's current launch options could not be read." });
          return;
        }
        if (current !== desired && !setLaunchOptions(Number(appid), desired)) {
          const pending = { action, value: desired, previous: current };
          setRemoveRetry(pending);
          setRemoveError("Steam rejected the launch-options change. OptiScaler is still installed and its original launch record is intact.");
          toaster.toast({ title: "OptiScaler was not removed", body: "Steam rejected the launch-options change. Retry from Setup." });
          return;
        }
        if (current !== desired) {
          steamChanged = true;
          launchRequest.current += 1;
          setLaunchNow(desired);
          setLaunchReadable(true);
        }
      }

      const result = await uninstall(detail.install.path, true);
      if (!result.ok) {
        let rollbackFailed = false;
        if (appid && desired !== null && previous !== null && desired !== previous) {
          rollbackFailed = !setLaunchOptions(Number(appid), previous);
          if (!rollbackFailed) {
            launchRequest.current += 1;
            setLaunchNow(previous);
            setLaunchReadable(true);
          }
        } else if (appid && desired !== null && previous === null) {
          rollbackFailed = true;
        }
        if (rollbackFailed && desired !== null) {
          const pending = { action, value: desired, previous };
          setRemoveRetry(pending);
          setRemoveError("File removal failed and Steam could not be restored to its previous value. Retry removal below; the saved launch record remains available.");
        } else {
          setRemoveRetry(null);
          setRemoveError(null);
        }
        toaster.toast({
          title: "Uninstall failed",
          body: rollbackFailed
            ? `${String(result.error)} Steam could not be put back; retry removal in Setup.`
            : `${String(result.error)} Steam was restored, and OptiScaler remains installed.`,
        });
        return;
      }

      filesRemoved = true;
      onRemoved?.();
      if (rememberIt) await remember(PREF_REMOVE_LAUNCH, action);
      setRemoveRetry(null);
      setRemoveError(null);
      toaster.toast({ title: "OptiScaler removed", body: detail.name });
      if (appid && desired !== null) {
        toaster.toast({
          title: desired === "" ? "Launch options cleared" : "Launch options restored",
          body: desired || detail.name,
        });
      }
      await onChanged();
    } catch (exc) {
      if (!filesRemoved && steamChanged && appid && desiredValue !== null) {
        const rollbackFailed = previousValue === null ||
          !setLaunchOptions(Number(appid), previousValue);
        if (rollbackFailed) {
          setRemoveRetry({ action, value: desiredValue, previous: previousValue });
          setRemoveError("Removal failed and Steam could not be restored to its previous value. Retry removal below; the saved launch record remains available.");
        } else {
          launchRequest.current += 1;
          setLaunchNow(previousValue);
          setLaunchReadable(true);
        }
      }
      toaster.toast({ title: filesRemoved ? "OptiScaler removed; refresh failed" : "Uninstall failed", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  const retryUninstall = () => {
    if (removeRetry) void doUninstall(removeRetry.action, false, removeRetry);
  };

  const confirmUninstall = async () => {
    // Both reads happen before the modal opens: it is a plain render of an
    // answer already known, so nothing on it can arrive after the user has
    // looked at it and moved on.
    const [rememberedAction, canRemember] = await Promise.all([
      recallLaunchAction(PREF_REMOVE_LAUNCH),
      isRemembering(),
    ]);
    const current = appid ? await currentLaunchOptions(appid) : null;
    if (appid) {
      setLaunchNow(current);
      setLaunchReadable(current !== null);
      setLaunchLoaded(true);
    }
    const freshLaunchState = { ...launchState, current };
    // A remembered answer is only honoured while it still applies to this game:
    // "put back what was there" means nothing for a game with no record, and a
    // game Steam does not own has no choices at all.
    const choices = appid ? launchChoices(freshLaunchState) : [];
    const applicable =
      resolveChoice(choices, rememberedAction)?.action === rememberedAction
        ? rememberedAction
        : null;
    showModal(
      <RemovePrompt
        gameName={detail.name}
        filename={detail.install.filename}
        backedUp={detail.install.backed_up.length}
        launch={appid ? freshLaunchState : null}
        remembered={applicable}
        canRemember={canRemember}
        onConfirm={(action, rememberIt) => void doUninstall(action, rememberIt)}
      />
    );
  };

  const doReset = async () => {
    if (!runtimeCurrent) {
      toaster.toast({ title: "Settings are read-only", body: "Upgrade the runtime in Setup first." });
      return;
    }
    setBusy(true);
    try {
      await onBeforeMutation?.();
      const result = await resetConfig(detail.install.path);
      if (result.ok) {
        await onResetConfig();
        toaster.toast({ title: "Config reset", body: "Stock OptiScaler.ini restored." });
      } else {
        toaster.toast({ title: "Reset failed", body: String(result.error) });
      }
    } finally {
      setBusy(false);
    }
  };

  // -- what the log row has to say -----------------------------------------
  const problems = report?.problems?.length ?? 0;
  const logSummary = !report?.log_present
    ? "No log yet. Turn logging on here and launch the game once."
    : problems > 0
      ? `${problems} warning${problems === 1 ? "" : "s"} or error${
          problems === 1 ? "" : "s"
        } in the log.`
      : "Nothing wrong in the log.";
  const logPill = !report?.log_present ? (
    <Pill>no log yet</Pill>
  ) : problems > 0 ? (
    <Pill color="#5a4a20">{problems}</Pill>
  ) : (
    <Pill color="#2f6b3f">no problems</Pill>
  );

  const foldRows = (
    <PanelSection>
      <PanelSectionRow>
        <Field
          label="Manual setup"
          description="File name, folder, OptiPatcher, FSR 4 files, launch options."
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
          label="Logs"
          // What the log says once there is one: that sentence used to be on
          // the "Not running" row, which was never a step of setting a game up.
          description={
            installed
              ? logSummary
              : "What OptiScaler loaded, the GPU it found, and any errors."
          }
          onClick={onLogs}
          onActivate={onLogs}
          focusable
          bottomSeparator="standard"
          childrenLayout="inline"
          childrenContainerWidth="min"
        >
          {installed ? logPill : <Pill>no log yet</Pill>}
        </Field>
      </PanelSectionRow>
    </PanelSection>
  );

  // -- not set up yet -------------------------------------------------------
  if (!installed) {
    // REFramework, when this game needs it, goes first: it is what OptiScaler
    // hooks into, so it is the step everything below depends on. It is not
    // offered as a toggle the way the launch options and the wiki's settings
    // are — those are choices, and "install OptiScaler in a configuration that
    // cannot work" is not one.
    const refStep = ref && ref.automatic ? 1 : 0;
    const steps = refStep + 1 +
      (planned && needsOverride && appid && withLaunch ? 1 : 0) +
      (planned && withSettings ? 1 : 0);
    /** Step numbers, so inserting one above does not renumber by hand. */
    let step = 0;
    const next = () => (step += 1);
    const runLabel = busy
      ? "Setting up…"
      : settling
        ? "Reading this game's entry…"
        : steps >= 4
          ? `Do all ${steps === 4 ? "four" : steps}`
          : steps === 3
            ? "Do all three"
            : steps === 2
              ? "Do both"
              : "Just install it";

    return (
      <>
        <PanelSection title={detail.name}>
          <PanelSectionRow>
            {loadingWiki ? (
              <Notice tone="info">Checking the OptiScaler wiki…</Notice>
            ) : planned && !runtimeBlocked ? (
              <Notice tone="success" title="This game can be set up automatically">
                Matched “{planned.game}” on the OptiScaler wiki
                {recommendation?.compatibility
                  ? ` — reported ${recommendation.compatibility}`
                  : ""}
                .
                {/* The list row answers on its own; this game's own wiki page
                    is being fetched behind it and fills the rest in. Said out
                    loud because the steps below can change when it lands —
                    but only while it is actually still being fetched. A page
                    the wiki will not serve stays pending for ever, and saying
                    "still reading" about it for ever is a lie the user cannot
                    act on. */}
                {settling
                  ? " Still reading this game's own entry — the steps below may fill in shortly."
                  : ""}
              </Notice>
            ) : planned ? (
              <Notice tone="error" title="Automatic setup is unavailable">
                {plan?.blocked_reason ?? "The bundled runtime does not meet this game's requirements."}
                {" You can continue with Manual setup."}
              </Notice>
            ) : (
              <WikiTrouble
                recommendation={recommendation}
                busy={busy}
                onRetry={() => void retryWiki()}
              />
            )}
          </PanelSectionRow>
          {(!planned || runtimeBlocked) && !loadingWiki ? (
            <PanelSectionRow>
              <Focusable style={{ display: "flex" }}>
                <DialogButton
                  onClick={onManual}
                  onOKActionDescription="Set this game up by hand"
                  style={{ flexGrow: 1 }}
                >
                  Manual setup
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          ) : null}
        </PanelSection>

        {planned ? (
          <PanelSection>
            {requiredTargetMismatch && requiredTarget ? (
              <PanelSectionRow>
                <Notice tone="error" title="Choose the required game folder before setup">
                  {installed
                    ? <>OptiScaler is currently in <Mono>{shorten(detail.install.path)}</Mono>, but this game needs <Mono>{expectedPbzTarget ? shorten(expectedPbzTarget) : requiredTarget}</Mono>. Remove the current install first, then choose the folder containing the main <Mono>PBZ.exe</Mono> in Manual setup.</>
                    : <>{detail.target_is_saved ? "The saved folder" : "The selected folder"} is <Mono>{shorten(detail.target)}</Mono>, but this game needs <Mono>{expectedPbzTarget ? shorten(expectedPbzTarget) : requiredTarget}</Mono>. Open Manual setup and choose the folder containing the main <Mono>PBZ.exe</Mono>.</>}
                  Automatic setup and launch changes are paused until the folder matches.
                </Notice>
              </PanelSectionRow>
            ) : null}
            {ref ? (
              <PanelSectionRow>
                <Field
                  label={
                    <StepLabel n={ref.automatic ? next() : undefined} done={refPresent}>
                      {refPresent ? "REFramework is already here" : "Install REFramework"}
                    </StepLabel>
                  }
                  description={
                    refPresent
                      ? `${detail.reframework?.dll ?? ref.dll} is next to the executable already.
                         The build this entry asks for goes in over it, and yours is set aside.`
                      : `OptiScaler cannot hook this game without it — the wiki says so under
                         “${ref.source}”. ${reframeworkSummary(ref)}`
                  }
                  bottomSeparator="standard"
                  childrenLayout="inline"
                  childrenContainerWidth="min"
                  focusable
                >
                  {ref.automatic ? (
                    <span style={{ fontSize: "11px", opacity: 0.5 }}>required</span>
                  ) : (
                    <Pill color="#5a4a20">you</Pill>
                  )}
                </Field>
              </PanelSectionRow>
            ) : null}

            {ref ? <PluginStep wanted={ref} present={pluginPresent} /> : null}

            <PanelSectionRow>
              <Field
                label={<StepLabel n={next()}>Install OptiScaler as <Mono>{planned.filename}</Mono></StepLabel>}
                description={`Into ${shorten(detail.target)}, next to the executable that renders the game.`}
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
              >
                <span style={{ fontSize: "11px", opacity: 0.5 }}>required</span>
              </Field>
            </PanelSectionRow>

            {needsOverride && appid ? (
              <PanelSectionRow>
                <ToggleField
                  label={<StepLabel n={next()}>Set the Steam launch options</StepLabel>}
                  description={
                    ref
                      ? `${launchPreview} — without it Proton loads its own
                         ${planned.filename} and its own ${ref.dll}, and neither mod runs.`
                      : `${launchPreview} — without it Proton loads its own ${planned.filename}.`
                  }
                  checked={withLaunch}
                  disabled={busy || runtimeBlocked || requiredTargetMismatch}
                  bottomSeparator="standard"
                  onChange={setWithLaunch}
                />
              </PanelSectionRow>
            ) : null}

            {!appid && needsOverride ? (
              <PanelSectionRow>
                <Notice tone="warn" title="Set the launch options yourself">
                  This game came from a custom folder rather than Steam, so nothing here can set
                  them. Add <Mono>{launchWanted}</Mono> in whichever launcher starts it.
                </Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel n={next()}>
                    {planned.settings.length > 0
                      ? `Apply the ${planned.settings.length} setting${
                          planned.settings.length === 1 ? "" : "s"
                        } the entry asks for`
                      : "Follow this game's wiki entry"}
                  </StepLabel>
                }
                description={
                  settingsSummary(planned) ||
                  "This entry needs no special settings. It applies during setup, when enabling Automatic, or when re-applying; changes are not written continuously."
                }
                checked={withSettings}
                disabled={busy || runtimeBlocked || requiredTargetMismatch}
                bottomSeparator="standard"
                onChange={setWithSettings}
              />
            </PanelSectionRow>

            {planned && withSettings ? <HotkeyNote plan={planned} /> : null}

            {!detail.writable ? (
              <PanelSectionRow>
                <Notice tone="error" title="Folder is not writable">
                  <Mono>{shorten(detail.target)}</Mono>
                </Notice>
              </PanelSectionRow>
            ) : null}

            <PanelSectionRow>
              <Focusable style={{ display: "flex" }}>
                <DialogButton
                  disabled={busy || settling || runtimeBlocked || !detail.writable ||
                    requiredTargetMismatch ||
                    (withLaunch && Boolean(appid) && needsOverride && !launchReadable)}
                  onClick={() => void run()}
                  onOKActionDescription="Set this game up"
                  style={{ flexGrow: 1 }}
                >
                  {runLabel}
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          </PanelSection>
        ) : null}

        {planned ? <PlanRequirements plan={planned} recommendation={recommendation} /> : null}

        {needsOverride && appid && withLaunch && !launchReadable ? (
          <PanelSection>
            <PanelSectionRow>
              <Notice tone={launchLoaded ? "error" : "info"} title="Read Steam launch options before setup">
                {launchLoaded
                  ? "Steam did not report this game's current value. Setup will not replace it blindly."
                  : "Waiting for Steam to report the current value."}
              </Notice>
            </PanelSectionRow>
            {launchLoaded ? (
              <PanelSectionRow>
                <Focusable style={{ display: "flex" }}>
                  <DialogButton
                    disabled={busy}
                    onClick={() => void refreshLaunch()}
                    onOKActionDescription="Read Steam launch options again"
                    style={{ flexGrow: 1 }}
                  >
                    Read again
                  </DialogButton>
                </Focusable>
              </PanelSectionRow>
            ) : null}
          </PanelSection>
        ) : null}

        {foldRows}

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

  // -- already set up -------------------------------------------------------
  const backedUp = detail.install.backed_up.length;
  return (
    <>
      <PanelSection title={detail.name}>
        <PanelSectionRow>
          <Field
            label={<StepLabel done>Installed as <Mono>{detail.install.filename}</Mono></StepLabel>}
            description={[
              detail.install.version ?? "unknown build",
              backedUp > 0 ? `${backedUp} file${backedUp === 1 ? "" : "s"} set aside` : null,
              detail.install.managed ? "managed by this plugin" : "installed externally",
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
            <Pill>change</Pill>
          </Field>
        </PanelSectionRow>

        {requiredTargetMismatch && requiredTarget ? (
          <PanelSectionRow>
            <Notice tone="error" title="This install is in the wrong game folder">
              OptiScaler is in <Mono>{shorten(detail.install.path)}</Mono>, but Phantom Blade Zero needs <Mono>{expectedPbzTarget ? shorten(expectedPbzTarget) : requiredTarget}</Mono>. Remove this install first, then choose the folder containing the main <Mono>PBZ.exe</Mono> in Manual setup. Automatic settings and launch changes are paused until then.
            </Notice>
          </PanelSectionRow>
        ) : null}

        {needsOverride && appid ? (
          launchReadable ? (
            <PanelSectionRow>
              <ToggleField
                label={
                  <StepLabel done={overrideSet}>
                    {overrideSet ? "Launch options set" : "Launch options not set"}
                  </StepLabel>
                }
                description={
                  overrideSet
                    ? launchNow ?? launchWanted
                    : `Without ${launchPreview} Proton loads its own ${detail.install.filename}.`
                }
                checked={overrideSet}
                disabled={busy || requiredTargetMismatch}
                bottomSeparator="standard"
                onChange={(checked) => void applyLaunchOptions(checked)}
              />
            </PanelSectionRow>
          ) : (
            <PanelSectionRow>
              <Notice tone="error" title="Steam launch options could not be read">
                The current value is unknown, so it was left unchanged. Retry the read before
                adding or removing the OptiScaler override.
                {" "}
                <Focusable style={{ display: "flex", marginTop: "6px" }}>
                  <DialogButton
                    disabled={busy}
                    onClick={() => void refreshLaunch()}
                    onOKActionDescription="Read Steam launch options again"
                    style={{ flexGrow: 1 }}
                  >
                    Read again
                  </DialogButton>
                </Focusable>
              </Notice>
            </PanelSectionRow>
          )
        ) : null}

        {/* Only for the games whose entry asks for it. For everything else
            there is no such thing as REFramework being missing, and a row
            saying so would be a permanent unticked step on every game in the
            library. */}
        {ref ? (
          <>
            {/* A toggle rather than a tick, and this is the one place the
                "not a choice" reasoning was wrong. REFramework is required for
                the game to work — but it is also a third-party DLL that can
                stop the game booting, and when that happens the only way to
                find out which of the two mods did it is to remove one. An
                install with no way to bisect it is a bug report nobody can
                answer. */}
            {ref.automatic || refPresent ? (
              <PanelSectionRow>
                <ToggleField
                  label={
                    <StepLabel done={refPresent}>
                      {refPresent ? "REFramework installed" : "REFramework is missing"}
                    </StepLabel>
                  }
                  description={
                    refPresent
                      ? [
                          detail.reframework?.revision
                            ? `Build ${detail.reframework.revision.slice(0, 12)}`
                            : ref.variant === "pd-upscaler"
                              ? "pd-upscaler build"
                              : "nightly build",
                          detail.install.reframework?.managed
                            ? "installed by this plugin"
                            : "already in the folder",
                          "turn off if the game stops launching",
                        ].join(" · ")
                      : `Without it OptiScaler loads and changes nothing on screen — this game's
                         entry says so under “${ref.source}”. ${reframeworkSummary(ref)}`
                  }
                  checked={refPresent}
                  disabled={busy}
                  bottomSeparator="standard"
                  onChange={(checked) =>
                    void (checked ? addReframework() : dropReframework())}
                />
              </PanelSectionRow>
            ) : (
              <PanelSectionRow>
                <Field
                  label={<StepLabel done={refPresent}>REFramework is missing</StepLabel>}
                  description={`Without it OptiScaler loads and changes nothing on screen —
                    this game's entry says so under “${ref.source}”. ${reframeworkSummary(ref)}`}
                  focusable
                  bottomSeparator="standard"
                  childrenLayout="inline"
                  childrenContainerWidth="min"
                >
                  <Pill color="#5a4a20">you</Pill>
                </Field>
              </PanelSectionRow>
            )}
            <PluginStep wanted={ref} present={pluginPresent} />
          </>
        ) : null}

        {planned && auto ? <HotkeyNote plan={planned} /> : null}

        {!planned && !loadingWiki ? (
          recommendation && !recommendation.list_available ? (
            // Same distinction as before the install: a list that would not
            // download is a fault, not a verdict on this game.
            <PanelSectionRow>
              <WikiTrouble
                recommendation={recommendation}
                busy={busy}
                onRetry={() => void retryWiki()}
              />
            </PanelSectionRow>
          ) : (
            <PanelSectionRow>
              <Field
                label={<StepLabel>No wiki entry matched this game</StepLabel>}
                description="Nothing is being kept up to date for it. Pick an entry yourself under “Manual setup”, or leave the settings to you."
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
                    ? "Applying wiki settings…"
                    : auto
                      ? "Using the wiki entry's settings"
                      : "Not using the wiki entry's settings"}
                </StepLabel>
              }
              description={
                !runtimeCurrent
                  ? "Upgrade the runtime in Setup before applying automatic settings."
                  : auto
                    ? `${settingsSummary(planned) || "No special settings"} — applied during setup, when enabled, or when re-applied. Wiki changes are not written continuously.`
                    : "Every option is yours. Turn this on to apply the wiki settings once; re-apply when you want to take a newer entry."
              }
              checked={auto}
              disabled={busy || autoBusy || runtimeBlocked || !runtimeCurrent || requiredTargetMismatch}
              bottomSeparator="standard"
              onChange={(checked) => void onSetAuto(checked)}
            />
          </PanelSectionRow>
        ) : null}

        {/* Only while this game is up. "Not running" was being listed as the
            last step of setting a game up, which it never was: nothing about it
            is a step, and a game sitting in the library is not half-configured
            for being closed. What the log had to say is one row down, under
            Logs, where it belongs whether or not the game is running. */}
        {running ? (
          <PanelSectionRow>
            <Field
              label={
                <StepLabel done={liveStatusMessage(live).ready}>
                  {liveStatusMessage(live).ready ? "Running now" : "Running, without live control"}
                </StepLabel>
              }
              description={
                liveStatusMessage(live).ready
                  ? `Live control connected with verified capabilities. ${logSummary}`
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

      {planned ? <PlanRequirements plan={planned} recommendation={recommendation} /> : null}

      {onRestore && detail.install.rollback?.available ? (
        <PanelSection title="Recovery">
          <PanelSectionRow>
            <Notice tone="info" title="Previous install preserved">
              {detail.install.rollback.version
                ? `Saved before upgrading from OptiScaler ${detail.install.rollback.version}. `
                : "Saved before the managed runtime change. "}
              This restore point remains available until you remove OptiScaler.
              {!runtimeCurrent
                ? " The installed runtime is older or unknown; settings stay read-only until you upgrade again."
                : ""} This can only restore files captured at the upgrade; it cannot recreate an original INI lost before then.
            </Notice>
          </PanelSectionRow>
          {restoreError ? (
            <PanelSectionRow>
              <Notice tone="error" title="Steam launch options still need attention">
                {restoreError}
                {appid && canRetryRestoreLaunchOptions && onRetryRestoreLaunchOptions ? (
                  <Focusable style={{ display: "flex", marginTop: "6px" }}>
                    <DialogButton
                      disabled={restoreBusy}
                      onClick={onRetryRestoreLaunchOptions}
                      onOKActionDescription="Retry restoring Steam launch options"
                      style={{ flexGrow: 1 }}
                    >
                      Retry launch options
                    </DialogButton>
                  </Focusable>
                ) : null}
              </Notice>
            </PanelSectionRow>
          ) : null}
          {!restoreError && appid && canRetryRestoreLaunchOptions && onRetryRestoreLaunchOptions ? (
            <PanelSectionRow>
              <Notice tone="warn" title="The restore point still has saved Steam launch options">
                If Steam did not accept them after the file restore, you can retry here.
                <Focusable style={{ display: "flex", marginTop: "6px" }}>
                  <DialogButton
                    disabled={restoreBusy}
                    onClick={onRetryRestoreLaunchOptions}
                    onOKActionDescription="Apply the launch options saved in the restore point"
                    style={{ flexGrow: 1 }}
                  >
                    Apply saved launch options
                  </DialogButton>
                </Focusable>
              </Notice>
            </PanelSectionRow>
          ) : null}
          <PanelSectionRow>
            <Focusable style={{ display: "flex" }}>
              <DialogButton
                disabled={busy || restoreBusy || running}
                onClick={() => void onRestore()}
                onOKActionDescription="Restore the previous OptiScaler install"
                style={{ flexGrow: 1 }}
              >
                {restoreBusy ? "Restoring previous install…" : "Restore previous install"}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          {running ? (
            <PanelSectionRow>
              <Notice tone="warn">Close the game before restoring files.</Notice>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      ) : null}

      {foldRows}

      {removeError && removeRetry ? (
        <PanelSection title="Removal needs a retry">
          <PanelSectionRow>
            <Notice tone="error" title="OptiScaler is still installed">
              {removeError}
              <Focusable style={{ display: "flex", marginTop: "6px" }}>
                <DialogButton
                  disabled={busy}
                  onClick={retryUninstall}
                  onOKActionDescription="Retry the Steam update and remove OptiScaler"
                  style={{ flexGrow: 1 }}
                >
                  Retry Steam update and removal
                </DialogButton>
              </Focusable>
            </Notice>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection>
        <PanelSectionRow>
          {/* One row rather than three stacked buttons: on a handheld the
              things you rarely do should not each cost a screenful, and
              removing has to stay reachable without hunting for it. */}
          <Focusable style={{ display: "flex", gap: "8px" }} flow-children="horizontal">
            {planned ? (
              <DialogButton
              disabled={busy || runtimeBlocked || requiredTargetMismatch}
                onClick={() => void reapply()}
                onOKActionDescription={runtimeCurrent
                  ? "Set up again from the wiki"
                  : "Upgrade the OptiScaler runtime and apply the wiki settings"}
                style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
              >
                {runtimeCurrent ? "Set up again" : "Upgrade runtime and re-apply"}
              </DialogButton>
            ) : null}
            <DialogButton
              disabled={busy || !runtimeCurrent}
              onClick={() => void doReset()}
              onOKActionDescription="Reset settings to stock"
              style={{ flex: "1 1 0", minWidth: 0, fontSize: "13px", padding: "8px 6px" }}
            >
              Reset settings
            </DialogButton>
            <DialogButton
              disabled={busy}
              onClick={() => void confirmUninstall()}
              onOKActionDescription="Remove OptiScaler"
              style={{
                flex: "1 1 0",
                minWidth: 0,
                fontSize: "13px",
                padding: "8px 6px",
                color: "#ff9d9d",
              }}
            >
              Remove
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable
            focusWithinClassName="gpfocuswithin"
            style={{ fontSize: "12px", opacity: 0.6, padding: "4px 0", lineHeight: 1.45 }}
          >
            {backedUp > 0
              ? `Removing puts back the ${backedUp} file${backedUp === 1 ? "" : "s"} it set aside.`
              : "Removing takes every file it installed back out."}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
