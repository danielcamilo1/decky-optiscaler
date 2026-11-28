declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
    exitCode?: number | string | null;
    exit(code?: number): never;
    pid: number;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}

declare var process: NodeJS.Process;

declare module "node:assert/strict" {
  function ok(value: unknown, message?: string | Error): asserts value;
  function equal<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T;
  function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  function deepEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T;
  function match(value: string, regExp: RegExp, message?: string | Error): void;
  function fail(message?: string | Error): never;
  const assert: {
    (value: unknown, message?: string | Error): asserts value;
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    match: typeof match;
    fail: typeof fail;
  };
  export default assert;
  export { ok, equal, notEqual, deepEqual, match, fail };
}

declare module "node:fs" {
  export function chmodSync(path: string, mode: number | string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
}

declare module "node:child_process" {
  export interface SpawnSyncReturns {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: { encoding?: string; env?: Record<string, string | undefined> },
  ): SpawnSyncReturns;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  const path: { join: typeof join };
  export default path;
}
