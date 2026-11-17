import { preserveExistingInstall } from "../launchOptions";
import {
  clearTargetLiveActions,
  getTargetLiveStatusRequestEpoch,
  getTargetLiveRecord,
  rememberTargetForAppId,
  subscribeTargetLiveRecord,
  updateTargetLiveRecord,
} from "../config/liveRecord";
import type { PendingLiveChange } from "../config/liveRecord";
import { useCallback, useEffect, useRef, useState } from "react";
import { readConfig, setFsr4Build, writeConfig } from "../api";
import { AUTO } from "../config/values";
import { optionsInSection } from "../config/tabs";
import {
  confirmedLiveKeys,
  isConfirmedLiveResult,
  requestMatchesContext,
  receiptAuthorizationChanged,
  requiresLiveSelectionContext,
} from "../liveControl";
import {
  beginTargetRead,
  beginTargetFlush,
  finishTargetFlush,
  failTargetChanges,
  forgetWrites,
  getTargetConfigQueue,
  invalidateTargetReads,
  isCurrentTargetRead,
  overlayWrites,
  queueTargetChanges,
  rememberWrites,
  serializeTargetWrite,
  waitForTargetWrites,
} from "../config/writeRecord";
import type { TargetConfigQueue } from "../config/writeRecord";
import type {
  ConfigValues,
  LiveStatus,
  LiveApplyResult,
  LiveContext,
  OptionChange,
  OptionMeta,
} from "../types";

const FLUSH_DELAY_MS = 400;

const changeId = (change: OptionChange) => `${change.section}.${change.key}`;

/** Identity that authorized the actual send, retaining a dynamic selection's original snapshot. */
function contextForSentKey(
  result: LiveApplyResult | null,
  id: string,
  selected?: LiveContext,
): LiveContext | null {
  const sent = result?.context;
  if (
    result?.sent !== true ||
    !result.sent_keys?.includes(id) ||
    !sent?.target ||
    !sent.session ||
    sent.session !== result.session ||
    !sent.capability_generation
  ) return null;
  if (selected) {
    if (
      selected.target !== sent.target ||
      selected.session !== sent.session ||
      selected.active_api !== sent.active_api ||
      selected.capability_generation !== sent.capability_generation
    ) return null;
    return selected;
  }
  return { ...sent };
}

function contextForSentChange(result: LiveApplyResult | null, change: OptionChange): LiveContext | null {
  const id = changeId(change);
  return contextForSentKey(
    result,
    id,
    requiresLiveSelectionContext(id) ? change.live_context : undefined,
  );
}

function decimalSequenceGreater(candidate: string, baseline: string): boolean {
  if (!/^\d+$/.test(candidate) || !/^\d+$/.test(baseline)) return false;
  const normalizedCandidate = candidate.replace(/^0+(?=\d)/, "");
  const normalizedBaseline = baseline.replace(/^0+(?=\d)/, "");
  return normalizedCandidate.length > normalizedBaseline.length ||
    (normalizedCandidate.length === normalizedBaseline.length && normalizedCandidate > normalizedBaseline);
}

interface ConfigView {
  identity: string;
  values: ConfigValues;
  fsr4Build: string | null;
  runtimeCurrent: boolean | undefined;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  restartKeys: string[];
  livePending: PendingLiveChange[];
  saving: boolean;
  live: LiveApplyResult | null;
}

function emptyView(identity: string, loading = false): ConfigView {
  return {
    identity,
    values: {},
    fsr4Build: null,
    runtimeCurrent: undefined,
    loading,
    error: null,
    dirty: false,
    restartKeys: [],
    livePending: [],
    saving: false,
    live: null,
  };
}

/**
 * Edits one OptiScaler.ini at a time. Writes for a target are serialized across
 * hook instances, and values are always tagged with the game identity that
 * requested them so a delayed read can never populate another game's controls.
 */
