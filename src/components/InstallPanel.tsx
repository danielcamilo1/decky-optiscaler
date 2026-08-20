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
import { useEffect, useState } from "react";
import {
  getPref,
  install,
  setGameTarget,
  setPref,
  setWikiEntry,
} from "../api";
import { setLaunchOptions } from "../hooks/useRunningGame";
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
  onChanged: () => Promise<void> | void;
}

/** Remembered answer to the launch-options question: "always" | "never". */
const LAUNCH_OPTIONS_PREF = "launch_options";

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
  closeModal,
  onDecide,
}: Readonly<{
  filename: string;
  launchOption: string;
  closeModal?: () => void;
  onDecide: (apply: boolean, remember: boolean) => void;
}>) {
  const [remember, setRemember] = useState(false);
  return (
    <ConfirmModal
      strTitle="Set the Steam launch options?"
      strOKButtonText="Set them for me"
      strCancelButtonText="Not now"
      closeModal={closeModal}
      onOK={() => onDecide(true, remember)}
      onCancel={() => onDecide(false, remember)}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        Proton loads its own <Mono>{filename}</Mono> unless this override is set, and
        OptiScaler never gets to run:
        <div style={{ margin: "8px 0" }}>
          <Mono>{launchOption}</Mono>
        </div>
      </div>
      <ToggleField
        label="Remember my choice"
        checked={remember}
        bottomSeparator="none"
        onChange={setRemember}
      />
    </ConfirmModal>
  );
}

/**
 * Everything about one install that is not the three steps: which file name,
 * which folder, OptiPatcher, FSR 4 files, the wiki entry to follow and the
 * launch options. Reached from "Manual setup" on the setup checklist,
 * which is where the majority of games never have to come.
 */
export function InstallPanel({ detail, status, appid, live, onChanged }: Props) {
  const [filename, setFilename] = useState(detail.install.filename ?? "dxgi.dll");
  const [target, setTarget] = useState(detail.target);
  const [preserveIni, setPreserveIni] = useState(false);
  const [optipatcher, setOptipatcher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const proxies = status?.proxy_filenames ?? ["dxgi.dll"];
  const {
    recommendation,
    loading: loadingWiki,
    reload: lookup,
  } = useAutoPlan(detail.path, detail.name);

  useEffect(() => {
    setTarget(detail.target);
    if (detail.install.filename) setFilename(detail.install.filename);
  }, [detail.target, detail.install.filename]);

  useEffect(() => {
    if (recommendation && !detail.install.installed) setFilename(recommendation.filename);
  }, [recommendation, detail.install.installed]);

  // An .asi build is loaded by an ASI loader, so Proton has nothing to shadow.
  const needsNoOverride = filename.toLowerCase().endsWith(".asi");
  const launchOption = needsNoOverride
    ? "%command%"
    : `WINEDLLOVERRIDES="${filename.replace(/\.dll$/i, "")}=n,b" %command%`;

  const doInstall = async () => {
    setBusy(true);
    try {
      const result = await install(target, filename, preserveIni, optipatcher);
      if (result.ok) {
        toaster.toast({
          title: "OptiScaler installed",
          body: `${filename} in ${target.split("/").slice(-2).join("/")}`,
        });
        await setGameTarget(detail.path, target);
        await onChanged();
        await offerLaunchOptions();
      } else {
        toaster.toast({ title: "Install failed", body: String(result.error) });
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * The one thing an install cannot do for itself without being asked.
   * Answered already? Honour that answer and say nothing.
   */
  const offerLaunchOptions = async () => {
    if (!appid || needsNoOverride) return;
    let remembered: unknown = null;
    try {
      remembered = (await getPref(LAUNCH_OPTIONS_PREF)).value;
    } catch {
      /* a missing preference is just an unanswered question */
    }
    if (remembered === "never") return;
    if (remembered === "always") {
      applyLaunchOptions();
      return;
    }
    showModal(
      <LaunchOptionsPrompt
        filename={filename}
        launchOption={launchOption}
        onDecide={(apply, remember) => {
          if (remember) void setPref(LAUNCH_OPTIONS_PREF, apply ? "always" : "never");
          if (apply) applyLaunchOptions();
        }}
      />
    );
  };

  const applyLaunchOptions = () => {
    if (!appid) return;
    if (setLaunchOptions(Number(appid), launchOption)) {
      toaster.toast({ title: "Launch options set", body: launchOption });
    } else {
      toaster.toast({ title: "Could not set launch options", body: "Set them manually in Steam." });
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
              await setWikiEntry(detail.path, entryName);
              setSearching(false);
              await onChanged();
              await lookup(false);
              toaster.toast({ title: "Compatibility entry set", body: entryName });
            }}
          />
        ) : null}
      </PanelSection>

      <PanelSection title={detail.install.installed ? "Installation" : "Install OptiScaler"}>
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

        {detail.candidates.length > 1 ? (
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
              The OptiScaler.ini already here still uses the old <Mono>FGType</Mono> key, so it
              was written by an older tool. Install with a fresh config unless you know you
              want to keep it.
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

        {!detail.writable ? (
          <PanelSectionRow>
            <Notice tone="error" title="Folder is not writable">
              <Mono>{shorten(target)}</Mono>
            </Notice>
          </PanelSectionRow>
        ) : null}

        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || !detail.writable} onClick={doInstall}>
            {busy
              ? "Working…"
              : detail.install.installed
                ? detail.install.filename === filename
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
          onChanged={onChanged}
        />
      ) : null}

      {detail.install.installed ? (
        <LivePanel targetDir={detail.install.path} status={live} onChanged={onChanged} />
      ) : null}

      {detail.install.installed ? (
        <OptipatcherPanel targetDir={detail.install.path} />
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
              </>
            )}
          </Notice>
        </PanelSectionRow>
        {appid && !needsNoOverride ? (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={applyLaunchOptions}>
              Set launch options for me
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
