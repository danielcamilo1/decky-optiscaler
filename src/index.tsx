import { definePlugin, routerHook } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaLayerGroup } from "react-icons/fa";
import { patchLibraryContextMenu } from "./libraryContextMenu";
import { ManagerPage } from "./components/ManagerPage";
import { QuickPanel } from "./components/QuickPanel";
import { ROUTE, openManager } from "./navigation";
import { useRunningGame } from "./hooks/useRunningGame";

function Content() {
  const runningGame = useRunningGame();

  // Deep-link straight to a game when the panel already knows which one, so
  // picking one does not dump the user back at the library list.
  const open = (gamePath?: string, gameName?: string, appid?: string) =>
    openManager({ path: gamePath, name: gameName, appid });

  return <QuickPanel runningGame={runningGame} onOpenManager={open} />;
}

export default definePlugin(() => {
  routerHook.addRoute(ROUTE, ManagerPage, { exact: true });
  const unpatchContextMenu = patchLibraryContextMenu();

  return {
    name: "Decky OptiScaler",
    titleView: <div className={staticClasses.Title}>Decky OptiScaler</div>,
    content: <Content />,
    icon: <FaLayerGroup />,
    onDismount() {
      routerHook.removeRoute(ROUTE);
      unpatchContextMenu();
    },
  };
});