export function useConfig(
  targetDir: string | null,
  enabled: boolean,
  reloadKey?: unknown,
  identityKey?: unknown,
  gameContext?: { gamePath: string; appid: string | null },
) {
  const identity = `${targetDir ?? ""}\u0000${String(identityKey ?? "")}\u0000${enabled}`;
  const identityRef = useRef(identity);
  const generation = useRef(0);
  const canonicalTarget = useRef<string | null>(null);
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    generation.current += 1;
    canonicalTarget.current = null;
  }
  const generationAtRender = generation.current;
  const [storedView, setStoredView] = useState<ConfigView>(() => emptyView(identity));
  const view = storedView.identity === identity
    ? storedView
    : emptyView(identity, Boolean(targetDir && enabled));
  const localReadSequence = useRef(0);

  const getQueue = useCallback((dir: string): TargetConfigQueue => {
    return getTargetConfigQueue(dir);
  }, []);

  const isCurrent = useCallback(
    (requestIdentity: string, requestGeneration: number) =>
      identityRef.current === requestIdentity && generation.current === requestGeneration,
    [],
  );

  const updateView = useCallback(
    (requestIdentity: string, update: (current: ConfigView) => ConfigView) => {
      if (identityRef.current !== requestIdentity) return;
      setStoredView((current) => {
        const base = current.identity === requestIdentity ? current : emptyView(requestIdentity);
        return update(base);
      });
    },
    [],
  );

  useEffect(() => {
    if (targetDir && gameContext?.appid) rememberTargetForAppId(targetDir, gameContext.appid);
  }, [targetDir, gameContext?.appid]);

  useEffect(() => {
    if (!targetDir) return;
    const dir = targetDir;
    const requestIdentity = identity;
    const sync = () => {
      const record = getTargetLiveRecord(dir);
      updateView(requestIdentity, (current) => ({
        ...current,
        ...record,
        dirty: record.restartKeys.length > 0 || record.livePending.length > 0,
      }));
    };
    const unsubscribe = subscribeTargetLiveRecord(dir, sync);
    sync();
    return unsubscribe;
  }, [targetDir, identity, updateView]);

  const overlay = useCallback((dir: string, base: ConfigValues): ConfigValues => {
    const disk = overlayWrites(dir, base);
    const next: ConfigValues = {};
    for (const [section, keys] of Object.entries(disk)) next[section] = { ...keys };
    const queue = getQueue(dir);
    for (const newer of [queue.inFlight, queue.pending]) {
      for (const item of newer.values()) {
        const change = item.change;
        next[change.section] = { ...(next[change.section] ?? {}), [change.key]: change.value };
      }
    }
    return next;
  }, [getQueue]);

  const readTarget = useCallback(
    async (
      dir: string,
      requestIdentity: string,
      requestGeneration: number,
      authoritative = false,
    ): Promise<boolean> => {
      if (!enabled || !isCurrent(requestIdentity, requestGeneration)) return false;
      const localSequence = ++localReadSequence.current;
      const targetSequence = beginTargetRead(dir);
      const mayApply = () =>
        isCurrent(requestIdentity, requestGeneration) &&
        localReadSequence.current === localSequence &&
        isCurrentTargetRead(dir, targetSequence);
      const retryIfStillCurrent = async (): Promise<boolean> => {
        if (!isCurrent(requestIdentity, requestGeneration) || localReadSequence.current !== localSequence) {
          return false;
        }
        await waitForTargetWrites(dir);
        if (isCurrent(requestIdentity, requestGeneration) && localReadSequence.current === localSequence) {
          return readTarget(dir, requestIdentity, requestGeneration, authoritative);
        }
        return false;
      };
      updateView(requestIdentity, (current) => ({ ...current, loading: true, error: null }));
      try {
        const result = await readConfig(dir);
        if (!mayApply()) {
          return await retryIfStillCurrent();
        }
        if (result.ok) {
          const liveRecord = getTargetLiveRecord(dir);
          updateView(requestIdentity, (current) => ({
            ...current,
            values: authoritative ? result.values : overlay(dir, result.values),
            fsr4Build: result.fsr4_build ?? null,
            runtimeCurrent: result.runtime_current,
            live: liveRecord.live ?? current.live,
            restartKeys: liveRecord.restartKeys,
            livePending: liveRecord.livePending,
            dirty: liveRecord.restartKeys.length > 0 || liveRecord.livePending.length > 0,
            error: null,
          }));
          return true;
        } else {
          updateView(requestIdentity, (current) => ({
            ...current,
            error: result.error ?? "Could not read OptiScaler.ini",
          }));
          return false;
        }
      } catch (exc) {
        if (mayApply()) {
          updateView(requestIdentity, (current) => ({ ...current, error: String(exc) }));
        } else {
          return await retryIfStillCurrent();
        }
        return false;
      } finally {
        if (
          isCurrent(requestIdentity, requestGeneration) &&
          localReadSequence.current === localSequence
        ) {
          updateView(requestIdentity, (current) => ({ ...current, loading: false }));
        }
      }
    },
    [enabled, isCurrent, overlay, updateView],
  );

  const load = useCallback(async () => {
    if (!targetDir || !enabled) return;
    await readTarget(targetDir, identity, generationAtRender);
  }, [targetDir, enabled, identity, generationAtRender, readTarget]);

  const flushTarget = useCallback(
    async (
      dir: string,
      requestIdentity: string,
      requestGeneration: number,
      foreground = false,
    ) => {
      const queue = getQueue(dir);
      const requestedRevision = queue.revision;
      const flushWaiter = beginTargetFlush(queue, requestedRevision, foreground);
      if (queue.timer !== null) window.clearTimeout(queue.timer);
      queue.timer = null;
      const drain = async () => {
        while (queue.pending.size > 0) {
          const batch = Array.from(queue.pending.values());
          queue.pending.clear();
          for (const item of batch) queue.inFlight.set(changeId(item.change), item);
          if (isCurrent(requestIdentity, requestGeneration)) {
            updateView(requestIdentity, (current) => ({ ...current, saving: true }));
          }
          invalidateTargetReads(dir);
          let refreshAfterFailure = false;
          let failureMessage: string | null = null;
          try {
            const result = await serializeTargetWrite(dir, () =>
              writeConfig(dir, batch.map((item) => item.change)),
            );
            const applied = result.live ?? null;
            const rejectedIds = new Set((result.rejected ?? []).map(changeId));
            const persisted = batch.filter((item) => !rejectedIds.has(changeId(item.change)));
            const sentKeys = new Set(applied?.sent_keys ?? []);
            const nativeApplied = new Set(
              isConfirmedLiveResult(applied) ? confirmedLiveKeys(applied) : [],
            );
            const deferred = new Set([
              ...(applied?.deferred ?? []),
              ...(applied?.failed_keys ?? []),
            ]);
            const appliedItems = persisted.filter((item) => {
              const id = changeId(item.change);
              const context = contextForSentChange(applied, item.change);
              return Boolean(
                sentKeys.has(id) && context && context.session === applied?.session &&
                  nativeApplied.has(id),
              );
            });
            const pendingItems = applied?.sent && applied.session && applied.seq &&
              applied.ack !== "rejected" &&
              (applied.ack === "pending" || applied.ack === "timeout" || applied.confirmed !== true)
              ? persisted.filter((item) => {
                  const id = changeId(item.change);
                  const context = contextForSentChange(applied, item.change);
                  return Boolean(
                    sentKeys.has(id) && context && context.session === applied.session &&
                      !nativeApplied.has(id) && !deferred.has(id),
                  );
                })
              : [];
            let liveOutcome = applied;
            const nextRecord = result.ok
              ? updateTargetLiveRecord(dir, (stored) => {
                  const persistedValues = { ...stored.persistedValues };
                  const persistedRevisions = { ...stored.persistedRevisions };
                  for (const item of persisted) {
                    const id = changeId(item.change);
                    if (item.revision >= (persistedRevisions[id] ?? -1)) {
                      persistedValues[id] = item.change.value;
                      persistedRevisions[id] = item.revision;
                    }
                  }

                  const effectivePendingItems = pendingItems.filter((item) => {
                    const id = changeId(item.change);
                    const newer = queue.pending.get(id) ?? queue.inFlight.get(id);
                    return !newer || newer.revision <= item.revision;
                  });
                  const appliedIds = new Set(appliedItems.map((item) => changeId(item.change)));
                  const pendingIds = new Set(effectivePendingItems.map((item) => changeId(item.change)));
                  const restartForBatch: string[] = [];
                  const restart = new Set(stored.restartKeys);
                  for (const item of persisted) {
                    const id = changeId(item.change);
                    if (item.revision < (persistedRevisions[id] ?? item.revision)) continue;
                    const newer = queue.pending.get(id) ?? queue.inFlight.get(id);
                    const superseded = Boolean(newer && newer.revision > item.revision);
                    if (superseded) {
                      restart.add(id);
                      restartForBatch.push(id);
                    } else if (appliedIds.has(id) || pendingIds.has(id)) {
                      restart.delete(id);
                    } else {
                      restart.add(id);
                      restartForBatch.push(id);
                    }
                  }

                  const livePending = stored.livePending
                    .map((entry) => {
                      const remaining = entry.keys.filter((id) => {
                        const replacement = persisted.find((item) => changeId(item.change) === id);
                        return !replacement || replacement.revision < (entry.revisions[id] ?? -1);
                      });
                      return {
                        ...entry,
                        keys: remaining,
                        values: Object.fromEntries(Object.entries(entry.values).filter(([id]) => remaining.includes(id))),
                        revisions: Object.fromEntries(Object.entries(entry.revisions).filter(([id]) => remaining.includes(id))),
                        contexts: Object.fromEntries(Object.entries(entry.contexts).filter(([id]) => remaining.includes(id))),
                      };
                    })
                    .filter((entry) => entry.keys.length > 0);
                  if (effectivePendingItems.length > 0 && applied?.session && applied.seq) {
                    livePending.push({
                      target: dir,
                      session: applied.session,
                      seq: applied.seq,
                      statusEpoch: getTargetLiveStatusRequestEpoch(dir),
                      keys: effectivePendingItems.map((item) => changeId(item.change)),
                      values: Object.fromEntries(effectivePendingItems.map((item) => [changeId(item.change), item.change.value])),
                      revisions: Object.fromEntries(effectivePendingItems.map((item) => [changeId(item.change), item.revision])),
                      contexts: Object.fromEntries(effectivePendingItems.flatMap((item) => {
                        const context = contextForSentChange(applied, item.change);
                        return context ? [[changeId(item.change), context]] : [];
                      })),
                    });
                  }

                  const restartKeys = Array.from(restart);
                  liveOutcome = applied
                    ? {
                        ...applied,
                        deferred: Array.from(new Set([
                          ...(applied.deferred ?? []),
                          ...restartForBatch.filter((id) => !id.startsWith("__")),
                        ])),
                      }
                    : stored.live;
                  return {
                    ...stored,
                    restartKeys,
                    livePending,
                    live: liveOutcome,
                    persistedValues,
                    persistedRevisions,
                  };
                })
              : getTargetLiveRecord(dir);
            if (isCurrent(requestIdentity, requestGeneration)) {
              updateView(requestIdentity, (current) => ({
                ...current,
                ...nextRecord,
                dirty: result.ok
                  ? nextRecord.restartKeys.length > 0 || nextRecord.livePending.length > 0
                  : current.dirty,
                error: result.ok ? current.error : result.error ?? "Write failed",
              }));
            }

            if (!result.ok) {
              failureMessage = result.error ?? "Write failed";
              failTargetChanges(queue, batch, failureMessage);
              for (const item of batch) {
                queue.inFlight.delete(changeId(item.change));
                forgetWrites(dir, [item.change], item.stamp);
              }
              refreshAfterFailure = true;
            } else {
              const rejected = batch.filter((item) => rejectedIds.has(changeId(item.change)));
              for (const item of batch) {
                if (rejectedIds.has(changeId(item.change))) {
                  queue.inFlight.delete(changeId(item.change));
                  forgetWrites(dir, [item.change], item.stamp);
                }
              }
              if (rejectedIds.size > 0) {
                refreshAfterFailure = true;
                const rejectedKeys = (result.rejected ?? []).map((item) => item.key).join(", ");
                failureMessage = `OptiScaler would not accept ${rejectedKeys}`;
                failTargetChanges(queue, rejected, failureMessage);
              }
            }
          } catch (exc) {
            failureMessage = String(exc);
            failTargetChanges(queue, batch, failureMessage);
            for (const item of batch) {
              queue.inFlight.delete(changeId(item.change));
              forgetWrites(dir, [item.change], item.stamp);
            }
            if (isCurrent(requestIdentity, requestGeneration)) {
              refreshAfterFailure = true;
            }
          } finally {
            invalidateTargetReads(dir);
            for (const item of batch) {
              const id = changeId(item.change);
              if (queue.inFlight.get(id) === item) queue.inFlight.delete(id);
            }
            if (isCurrent(requestIdentity, requestGeneration)) {
              updateView(requestIdentity, (current) => ({ ...current, saving: false }));
            }
          }
          if (refreshAfterFailure && isCurrent(requestIdentity, requestGeneration)) {
            await readTarget(dir, requestIdentity, requestGeneration);
            if (failureMessage) {
              updateView(requestIdentity, (current) => ({ ...current, error: failureMessage }));
            }
          }
        }
      };

      const startDrain = () => {
        const operation = drain();
        const wrapped = operation.finally(() => {
          if (queue.drain === wrapped) queue.drain = null;
        });
        queue.drain = wrapped;
      };
      try {
        while (queue.pending.size > 0 || queue.drain) {
          if (!queue.drain && queue.pending.size > 0) startDrain();
          if (!queue.drain) break;
          await queue.drain;
        }
        await waitForTargetWrites(dir);
        const failures = finishTargetFlush(queue, flushWaiter);
        if (failures.length > 0) throw new Error(Array.from(new Set(failures)).join("; "));
      } catch (exc) {
        finishTargetFlush(queue, flushWaiter);
        throw exc;
      }
    },
    [getQueue, isCurrent, readTarget, updateView],
  );

  const flush = useCallback(() => {
    if (!targetDir) return Promise.resolve();
    return flushTarget(targetDir, identity, generationAtRender, true);
  }, [targetDir, identity, generationAtRender, flushTarget]);

  const reconcileLiveStatus = useCallback((status: LiveStatus | null, statusEpoch: number | null) => {
    if (!targetDir || !enabled || !status || statusEpoch === null) return;
    const dir = targetDir;
    const existing = getTargetLiveRecord(dir);
    // A Steam start event advances this target's epoch. Replies started before
    // that event cannot restore the receipts it cleared.
    if (statusEpoch <= (existing.statusEpoch ?? 0)) return;
    if (status.schema === 7 && status.supported && status.dir_matches && status.dir_verified && status.dir) {
      canonicalTarget.current = status.dir;
    }
    const queue = getQueue(dir);
    if (existing.livePending.length === 0 &&
        !(existing.live && receiptAuthorizationChanged(existing.live, status))) return;
    const nextRecord = updateTargetLiveRecord(dir, (stored) => {
      const restart = new Set(stored.restartKeys);
      const pending: PendingLiveChange[] = [];
      let nextLive = stored.live;
      if (nextLive && receiptAuthorizationChanged(nextLive, status)) {
        for (const key of nextLive.sent_keys ?? []) restart.add(key);
        nextLive = { ...nextLive, confirmed: false, ack: "rejected", accepted_keys: [],
          failed_keys: nextLive.sent_keys ?? [], error: "Live directory authorization changed." };
      }

      for (const entry of stored.livePending) {
        if (entry.target !== dir) {
          pending.push(entry);
          continue;
        }
        // A cached status from before this send cannot prove that its session
        // ended. Every mounted panel shares this target-wide request epoch, so
        // only a request begun after the send may retire the pending sequence.
        if (statusEpoch <= entry.statusEpoch) {
          pending.push(entry);
          continue;
        }
        const sameSession = status.session === entry.session;
        const sameSequence = sameSession && status.seq === entry.seq;
        const verifiedTarget = status.supported === true && status.schema === 7 &&
          status.dir_verified === true && status.dir_matches === true;
        if (sameSequence && verifiedTarget) {
          const terminal = status.ack === "config_request_accepted" || status.ack === "rejected";
          if (terminal) {
            const statusConfirmed = new Set(status.accepted_keys ?? []);
            const statusFailed = new Set(status.failed_keys ?? []);
            const needsRestart: string[] = [];
            const acceptedConfirmed: string[] = [];
            const invalidContext: string[] = [];
            for (const key of entry.keys) {
              const revision = entry.revisions[key] ?? -1;
              const queued = queue.pending.get(key) ?? queue.inFlight.get(key);
              const hasNewerWrite = Boolean(queued && queued.revision > revision);
              const latestPersisted = stored.persistedRevisions[key] === revision &&
                stored.persistedValues[key] === entry.values[key];
              const contextMatches = requestMatchesContext(entry.contexts[key], status, dir);
              if (!contextMatches) invalidContext.push(key);
              if (
                status.ack === "config_request_accepted" && statusConfirmed.has(key) && !statusFailed.has(key) &&
                contextMatches
              ) {
                acceptedConfirmed.push(key);
                if (hasNewerWrite || !latestPersisted) {
                  restart.add(key);
                  needsRestart.push(key);
                } else {
                  restart.delete(key);
                }
              } else {
                restart.add(key);
                needsRestart.push(key);
              }
            }
            if (nextLive?.session === entry.session && nextLive.seq === entry.seq) {
              nextLive = {
                ...nextLive,
                confirmed: status.ack === "config_request_accepted" && acceptedConfirmed.length === entry.keys.length,
                ack: status.ack,
                accepted_keys: Array.from(new Set([...(nextLive.accepted_keys ?? []), ...acceptedConfirmed])),
                failed_keys: Array.from(new Set([
                  ...(nextLive.failed_keys ?? []),
                  ...statusFailed,
                  ...(status.ack === "rejected" ? entry.keys : [...needsRestart, ...invalidContext]),
                ])),
                deferred: Array.from(new Set([...(nextLive.deferred ?? []), ...needsRestart, ...invalidContext])),
                error: status.ack === "config_request_accepted" ? undefined : status.error ?? nextLive.error,
                reason: status.ack === "config_request_accepted" ? undefined : nextLive.reason,
              };
            }
            // A terminal ACK retires the pending entry. Only keys individually
            // confirmed for the matching sequence and still current are cleared;
            // any missing, failed, or superseded key remains restart-required.
            continue;
          }
          pending.push(entry);
          continue;
        }

        if (status.session && !sameSession) {
          for (const key of entry.keys) restart.add(key);
          continue;
        }
        if (sameSession && status.seq && decimalSequenceGreater(status.seq, entry.seq)) {
          for (const key of entry.keys) restart.add(key);
          continue;
        }
        pending.push(entry);
      }

      const restartKeys = Array.from(restart);
      return { ...stored, live: nextLive, restartKeys, livePending: pending };
    });
    updateView(identity, (current) => ({
      ...current,
      ...nextRecord,
      dirty: nextRecord.restartKeys.length > 0 || nextRecord.livePending.length > 0,
    }));
  }, [targetDir, enabled, getQueue, identity, updateView]);

  const recordLiveAction = useCallback((
    result: LiveApplyResult,
    context: LiveContext,
    keys: string[],
    expectedValues: Record<string, string>,
    expectedRevisions: Record<string, number> = {},
  ) => {
    if (
      !targetDir ||
      (context.target !== targetDir && context.target !== canonicalTarget.current)
    ) return;
    const dir = targetDir;
    const queue = getQueue(dir);
    const nextRecord = updateTargetLiveRecord(dir, (stored) => {
      const restart = new Set(stored.restartKeys);
        const sentKeys = new Set(result.sent_keys ?? []);
        const resultConfirmed = new Set(confirmedLiveKeys(result).filter((key) => sentKeys.has(key)));
      const confirmed = isConfirmedLiveResult(result, context, keys);
        const responseContexts = Object.fromEntries(keys.flatMap((key) => {
          const sentContext = contextForSentKey(result, key, context);
          return sentContext ? [[key, sentContext]] : [];
        }));
        const unresolved = result.sent === true && keys.every((key) => sentKeys.has(key)) &&
          keys.every((key) => Boolean(responseContexts[key])) && Boolean(result.session && result.seq) &&
        result.ack !== "rejected" && !(result.ack === "config_request_accepted" && result.confirmed === true);
      const resultKeys = new Set(keys);
      const latestKeys: string[] = [];
      const supersededKeys: string[] = [];
      const revisions: Record<string, number> = {};
      const values: Record<string, string> = {};
      const contexts: Record<string, LiveContext> = {};
      for (const key of keys) {
        const revision = expectedRevisions[key] ?? stored.persistedRevisions[key] ?? -1;
        const queued = queue.pending.get(key) ?? queue.inFlight.get(key);
        const sentContext = contextForSentKey(result, key, context);
        const exactValue = stored.persistedValues[key] === expectedValues[key];
        const exactRevision = stored.persistedRevisions[key] === revision;
        if (sentContext && exactValue && exactRevision && (!queued || queued.revision <= revision)) {
          latestKeys.push(key);
          revisions[key] = revision;
          values[key] = expectedValues[key];
          contexts[key] = sentContext;
        } else {
          restart.add(key);
          supersededKeys.push(key);
        }
      }

      let livePending = stored.livePending
        .map((entry) => {
          const remaining = entry.keys.filter((key) => {
            const replacementRevision = expectedRevisions[key];
            return !resultKeys.has(key) || replacementRevision === undefined ||
              replacementRevision < (entry.revisions[key] ?? -1);
          });
          return {
            ...entry,
            keys: remaining,
            values: Object.fromEntries(Object.entries(entry.values).filter(([key]) => remaining.includes(key))),
            revisions: Object.fromEntries(Object.entries(entry.revisions).filter(([key]) => remaining.includes(key))),
            contexts: Object.fromEntries(Object.entries(entry.contexts).filter(([key]) => remaining.includes(key))),
          };
        })
        .filter((entry) => entry.keys.length > 0);

      if (unresolved && result.session && result.seq && latestKeys.length > 0) {
        livePending.push({
          target: dir,
          session: result.session,
          seq: result.seq,
          statusEpoch: getTargetLiveStatusRequestEpoch(dir),
          keys: latestKeys,
          values: Object.fromEntries(latestKeys.map((key) => [key, values[key]])),
          revisions: Object.fromEntries(latestKeys.map((key) => [key, revisions[key]])),
          contexts: Object.fromEntries(latestKeys.map((key) => [key, contexts[key]])),
        });
        latestKeys.forEach((key) => restart.delete(key));
      } else {
        for (const key of latestKeys) {
          if (confirmed && result.ack === "config_request_accepted" && resultConfirmed.has(key)) restart.delete(key);
          else restart.add(key);
        }
      }

      const restartKeys = Array.from(restart);
      const deferred = Array.from(new Set([
        ...(result.deferred ?? []).filter((key) => !latestKeys.includes(key)),
        ...restartKeys.filter((key) => !key.startsWith("__")),
        ...supersededKeys,
      ]));
      const live = { ...result, deferred, backend_change: result.backend_change ?? true };
      return { ...stored, restartKeys, livePending, live };
    });
    updateView(identity, (current) => ({
      ...current,
      ...nextRecord,
      dirty: nextRecord.restartKeys.length > 0 || nextRecord.livePending.length > 0,
    }));
  }, [targetDir, getQueue, updateView, identity]);

  const authoritativeReload = useCallback(async () => {
    if (!targetDir || !enabled) return;
    await flushTarget(targetDir, identity, generationAtRender, true);
    await waitForTargetWrites(targetDir);
    if (!isCurrent(identity, generationAtRender)) return;
    forgetWrites(targetDir);
    invalidateTargetReads(targetDir);
    // This caller runs after a known whole-file reset or restore. Any old
    // selection proof belongs to the file that was just replaced, and must no
    // longer authorize a backend switch or let an older ACK clear restart.
    updateTargetLiveRecord(targetDir, (stored) => ({
      ...stored,
      persistedValues: {},
      persistedRevisions: {},
    }));
    await readTarget(targetDir, identity, generationAtRender, true);
  }, [targetDir, enabled, identity, generationAtRender, flushTarget, isCurrent, readTarget]);

  const queueChanges = useCallback(
    (changes: OptionChange[], immediate = false) => {
      if (!targetDir || changes.length === 0 || !enabled) return;
      const queue = getQueue(targetDir);
      const stamp = rememberWrites(targetDir, changes);
      queueTargetChanges(targetDir, changes, stamp);
      updateView(identity, (current) => ({ ...current, error: null }));
      if (queue.timer !== null) window.clearTimeout(queue.timer);
      if (immediate) {
        queue.timer = null;
        void flushTarget(targetDir, identity, generationAtRender).catch(() => undefined);
      } else {
        queue.timer = window.setTimeout(() => {
          queue.timer = null;
          void flushTarget(targetDir, identity, generationAtRender).catch(() => undefined);
        }, FLUSH_DELAY_MS);
      }
    },
    [targetDir, enabled, getQueue, updateView, identity, generationAtRender, flushTarget],
  );

  const setOption = useCallback(
    (option: OptionMeta, value: string, liveContext?: LiveContext) => {
      if (!targetDir || !enabled || view.runtimeCurrent !== true) return;
      updateView(identity, (current) => ({
        ...current,
        values: {
          ...current.values,
          [option.section]: { ...(current.values[option.section] ?? {}), [option.key]: value },
        },
      }));
      queueChanges([{ section: option.section, key: option.key, value, ...(liveContext ? { live_context: liveContext } : {}) }]);
    },
    [targetDir, enabled, view.runtimeCurrent, updateView, identity, queueChanges],
  );

  const setOptions = useCallback(
    async (changes: OptionChange[]): Promise<Record<string, number> | null> => {
      if (changes.length === 0 || !targetDir || !enabled || view.runtimeCurrent !== true) return null;
      updateView(identity, (current) => {
        const values = { ...current.values };
        for (const change of changes) {
          values[change.section] = {
            ...(values[change.section] ?? {}),
            [change.key]: change.value,
          };
        }
        return { ...current, values };
      });
      queueChanges(changes);
      const queue = getQueue(targetDir);
      const revisions: Record<string, number> = {};
      for (const change of changes) {
        const id = changeId(change);
        const queued = queue.pending.get(id) ?? queue.inFlight.get(id);
        if (queued) revisions[id] = queued.revision;
      }
      try {
        await flushTarget(targetDir, identity, generationAtRender, true);
        return revisions;
      } catch {
        return null;
      }
    },
    [targetDir, enabled, view.runtimeCurrent, updateView, identity, queueChanges, getQueue, flushTarget, generationAtRender],
  );

  const enableFsr4 = useCallback(async () => {
    if (!targetDir) throw new Error("Install OptiScaler first.");
    if (view.runtimeCurrent !== true) throw new Error("Upgrade runtime in Setup first.");
    updateView(identity, (current) => ({ ...current, saving: true, error: null }));
    try {
      await flushTarget(targetDir, identity, generationAtRender, true);
      if (!gameContext?.gamePath) throw new Error("Open Setup to preserve this game before changing its FSR build.");
      const preserved = await preserveExistingInstall(targetDir, gameContext.gamePath, gameContext.appid);
      if (!preserved.ok) throw new Error(preserved.error ?? "Could not preserve the previous install.");
      const result = await serializeTargetWrite(targetDir, () => setFsr4Build(targetDir, "4.1.1b"));
      if (!result.ok) throw new Error(result.error ?? "Could not enable FSR 4.1.1b");
      forgetWrites(targetDir);
      await readTarget(targetDir, identity, generationAtRender, true);
      clearTargetLiveActions(targetDir);
      const updatedRecord = getTargetLiveRecord(targetDir);
      updateView(identity, (current) => ({
        ...current,
        ...updatedRecord,
        dirty: false,
      }));
    } finally {
      updateView(identity, (current) => ({ ...current, saving: false }));
    }
  }, [
    targetDir,
    view.runtimeCurrent,
    updateView,
    identity,
    generationAtRender,
    flushTarget,
    readTarget,
    gameContext?.gamePath,
    gameContext?.appid,
  ]);

  const resetSection = useCallback(
    (section: string, bindings?: Record<string, LiveContext>) => {
      if (view.runtimeCurrent !== true) return;
      const options = optionsInSection(section);
      const changes = options.map((option) => {
        const id = `${option.section}.${option.key}`;
        return {
          section: option.section,
          key: option.key,
          value: AUTO,
          ...(bindings?.[id] ? { live_context: bindings[id] } : {}),
        };
      });
      updateView(identity, (current) => {
        const next = { ...(current.values[section] ?? {}) };
        for (const option of options) next[option.key] = AUTO;
        return { ...current, values: { ...current.values, [section]: next } };
      });
      queueChanges(changes);
    },
    [view.runtimeCurrent, identity, updateView, queueChanges],
  );

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Closing a panel or changing its target must not abandon a debounced write.
  useEffect(() => {
    if (!targetDir) return;
    const dir = targetDir;
    const requestIdentity = identity;
    const requestGeneration = generationAtRender;
    return () => {
      const queue = getQueue(dir);
      if (queue.timer !== null) window.clearTimeout(queue.timer);
      queue.timer = null;
      void flushTarget(dir, requestIdentity, requestGeneration).catch(() => undefined);
    };
  }, [targetDir, identity, generationAtRender, getQueue, flushTarget]);

  const clearDirty = useCallback(() => {
    const record = targetDir
      ? updateTargetLiveRecord(targetDir, (stored) => ({ ...stored, restartKeys: [], livePending: [] }))
      : null;
    updateView(identity, (current) => ({
      ...current,
      ...(record ?? {}),
      dirty: false,
    }));
  }, [identity, updateView, targetDir]);
  const markDirty = useCallback(() => {
    const record = targetDir
      ? updateTargetLiveRecord(targetDir, (stored) => ({
          ...stored,
          restartKeys: stored.restartKeys.includes("__unverified__")
            ? stored.restartKeys
            : [...stored.restartKeys, "__unverified__"],
        }))
      : null;
    updateView(identity, (current) => ({
      ...current,
      ...(record ?? {}),
      dirty: true,
    }));
  }, [identity, updateView, targetDir]);
  return {
    values: view.values,
    fsr4Build: view.fsr4Build,
    runtimeCurrent: view.runtimeCurrent,
    enableFsr4,
    loading: view.loading || Boolean(targetDir && enabled && storedView.identity !== identity),
    error: view.error,
    dirty: view.dirty,
    restartRequired: view.restartKeys.length > 0,
    livePending: view.livePending.length > 0,
    saving: view.saving,
    live: view.live,
    setOption,
    setOptions,
    resetSection,
    reload: load,
    flush,
    reconcileLiveStatus,
    recordLiveAction,
    authoritativeReload,
    clearDirty,
    markDirty,
  };
}
