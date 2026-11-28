export const fixtures: Record<string, any> = {};
export const calls: string[] = [];
export const invocations: { name: string; args: any[] }[] = [];
export const toasts: any[] = [];

/**
 * Optional allowlist for RPC names permitted to resolve to `undefined` without
 * a registered fixture. Empty by default so typos or missing mocks fail fast.
 */
export const unregisteredRpcAllowlist = new Set<string>();

export function callable<A extends any[], R>(name: string) {
  return (async (...args: A): Promise<R> => {
    calls.push(name);
    invocations.push({ name, args });
    if (!Object.prototype.hasOwnProperty.call(fixtures, name)) {
      if (unregisteredRpcAllowlist.has(name)) {
        return undefined as R;
      }
      throw new Error(`Unregistered RPC fixture: ${name}`);
    }
    const value = fixtures[name];
    return (typeof value === "function" ? value(...args) : value) as R;
  }) as (...args: A) => Promise<R>;
}

export const toaster = {
  toast: (payload: any) => {
    toasts.push(payload);
  },
};
export const routerHook = {
  addRoute(_path: string, _component: any, _props?: any) {},
  removeRoute(_path: string) {},
};
export function definePlugin(factory: any) {
  return factory();
}
export function addEventListener(_event: string, _listener: (...args: any[]) => void) {}
export function removeEventListener(_event: string, _listener: (...args: any[]) => void) {}

export type FilePickerResult = { path: string; realpath: string };
export type FilePickerHandler = (
  select: number,
  startPath: string,
  includeFiles?: boolean,
  includeFolders?: boolean,
) => FilePickerResult | Promise<FilePickerResult>;

const defaultFilePicker: FilePickerHandler = () => ({ path: "", realpath: "" });
let filePickerHandler: FilePickerHandler = defaultFilePicker;

export function setFilePicker(handler: FilePickerHandler | FilePickerResult | null) {
  if (handler === null) {
    filePickerHandler = defaultFilePicker;
  } else if (typeof handler === "function") {
    filePickerHandler = handler;
  } else {
    filePickerHandler = () => handler;
  }
}

export function resetFilePicker() {
  filePickerHandler = defaultFilePicker;
}

/** Decky's folder picker. Configurable per test via `setFilePicker()`. */
export async function openFilePicker(
  select: number,
  startPath: string,
  includeFiles?: boolean,
  includeFolders?: boolean,
) {
  calls.push("openFilePicker");
  invocations.push({
    name: "openFilePicker",
    args: [select, startPath, includeFiles, includeFolders],
  });
  return await filePickerHandler(select, startPath, includeFiles, includeFolders);
}
