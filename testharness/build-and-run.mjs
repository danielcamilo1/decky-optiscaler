import { build } from "esbuild";
import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The plugin talks to these Steam globals; absent here, the code must cope.
globalThis.SteamClient = undefined;
globalThis.appStore = undefined;

const result = await build({
  entryPoints: [path.join(dir, process.env.HARNESS || "run.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  jsx: "automatic",
  outfile: path.join(dir, ".bundle.mjs"),
  external: ["react", "react-dom", "react-dom/client", "react-dom/test-utils", "react-icons/fa"],
  alias: {
    "@decky/ui": path.join(dir, "mock-decky-ui.tsx"),
    "@decky/api": path.join(dir, "mock-decky-api.ts"),
  },
  logLevel: "warning",
});

void result;
await import(path.join(dir, ".bundle.mjs"));
