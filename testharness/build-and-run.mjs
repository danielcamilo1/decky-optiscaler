import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

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

// Keep temporary bundles inside testharness/ so Node ESM resolves external
// react/react-dom packages from the workspace node_modules, while giving each
// concurrent harness process a unique filename and removing it on exit.
const outfile = path.join(dir, `.bundle-${process.pid}-${crypto.randomUUID()}.mjs`);
const cleanup = () => {
  try {
    fs.rmSync(outfile, { force: true });
  } catch {
    // ignore best-effort cleanup errors
  }
};
process.on("exit", cleanup);

try {
  const result = await build({
    entryPoints: [path.join(dir, process.env.HARNESS || "run.tsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    jsx: "automatic",
    outfile,
    external: ["react", "react-dom", "react-dom/client", "react-dom/test-utils", "react-icons/fa"],
    alias: {
      "@decky/ui": path.join(dir, "mock-decky-ui.tsx"),
      "@decky/api": path.join(dir, "mock-decky-api.ts"),
    },
    logLevel: "warning",
  });

  void result;
  await import(pathToFileURL(outfile).href);
} finally {
  cleanup();
}
