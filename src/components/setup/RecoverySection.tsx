import {
  ConfirmModal,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  showModal,
} from "@decky/ui";
import { useI18n } from "../../i18n";
import type { GameDetail } from "../../types";
import { Mono, Notice } from "../Common";

interface RecoverySectionProps {
  detail: GameDetail;
  appid: string | null;
  runtimeCurrent: boolean;
  busy: boolean;
  running: boolean;
  restoreBusy: boolean;
  restoreError?: string | null;
  launchNow: string | null;
  launchLoaded: boolean;
  onRestore?: () => Promise<void> | void;
  onRetryRestoreLaunchOptions?: () => void;
}

function RestoreConfirmModal({
  version,
  savedLaunchOptions,
  appid,
  closeModal,
  onConfirm,
}: Readonly<{
  version?: string;
  savedLaunchOptions: string | null;
  appid: string | null;
  closeModal?: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  return (
    <ConfirmModal
      strTitle={t("Restore previous install?")}
      strOKButtonText={t("Restore")}
      strCancelButtonText={t("Cancel")}
      closeModal={closeModal}
      onOK={onConfirm}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        <div>
          {t("This replaces the current OptiScaler files and config with ")}
          {version ? (
            <>
              OptiScaler <Mono>{version}</Mono>
            </>
          ) : (
            t("the saved pre-upgrade snapshot")
          )}
          .
        </div>
        {appid ? (
          <div style={{ marginTop: "8px" }}>
            {savedLaunchOptions !== null ? (
              <>
                {t("Steam launch options will be set to:")}{" "}
                {savedLaunchOptions === "" ? (
                  <Mono>{t("(empty)")}</Mono>
                ) : (
                  <Mono>{savedLaunchOptions}</Mono>
                )}
              </>
            ) : (
              t("This restore point has no saved Steam launch options; Steam will be left unchanged.")
            )}
          </div>
        ) : null}
      </div>
    </ConfirmModal>
  );
}

function ApplySavedLaunchConfirmModal({
  savedLaunchOptions,
  currentLaunchOptions,
  closeModal,
  onConfirm,
}: Readonly<{
  savedLaunchOptions: string;
  currentLaunchOptions: string | null;
  closeModal?: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  return (
    <ConfirmModal
      strTitle={t("Apply saved Steam launch options?")}
      strOKButtonText={t("Apply")}
      strCancelButtonText={t("Cancel")}
      closeModal={closeModal}
      onOK={onConfirm}
    >
      <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
        <div>
          {t(
            "This will overwrite this game's current Steam launch options with the value saved in the restore point:",
          )}
        </div>
        <div style={{ margin: "8px 0" }}>
          {savedLaunchOptions === "" ? <Mono>{t("(empty)")}</Mono> : <Mono>{savedLaunchOptions}</Mono>}
        </div>
        {currentLaunchOptions !== null ? (
          <div style={{ opacity: 0.8 }}>
            {t("Current value:")}{" "}
            {currentLaunchOptions === "" ? (
              <Mono>{t("(empty)")}</Mono>
            ) : (
              <Mono>{currentLaunchOptions}</Mono>
            )}
          </div>
        ) : null}
      </div>
    </ConfirmModal>
  );
}

export function RecoverySection({
  detail,
  appid,
  runtimeCurrent,
  busy,
  running,
  restoreBusy,
  restoreError,
  launchNow,
  launchLoaded,
  onRestore,
  onRetryRestoreLaunchOptions,
}: Readonly<RecoverySectionProps>) {
  const { t } = useI18n();
  const rollback = detail.install.rollback;
  if (!onRestore || !rollback?.available) return null;

  const rawSavedLaunch = rollback.metadata?.launch_options;
  const savedLaunchOptions = typeof rawSavedLaunch === "string" ? rawSavedLaunch : null;
  const hasSavedLaunchOptions = savedLaunchOptions !== null;
  // Only show the saved launch options retry UI when an in-session restoreError
  // occurred OR when the backend persisted launch_pending after a rollback and
  // Steam's current launch options still differ from the saved value.
  const showPendingSavedLaunch =
    !restoreError &&
    Boolean(appid) &&
    hasSavedLaunchOptions &&
    Boolean(onRetryRestoreLaunchOptions) &&
    launchLoaded &&
    rollback.launch_pending === true &&
    launchNow !== savedLaunchOptions;

  const confirmRestore = () => {
    showModal(
      <RestoreConfirmModal
        version={rollback.version}
        savedLaunchOptions={savedLaunchOptions}
        appid={appid}
        onConfirm={() => void onRestore()}
      />,
    );
  };

  const confirmApplySavedLaunch = () => {
    if (savedLaunchOptions === null || !onRetryRestoreLaunchOptions) return;
    showModal(
      <ApplySavedLaunchConfirmModal
        savedLaunchOptions={savedLaunchOptions}
        currentLaunchOptions={launchNow}
        onConfirm={onRetryRestoreLaunchOptions}
      />,
    );
  };

  return (
    <PanelSection title={t("Recovery")}>
      <PanelSectionRow>
        <Notice tone="info" title={t("Previous install preserved")}>
          {rollback.version
            ? t("Saved before upgrading from OptiScaler {version}. ", { version: rollback.version })
            : t("Saved before managed runtime change. ")}
          {t("Kept until you remove OptiScaler{ro}. Restores only files captured at upgrade.", {
            ro: !runtimeCurrent ? t("; settings stay read-only until upgraded") : "",
          })}
        </Notice>
      </PanelSectionRow>

      {restoreError && appid && hasSavedLaunchOptions && onRetryRestoreLaunchOptions ? (
        <PanelSectionRow>
          <Focusable style={{ display: "flex" }}>
            <DialogButton
              disabled={restoreBusy}
              onClick={onRetryRestoreLaunchOptions}
              onOKActionDescription={t("Retry restoring Steam launch options")}
              style={{ flexGrow: 1 }}
            >
              {t("Retry launch options")}
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
      ) : null}

      {showPendingSavedLaunch ? (
        <>
          <PanelSectionRow>
            <Notice tone="warn" title={t("The restore point still has saved Steam launch options")}>
              {t("If Steam did not accept them after the file restore, you can apply them below.")}
            </Notice>
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable style={{ display: "flex" }}>
              <DialogButton
                disabled={restoreBusy}
                onClick={confirmApplySavedLaunch}
                onOKActionDescription={t("Apply the launch options saved in the restore point")}
                style={{ flexGrow: 1 }}
              >
                {t("Apply saved launch options")}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        </>
      ) : null}

      <PanelSectionRow>
        <Focusable style={{ display: "flex" }}>
          <DialogButton
            disabled={busy || restoreBusy || running}
            onClick={confirmRestore}
            onOKActionDescription={t("Restore the previous OptiScaler install")}
            style={{ flexGrow: 1 }}
          >
            {restoreBusy ? t("Restoring previous install…") : t("Restore previous install")}
          </DialogButton>
        </Focusable>
      </PanelSectionRow>

      {running ? (
        <PanelSectionRow>
          <Notice tone="warn">{t("Close the game before restoring files.")}</Notice>
        </PanelSectionRow>
      ) : null}
    </PanelSection>
  );
}
