import { Router } from "@decky/ui";
import { useEffect, useState } from "react";
import type { RunningGame } from "../types";

const POLL_MS = 4000;

function fromOverview(overview: unknown): RunningGame | null {
  if (!overview) return null;
  const app = overview as { appid?: number; display_name?: string; gameid?: string };
  if (typeof app.appid !== "number") return null;
  return {
    appid: app.appid,
    name: app.display_name || `App ${app.appid}`,
    gameid: app.gameid || String(app.appid),
  };
}

function currentApp(): RunningGame | null {
  try {
    return fromOverview(Router.MainRunningApp);
  } catch {
    return null;
  }
}

function describeAppId(appid: number): RunningGame {
  try {
    const overview = fromOverview(appStore?.GetAppOverviewByAppID?.(appid));
    if (overview) return overview;
  } catch {
    /* non-Steam shortcuts have no overview */
  }
  return { appid, name: `App ${appid}`, gameid: String(appid) };
}

/**
 * The game Steam currently has running.
 *
 * Lifetime notifications only fire on change, and this panel is usually opened
 * while a game is already up, so the current app is read on mount and polled as
 * a safety net.
 */
export function useRunningGame(): RunningGame | null {
  const [game, setGame] = useState<RunningGame | null>(() => currentApp());

  useEffect(() => {
    let registration: Unregisterable | undefined;
    try {
      registration = SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications(
        (notification) => {
          if (notification.bRunning) {
            setGame(describeAppId(notification.unAppID));
          } else {
            setGame((current) =>
              current && current.appid === notification.unAppID ? currentApp() : current
            );
          }
        }
      );
    } catch {
      /* not running inside the Steam client */
    }

    const poll = window.setInterval(() => {
      const running = currentApp();
      setGame((current) => {
        if (running?.appid === current?.appid) return current;
        return running;
      });
    }, POLL_MS);

    return () => {
      registration?.unregister();
      window.clearInterval(poll);
    };
  }, []);

  return game;
}

export function restartGame(game: RunningGame) {
  try {
    SteamClient.Apps.TerminateApp(game.gameid, false);
    window.setTimeout(() => {
      try {
        SteamClient.Apps.RunGame(game.gameid, "", -1, 100);
      } catch {
        /* the user can relaunch manually */
      }
    }, 2500);
    return true;
  } catch {
    return false;
  }
}

/**
 * What Steam currently passes this game, or null when it will not say.
 *
 * `GetAppLaunchOptions` is undocumented and not present in every client build,
 * so "cannot tell" is a real answer the setup checklist has to render — it says
 * so rather than showing an unticked step for a game that is set up correctly.
 */
export async function readLaunchOptions(appid: number): Promise<string | null> {
  try {
    // Not part of the Apps interface @decky/ui declares — read through a cast
    // the same way the library-menu patch reaches Steam's own internals.
    const apps = SteamClient?.Apps as unknown as
      | { GetAppLaunchOptions?: (id: number) => Promise<string> }
      | undefined;
    if (!apps?.GetAppLaunchOptions) return null;
    const value = await apps.GetAppLaunchOptions(appid);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * When Steam last ran this game, as a unix time, or null if it will not say.
 *
 * `rt_last_played` is on Steam's own app overview rather than anything decky
 * declares, so it is read through a cast and every caller has to cope with
 * null: a library scanned from a custom folder has no overview at all.
 */
export function lastPlayed(appid: string | null): number | null {
  if (!appid) return null;
  try {
    const overview = appStore?.GetAppOverviewByAppID?.(Number(appid)) as unknown as
      | { rt_last_played?: number }
      | undefined;
    const value = overview?.rt_last_played;
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setLaunchOptions(appid: number, options: string) {
  try {
    SteamClient.Apps.SetAppLaunchOptions(appid, options);
    return true;
  } catch {
    return false;
  }
}
