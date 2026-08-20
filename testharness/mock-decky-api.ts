export const fixtures: Record<string, any> = {};
export const calls: string[] = [];

export function callable<A extends any[], R>(name: string) {
  return (async (...args: A): Promise<R> => {
    calls.push(name);
    const value = fixtures[name];
    return (typeof value === "function" ? value(...args) : value) as R;
  }) as (...args: A) => Promise<R>;
}

export const toaster = { toast: (_: any) => {} };
export const routerHook = { addRoute() {}, removeRoute() {} };
export function definePlugin(factory: any) {
  return factory();
}
export function addEventListener() {}
export function removeEventListener() {}

/** Decky's folder picker. The harness resolves it as if the user cancelled. */
export async function openFilePicker(
  _select: number,
  _startPath: string,
  _includeFiles?: boolean,
  _includeFolders?: boolean,
) {
  calls.push("openFilePicker");
  return { path: "", realpath: "" };
}
