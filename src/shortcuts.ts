/**
 * Non-Steam games: the ones Steam runs but has no install folder for.
 *
 * Everything else in this plugin starts from an app manifest —
 * `appmanifest_<id>.acf` names the folder under `steamapps/common`, and that
 * is the game. A shortcut added by hand has none of that. Steam stores the
 * command line and nothing else, so asking it where the game is installed gets
 * no answer, and the library context menu's **OptiScaler Settings** entry
 * ended on "Steam did not report an install folder for this game" for every
 * one of them.
 *
 * The target is the answer. A shortcut points at an executable, and the folder
 * holding that executable is the folder OptiScaler goes into — it is where the
 * renderer lives, which is the only thing the install cares about. The folder
 * is worked out by the backend, which is the side that can look at the disk;
 * this module's job is to hand it whatever the client will say, because
 * `shortcuts.vdf` is flushed on Steam's schedule and a shortcut added this
 * session is not in it yet.
 */
import { findRunningGame } from "./api";
import type { GameDetail } from "./types";

export interface ShortcutTarget {
  /** The executable the shortcut runs, as Steam stores it (usually quoted). */
  exe?: string;
  /** The working directory Steam starts it in. */
  start_dir?: string;
  /** The name shown in the library, which the folder name rarely matches. */
  name?: string;
}

/**
 * What the Steam client says about a shortcut, or null when it says nothing.
 *
 * `appDetailsStore` is the same undocumented store the launch-options read
 * falls back to — the one the library's own Properties dialog is built on —
 * and it is reached the same way, through a cast and a try. A Steam game has
 * no shortcut fields, so a null here is the ordinary answer for most of the
 * library rather than a failure.
 */
export function readShortcut(appid: number): ShortcutTarget | null {
  const target: ShortcutTarget = {};
  try {
    const details = (
      globalThis as unknown as {
        appDetailsStore?: {
          GetAppDetails?: (id: number) => {
            strShortcutExe?: string;
            strShortcutStartDir?: string;
            strDisplayName?: string;
          } | null;
        };
      }
    ).appDetailsStore?.GetAppDetails?.(appid);
    if (details?.strShortcutExe) target.exe = details.strShortcutExe;
    if (details?.strShortcutStartDir) target.start_dir = details.strShortcutStartDir;
    if (details?.strDisplayName) target.name = details.strDisplayName;
  } catch {
    /* the store is not there; the backend reads shortcuts.vdf instead */
  }
  if (!target.name) {
    try {
      const overview = appStore?.GetAppOverviewByAppID?.(appid);
      if (overview?.display_name) target.name = overview.display_name;
    } catch {
      /* no overview either, and the backend names it after its folder */
    }
  }
  return target.exe || target.start_dir ? target : null;
}

/**
 * Resolve one app id to its folder and install state, shortcut or not.
 *
 * Every caller of `find_running_game` goes through here rather than calling it
 * directly: a non-Steam game is not a special case of the library page, it is
 * a game that can be running, sitting in the Quick Access panel and listed
 * under Now Playing, and all three used to fail on it identically.
 */
export function resolveGame(appid: number | string): Promise<{
  found: boolean;
  appid?: string;
  name?: string;
  path?: string;
  detail?: GameDetail;
}> {
  const id = Number(appid);
  const shortcut = Number.isFinite(id) ? readShortcut(id) : null;
  return findRunningGame(String(appid), shortcut ?? undefined);
}
