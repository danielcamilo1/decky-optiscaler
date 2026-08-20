// Ambient declarations for the undocumented Steam client globals decky exposes.
declare global {
  interface Window {
    SteamClient: SteamClient;
    appStore: AppStore;
  }

  const SteamClient: SteamClient;
  const appStore: AppStore;

  interface AppOverview {
    appid: number;
    display_name: string;
    gameid: string;
selected_clientid?: string;
  }

  interface AppStore {
    GetAppOverviewByAppID(appid: number): AppOverview | undefined;
  }

  interface AppLifetimeNotification {
    unAppID: number;
    nInstanceID: number;
    bRunning: boolean;
  }

  interface Unregisterable {
    unregister(): void;
  }

  interface SteamClient {
    GameSessions: {
      RegisterForAppLifetimeNotifications(
        callback: (n: AppLifetimeNotification) => void
      ): Unregisterable;
    };
    Apps: {
      GetAppLaunchOptions?(appid: number): Promise<string>;
      SetAppLaunchOptions(appid: number, options: string): void;
      RunGame(gameid: string, args: string, unknown: number, flag: number): void;
      TerminateApp(gameid: string, unknown: boolean): void;
    };
    Storage?: {
      GetJSON(key: string): Promise<string>;
    };
  }
}

export {};
