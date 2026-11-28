import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { openFilePicker, toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { addCustomLibrary, listLibraries, removeCustomLibrary } from "../api";
import { useI18n } from "../i18n";
import type { Library } from "../types";
import { Centered, Mono, Notice, Pill } from "./Common";

/**
 * `FileSelectionType.FOLDER`. Spelled out rather than imported: it is a
 * `const enum`, which the bundler cannot inline across module boundaries.
 */
const SELECT_FOLDER = 1;

/**
 * Where games are looked for.
 *
 * Steam's own library folders are found automatically; this is for the rest —
 * games on a drive Steam does not know about, or non-Steam installs. Browsing
 * the games themselves lives in the games list, not here.
 */
export function LibraryBrowser() {
  const { t } = useI18n();
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLibraries = useCallback(async () => {
    setError(null);
    try {
      const found = await listLibraries();
      setLibraries(Array.isArray(found) ? found : []);
    } catch (exc) {
      setError(String(exc));
    }
  }, []);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const addFolder = async () => {
    setBusy(true);
    try {
      // Decky's own picker: it knows about the Deck's mount points and reads
      // the filesystem from the plugin host, so the SD card is reachable.
      const picked = await openFilePicker(SELECT_FOLDER, "/home/deck", false, true);
      if (!picked?.path) return;
      const result = await addCustomLibrary(picked.path);
      if (result.ok) {
        toaster.toast({ title: t("Library added"), body: picked.path });
        await loadLibraries();
      } else {
        toaster.toast({ title: t("Could not add"), body: String(result.error) });
      }
    } catch {
      /* the picker was dismissed */
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (library: Library) => {
    setBusy(true);
    try {
      const result = await removeCustomLibrary(library.path);
      if (result.ok) {
        toaster.toast({ title: t("Library removed"), body: library.name });
        await loadLibraries();
      } else {
        toaster.toast({
          title: t("Could not remove"),
          body: String(result.error ?? t("Could not remove custom library.")),
        });
      }
    } catch (exc) {
      toaster.toast({ title: t("Could not remove"), body: String(exc) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSection title={t("Game Libraries")}>
        {error ? (
          <>
            <PanelSectionRow>
              <Notice tone="error" title={t("Could not read your libraries")}>
                {error}
              </Notice>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" disabled={busy} onClick={() => void loadLibraries()}>
                {t("Try again")}
              </ButtonItem>
            </PanelSectionRow>
          </>
        ) : libraries === null ? (
          <Centered>{t("Looking for Steam libraries…")}</Centered>
        ) : libraries.length === 0 ? (
          <PanelSectionRow>
            <Notice tone="warn" title={t("No libraries found")}>
              {t("No Steam library folders were detected. Add a folder manually below.")}
            </Notice>
          </PanelSectionRow>
        ) : (
          libraries.map((library) => (
            <PanelSectionRow key={library.path}>
              <Field
                label={library.name}
                description={
                  library.available ? <Mono>{library.path}</Mono> : t("Folder is missing right now")
                }
                focusable
                bottomSeparator="standard"
                childrenLayout="inline"
                childrenContainerWidth="min"
              >
                <span>
                  {library.source === "custom" ? <Pill>{t("custom")}</Pill> : null}
                  <Pill>{library.game_count}</Pill>
                </span>
              </Field>
            </PanelSectionRow>
          ))
        )}
      </PanelSection>

      <PanelSection title={t("Custom Folders")}>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => void addFolder()}>
            {t("Add a games folder")}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <Notice tone="info">
            {t("Each subfolder of the folder you pick is treated as one game.")}
          </Notice>
        </PanelSectionRow>
        {(libraries ?? [])
          .filter((library) => library.source === "custom")
          .map((library) => (
            <PanelSectionRow key={library.path}>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => void removeFolder(library)}
              >
                {t("Remove “{name}”", { name: library.name })}
              </ButtonItem>
            </PanelSectionRow>
          ))}
      </PanelSection>
    </>
  );
}
