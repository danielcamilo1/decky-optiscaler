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
import { install, setWikiEntry } from "../api";
import { setLaunchOptions } from "../hooks/useRunningGame";
import {
  currentLaunchOptions,
  launchOptionFor,
  mergeLaunchOptions,
  preserveExistingInstall,
  recordPreviousLaunchOptions,
} from "../launchOptions";
import { PREF_INSTALL_LAUNCH, isRemembering, recall, remember } from "../prefs";
import { useAutoPlan } from "../hooks/useAutoPlan";
import type { GameDetail, LiveStatus, PayloadStatus } from "../types";
import { KeyValue, Mono, Notice, Pill } from "./Common";
import { Fsr4Panel } from "./Fsr4Panel";
import { LivePanel } from "./LivePanel";
import { OptipatcherPanel } from "./OptipatcherPanel";
import { WikiSearch } from "./WikiSearch";

interface Props {
  detail: GameDetail;
  status: PayloadStatus | null;
  appid: string | null;
  live: LiveStatus | null;
  running: boolean;
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
  canRemember,
  closeModal,
  onDecide,
}: Readonly<{
  filename: string;
  launchOption: string;
  /** False once the user has turned remembering off under Settings. */
  canRemember: boolean;
  closeModal?: () => void;
  onDecide: (apply: boolean, remember: boolean) => void;
}>) {
  const [rememberIt, setRememberIt] = useState(false);
  return (
    <ConfirmModal
      strTitle="Set the Steam launch options?"
      strOKButtonText="Set them for me"
      strCancelButtonText="Not now"
      closeModal={closeModal}
      onOK={() => onDecide(true, rememberIt)}
      onCancel={() => onDecide(false, rememberIt)}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        Proton loads its own <Mono>{filename}</Mono> unless this override is set. The preview
        merges it with the launch options already in Steam:
        <div style={{ margin: "8px 0" }}>
          <Mono>{launchOption}</Mono>
        </div>
      </div>
      {canRemember ? (
        <ToggleField
          label="Remember my choice"
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
export function InstallPanel({ detail, status, appid, live, running, onBeforeMutation, onChanged }: Props) {
  const [filename, setFilename] = useState(detail.install.filename ?? "dxgi.dll");
  const [target, setTarget] = useState(detail.target);
  const [preserveIni, setPreserveIni] = useState(false);
  const [optipatcher, setOptipatcher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  /**
   * What Steam is passing right now, or null when no source could say.
   *
   * Stated on the page rather than only used: when the launch options are the
   * half of an install that is not working, "the plugin cannot read them" and
   * "they are empty" look identical from the outside, and telling them apart
   * took a source-code read the last time it mattered.
   */
  const [launchNow, setLaunchNow] = useState<string | null>(null);
  const [launchRead, setLaunchRead] = useState(false);
  const launchRequest = useRef(0);
  const activeAppid = useRef(appid);
  activeAppid.current = appid;
  const proxies = status?.proxy_filenames ?? ["dxgi.dll"];
  const runtimeCurrent = detail.install.managed && detail.install.runtime_current === true;
  const {
    plan,
    recommendation,
    loading: loadingWiki,
    reload: lookup,
  } = useAutoPlan(detail.path, detail.name);

  const targetRequirement = plan?.required_target ?? (hasPbzIdentity(detail) ? "PBZ/platform/steam" : null);
  const inspectedTarget = detail.install.installed ? detail.install.path : target;
  const requiredTargetMismatch = pbzTargetMismatch(detail, Boolean(targetRequirement), inspectedTarget);
  const targetWritable = detail.candidates.find((candidate) => normalizeGamePath(candidate.path) === normalizeGamePath(target))?.writable
    ?? (normalizeGamePath(target) === normalizeGamePath(detail.target) && detail.writable);

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
      const value = await currentLaunchOptions(appid);
      if (activeAppid.current !== appid || launchRequest.current !== request) return;
      setLaunchNow(value);
      setLaunchRead(true);
    } catch {
      if (activeAppid.current === appid && launchRequest.current === request) {
        setLaunchNow(null);
        setLaunchRead(true);
      }
    }
  }, [appid]);

  useEffect(() => {
    void refreshLaunchOptions();
  }, [refreshLaunchOptions, detail.install.installed]);

  // An .asi build is loaded by an ASI loader, so Proton has nothing to shadow.
  const needsNoOverride = filename.toLowerCase().endsWith(".asi");
  const launchReadRequired = Boolean(
    appid && (detail.install.installed ||
      (!detail.install.installed && !needsNoOverride)),
  );
  const launchUnavailable = launchReadRequired && (!launchRead || launchNow === null);
  const plannedFlags = plan?.launch_flags ?? [];
  const extraOverrides = plan?.reframework?.override ? [plan.reframework.override] : [];
  const launchOption = launchNow === null
    ? launchOptionFor(filename)
    : mergeLaunchOptions(launchNow, filename, plannedFlags, extraOverrides) ??
      `Manual merge required. Add this override to your existing launch options: ${launchOptionFor(filename)}`;

  const beforeManagedMutation = async () => {
    await onBeforeMutation?.();
    if (!detail.install.installed) return;
    const preserved = await preserveExistingInstall(detail.install.path, detail.path, appid);
    if (!preserved.ok) {
      throw new Error(preserved.error ?? "Could not preserve the current install.");
    }
  };

  const doInstall = async () => {
    setBusy(true);
    try {
      if (requiredTargetMismatch) throw new Error("Choose the main PBZ.exe folder at PBZ/platform/steam first.");
      if (!targetWritable) throw new Error("The chosen install folder is not writable.");
      await beforeManagedMutation();
      const launchAtInstall = appid ? await currentLaunchOptions(appid) : null;
      if (!detail.install.installed && appid && !needsNoOverride) {
        if (launchAtInstall === null) {
          throw new Error("Steam launch options could not be read. The install was left unchanged.");
        }
      }
      if (appid && launchAtInstall !== null) {
        setLaunchNow(launchAtInstall);
        setLaunchRead(true);
      }
      const firstInstall = !detail.install.installed;
      const result = await install(
        target,
        filename,
        firstInstall ? preserveIni : true,
        optipatcher,
        detail.path,
        launchAtInstall,
        false,
      );
      if (result.ok) {
        toaster.toast({
          title: "OptiScaler installed",
          body: `${filename} in ${target.split("/").slice(-2).join("/")}`,
        });
        await onChanged();
        await offerLaunchOptions(true);
      } else {
        toaster.toast({ title: "Install failed", body: String(result.error) });
      }
    } catch (exc) {
      toaster.toast({ title: "Install failed", body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * The one thing an install cannot do for itself without being asked.
   * Answered already? Honour that answer and say nothing.
   */
  const offerLaunchOptions = async (justInstalled = false) => {
    if (!appid || needsNoOverride) return;
    const latest = await currentLaunchOptions(appid);
    if (latest !== null) {
      setLaunchNow(latest);
      setLaunchRead(true);
    }
    const preview = latest === null
      ? launchOptionFor(filename)
      : mergeLaunchOptions(latest, filename, plannedFlags, extraOverrides) ??
        `Manual merge required. Add this override to your existing launch options: ${launchOptionFor(filename)}`;
    const remembered = await recall(PREF_INSTALL_LAUNCH);
    if (remembered === "never") return;
    if (remembered === "always") {
      void applyLaunchOptions(justInstalled ? target : undefined);
      return;
    }
    const canRemember = await isRemembering();
    showModal(
      <LaunchOptionsPrompt
        filename={filename}
        launchOption={preview}
        canRemember={canRemember}
        onDecide={(apply, rememberIt) => {
          if (rememberIt) void remember(PREF_INSTALL_LAUNCH, apply ? "always" : "never");
          if (apply) void applyLaunchOptions(justInstalled ? target : undefined);
        }}
      />
    );
  };

  const applyLaunchOptions = async (confirmedTarget?: string) => {
    if (requiredTargetMismatch || (!detail.install.managed && !confirmedTarget)) return false;
    if (!appid) {
      toaster.toast({
        title: "Could not read Steam launch options",
        body: "The current value is unknown, so it was left unchanged.",
      });
      return false;
    }
    let latest = await currentLaunchOptions(appid);
    if (latest === null) {
      toaster.toast({
        title: "Could not read Steam launch options",
        body: "The current value is unknown, so it was left unchanged.",
      });
      return false;
    }
    if (detail.install.installed || confirmedTarget) {
      const recorded = await recordPreviousLaunchOptions(appid, confirmedTarget ?? detail.install.path);
      if (!recorded) {
        toaster.toast({ title: "Could not preserve launch options", body: "Steam was not changed." });
        return false;
      }
      latest = await currentLaunchOptions(appid);
      if (latest === null) {
        toaster.toast({ title: "Could not read Steam launch options", body: "Steam was left unchanged." });
        return false;
      }
    }
    const value = mergeLaunchOptions(latest, filename, plannedFlags, extraOverrides);
    if (value === null) {
      toaster.toast({ title: "Merge launch options manually", body: `Steam was left unchanged because its shell syntax cannot be merged safely. Required override: ${launchOptionFor(filename)}` });
      return false;
    }
    if (setLaunchOptions(Number(appid), value)) {
      // Ignore a read started before Steam accepted this value; on some client
      // builds its config-file fallback may still contain the previous value.
      launchRequest.current += 1;
      setLaunchNow(value);
      setLaunchRead(true);
      toaster.toast({ title: "Launch options updated", body: value });
      return true;
    } else {
      toaster.toast({ title: "Could not set launch options", body: "Set them manually in Steam." });
      return false;
    }
  };

  return (
    <>
      <PanelSection title="Compatibility">
        <PanelSectionRow>
          {loadingWiki ? (
            <Notice tone="info">Checking the OptiScaler wiki…</Notice>
          ) : recommendation?.matched ? (
            <div style={{ padding: "2px 0" }}>
              <div style={{ marginBottom: "6px" }}>
                <Pill color="#3a6ea5">{recommendation.compatibility ?? "?"}</Pill>
                <Pill>{recommendation.game}</Pill>
                {recommendation.optipatcher ? <Pill color="#5b4a85">OptiPatcher</Pill> : null}
              </div>
              <KeyValue
                label="Recommended file"
                value={<Mono>{recommendation.filename}</Mono>}
              />
              <KeyValue label="Source" value={recommendation.filename_source} />
              {recommendation.alternatives.length > 0 ? (
                <KeyValue
                  label="Also reported"
                  value={recommendation.alternatives.join(", ")}
                />
              ) : null}
              {recommendation.inputs ? (
                <KeyValue label="Upscaler inputs" value={recommendation.inputs} />
              ) : null}
              {recommendation.detail?.["FG Inputs"] ? (
                <KeyValue label="FG inputs" value={recommendation.detail["FG Inputs"]} />
              ) : null}
              {recommendation.notes ? (
                <Notice tone="info" title="Notes">
                  {stripMarkdown(recommendation.notes)}
                </Notice>
              ) : null}
              {recommendation.detail?.Notes && recommendation.detail.Notes !== "-" ? (
                <Notice tone="info" title="Wiki notes">
                  {stripMarkdown(recommendation.detail.Notes)}
                </Notice>
              ) : null}
              {recommendation.detail?.["Known Issues"] &&
              recommendation.detail["Known Issues"] !== "-" ? (
                <Notice tone="warn" title="Known issues">
                  {stripMarkdown(recommendation.detail["Known Issues"])}
                </Notice>
              ) : null}
            </div>
          ) : recommendation && !recommendation.list_available ? (
            <Notice tone="error" title="Could not load the compatibility list">
              {recommendation.list_meta?.error ?? "The wiki could not be reached."} Check the
              network and use “Refresh from wiki”.
            </Notice>
          ) : (
            <Notice tone="warn" title="No entry matched automatically">
              Searched {(recommendation?.searched ?? []).map((n) => `“${n}”`).join(" and ")}{" "}
              against {recommendation?.entry_count ?? 0} entries. Pick the game by hand below —
              OptiScaler still works with most DLSS/FSR2+/XeSS games, and <Mono>dxgi.dll</Mono>{" "}
              is the usual choice.
            </Notice>
          )}
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={loadingWiki} onClick={() => void lookup(true)}>
            Refresh from wiki
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setSearching((value) => !value)}>
            {searching ? "Hide search" : "Find this game in the list myself"}
          </ButtonItem>
        </PanelSectionRow>
        {searching ? (
          <WikiSearch
            initialQuery={detail.name}
            current={detail.wiki_entry}
            onPick={async (entryName) => {
              try {
                const result = await setWikiEntry(detail.path, entryName);
                if (!result.ok) throw new Error(result.error ?? "Could not save the wiki entry.");
                setSearching(false);
                await onChanged();
                await lookup(false);
                toaster.toast({ title: "Compatibility entry set", body: entryName });
              } catch (exc) {
                toaster.toast({ title: "Could not save compatibility entry", body: String(exc) });
              }
            }}
          />
        ) : null}
      </PanelSection>

      <PanelSection title={detail.install.installed ? "Installation" : "Install OptiScaler"}>
      {detail.install.installed && !runtimeCurrent ? (
          <PanelSectionRow>
            <Notice tone="warn" title="Runtime settings are read-only">
              Upgrade the OptiScaler runtime in Setup before changing config or FSR files.
            </Notice>
          </PanelSectionRow>
        ) : null}
        {requiredTargetMismatch && targetRequirement ? (
          <PanelSectionRow>
            <Notice tone="error" title="This game needs a different install folder">
              {detail.install.installed
                ? <>OptiScaler is installed in <Mono>{shorten(detail.install.path)}</Mono>, but this game requires <Mono>{targetRequirement}</Mono>. Remove this install first, then choose the folder containing the main <Mono>PBZ.exe</Mono> in Manual setup.</>
                : <>The selected folder is <Mono>{shorten(target)}</Mono>, but this game requires <Mono>{targetRequirement}</Mono>. Choose the folder containing the main <Mono>PBZ.exe</Mono> in Manual setup before installing.</>}
            </Notice>
          </PanelSectionRow>
        ) : null}
        {detail.install.installed ? (
          <PanelSectionRow>
            <div style={{ padding: "2px 0" }}>
              <KeyValue label="Installed as" value={<Mono>{detail.install.filename}</Mono>} />
              <KeyValue label="Version" value={detail.install.version ?? "unknown build"} />
              <KeyValue
                label="Managed by"
                value={detail.install.managed ? "this plugin" : "installed externally"}
              />
              <KeyValue label="Folder" value={<Mono>{shorten(detail.install.path)}</Mono>} />
              {detail.install.backed_up.length > 0 ? (
                <KeyValue
                  label="Files set aside"
                  value={`${detail.install.backed_up.length} in ${detail.install.backup_dir
                    .split("/")
                    .pop()}/`}
                />
              ) : null}
              {detail.install.extra_proxies.length > 0 ? (
                <Notice tone="warn" title="Duplicate OptiScaler copies">
                  Also found {detail.install.extra_proxies.join(", ")} in this folder. Loading
                  OptiScaler twice can crash the game — reinstall to clean them up.
                </Notice>
              ) : null}
            </div>
          </PanelSectionRow>
        ) : null}

        {detail.candidates.length > 1 || (detail.candidates.length === 1 && detail.candidates[0].path !== target) ? (
          <PanelSectionRow>
            <DropdownItem
              label="Install location"
              description="OptiScaler must sit next to the executable that renders the game."
              disabled={busy || detail.install.installed}
              bottomSeparator="standard"
              rgOptions={detail.candidates.map((candidate) => ({
                data: candidate.path,
                label: `${candidate.relative === "." ? "game root" : candidate.relative} (${
                  candidate.executables[0] ?? "no exe"
                })`,
              }))}
              selectedOption={target}
              onChange={(selected) => setTarget(String(selected.data))}
            />
          </PanelSectionRow>
        ) : null}

        <PanelSectionRow>
          <DropdownItem
            label="Filename override"
            description="OptiScaler is installed under this name so the game loads it."
            disabled={busy}
            bottomSeparator="standard"
            rgOptions={proxies.map((name) => ({
              data: name,
              label:
                recommendation?.matched && name === recommendation.filename
                  ? `${name} — recommended`
                  : name,
            }))}
            selectedOption={filename}
            onChange={(selected) => setFilename(String(selected.data))}
          />
        </PanelSectionRow>

        {detail.ini_info?.legacy ? (
          <PanelSectionRow>
            <Notice tone="warn" title="Existing config looks out of date">
              The OptiScaler.ini already here still uses the old <Mono>FGType</Mono> key. An
              upgrade preserves the file and comments while migrating supported values.
            </Notice>
          </PanelSectionRow>
        ) : null}

        {detail.install.installed ? null : (
          <PanelSectionRow>
            <ToggleField
              label="Also install OptiPatcher"
              description={
                "Patches supported games so OptiScaler sees their DLSS and DLSS-FG inputs " +
                "without spoofing the GPU. Red Dead Redemption 2 is one of the games that " +
                "needs it. Harmless on games it has no patterns for."
              }
              checked={optipatcher}
              disabled={busy}
              bottomSeparator="standard"
              onChange={setOptipatcher}
            />
          </PanelSectionRow>
        )}

        {detail.install.installed ? (
          <PanelSectionRow>
            <Notice tone="info" title="Existing settings are preserved">
              Upgrades keep the current OptiScaler.ini and migrate supported settings.
            </Notice>
          </PanelSectionRow>
        ) : null}

        {detail.install.installed ? null : (
          <PanelSectionRow>
            <ToggleField
              label="Keep existing OptiScaler.ini"
              description="Preserve settings from a previous install instead of writing a fresh config."
              checked={preserveIni}
              disabled={busy}
              bottomSeparator="standard"
              onChange={setPreserveIni}
            />
          </PanelSectionRow>
        )}

        {!detail.install.installed ? (
          <PanelSectionRow>
            <Notice tone="info" title="Nothing gets lost">
              Any file OptiScaler would overwrite — including DLLs the game ships itself — is
              moved into <Mono>decky_optiscaler_backup_files/</Mono> and put back when you
              uninstall.
            </Notice>
          </PanelSectionRow>
        ) : null}

        {!targetWritable ? (
          <PanelSectionRow>
            <Notice tone="error" title="Folder is not writable">
              <Mono>{shorten(target)}</Mono>
            </Notice>
          </PanelSectionRow>
        ) : null}

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy || !targetWritable || launchUnavailable || requiredTargetMismatch}
            onClick={doInstall}
          >
            {busy
              ? "Working…"
              : detail.install.installed
                ? !runtimeCurrent
                  ? `Upgrade runtime as ${filename}`
                  : detail.install.filename === filename
                    ? `Reinstall as ${filename}`
                    : `Switch to ${filename}`
                : `Install as ${filename}`}
          </ButtonItem>
        </PanelSectionRow>

      </PanelSection>

      {detail.install.installed ? (
        <Fsr4Panel
          targetDir={detail.install.path}
          sources={detail.fsr4_sources ?? []}
          gpu={detail.gpu}
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
          onBeforeMutation={beforeManagedMutation}
          onChanged={onChanged}
        />
      ) : null}

      <PanelSection title="Steam Launch Options">
        <PanelSectionRow>
          <Notice tone={needsNoOverride ? "info" : "warn"}>
            {needsNoOverride ? (
              <>An <Mono>.asi</Mono> build is loaded by an ASI loader and needs no override.</>
            ) : (
              <>
                Proton will load its own <Mono>{filename}</Mono> unless you add this override:
                <div style={{ marginTop: "6px" }}>
                  <Mono>{launchOption}</Mono>
                </div>
                {launchNow === null && appid ? (
                  <div style={{ marginTop: "6px", opacity: 0.8 }}>
                    Steam's current value is unknown, so this is only the plugin's requested addition.
                    It will not overwrite the field until Steam's existing options can be read.
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
                label="Steam is passing"
                value={
                  !launchRead ? (
                    "reading…"
                  ) : launchNow === null ? (
                    "Steam would not say"
                  ) : launchNow === "" ? (
                    "nothing"
                  ) : (
                    <Mono>{launchNow}</Mono>
                  )
                }
              />
              {/* What removing OptiScaler would be able to put back. Absent on
                  installs made before this was recorded, and on games where no
                  source could read the field at the time. */}
              <KeyValue
                label="Before the install"
                value={
                  !detail.install.installed
                    ? "—"
                    : detail.install.launch_record?.recorded
                      ? detail.install.launch_record.value
                        ? <Mono>{detail.install.launch_record.value}</Mono>
                        : "nothing"
                      : "not recorded"
                }
              />
            </Focusable>
          </PanelSectionRow>
        ) : null}
        {appid && detail.install.installed && !needsNoOverride ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy || !detail.install.managed || !launchRead || launchNow === null || requiredTargetMismatch}
              onClick={() => void applyLaunchOptions()}
            >
              Set launch options for me
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        {appid && launchRead && launchNow === null ? (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void refreshLaunchOptions()}>
              Retry reading Steam launch options
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        {!appid ? (
          <PanelSectionRow>
            <Focusable style={{ fontSize: "12px", opacity: 0.7, padding: "4px 0" }}>
              This game came from a custom folder, so add the override yourself in whichever
              launcher starts it.
            </Focusable>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    </>
  );
}

function shorten(path: string, keep = 3) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}



/** The wiki cells contain markdown links and AsciiDoc markup. */
function stripMarkdown(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\+\+\+<\/?s>\+\+\+/g, "")
    .replace(/[`*_]/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
}
