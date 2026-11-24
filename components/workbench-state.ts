"use client";

import { useCallback, useRef, useState } from "react";
import { workspaceView, type Workspace, type WorkspaceView } from "@/lib/workbench-contract";
import { emptyWorkspace } from "@/lib/workbench-drafts";
import { invoke } from "./workbench-ui";

/** Merge operation-owned fields into the latest live buffer. */
type WorkspaceMerge = (local: Workspace, confirmed: Workspace) => Workspace;

/** Hold a checkpoint until the in-flight Save proves which authored revision belongs to this tab. */
type DeferredCheckpoint = { receipt: WorkspaceView; merge?: WorkspaceMerge };

/** Hold unsaved UI data separately from the last acknowledged workspace revision. */
export function useWorkbenchState() {
  const [state, setState] = useState(emptyWorkspace);
  const current = useRef(state);
  const durable = useRef(emptyWorkspace);
  const saveQueue = useRef(Promise.resolve());
  const checkpoints = useRef(new Set<Promise<void>>());
  const pendingSave = useRef<DeferredCheckpoint[] | null>(null);

  /** Update the local view synchronously for consecutive editor events. */
  const change = useCallback((update: (state: Workspace) => Workspace) => {
    current.current = update(current.current);
    setState(current.current);
  }, []);

  /**
   * Accept a server checkpoint without replacing newer input or regressing the revision.
   * A checkpoint that might follow our in-flight Save is deferred without waiting for its reply.
   * @param receipt The decoded workspace returned by an operation.
   * @param merge Merge only the fields owned by that operation.
   * @param serverCheckpoint Whether the receipt must match this tab's acknowledged authored revision.
   */
  const accept = useCallback((
    receipt: WorkspaceView,
    merge?: WorkspaceMerge,
    serverCheckpoint = false,
  ) => {
    if (receipt.state.revision < durable.current.revision) return;
    const authored = receipt.state.authoredRevision;
    if (serverCheckpoint && authored !== durable.current.authoredRevision) {
      if (authored !== undefined && authored > durable.current.revision) {
        pendingSave.current?.push({ receipt, merge });
      }
      return;
    }
    durable.current = receipt.state;
    change((local) => ({ ...(merge ? merge(local, receipt.state) : local), revision: receipt.state.revision }));
  }, [change]);

  /** Track acknowledgements already in flight from this tab. */
  const trackCheckpoint = useCallback(<A,>(operation: Promise<A>) => {
    const settled = operation.then(() => undefined, () => undefined);
    checkpoints.current.add(settled);
    void settled.then(() => checkpoints.current.delete(settled));
    return operation;
  }, []);

  /**
   * Retry a local patch only after a known server-only checkpoint from this tab.
   * The successful Save proves ownership of its authored revision and releases matching checkpoints.
   * @param update Reapply the local patch to the acknowledged base if a retry is required.
   * @returns The most recent workspace reconciled with this Save.
   */
  const persist = useCallback((update: (prior: Workspace) => Workspace) => {
    const next = saveQueue.current.then(async () => {
      const prior = durable.current;
      const commit = (base: Workspace) => invoke(workspaceView, { action: "save", state: update(base) });
      const deferred: DeferredCheckpoint[] = [];
      pendingSave.current = deferred;
      try {
        const receipt = await commit(prior).catch(async (error: Error) => {
          if (!error.message.startsWith("conflict")) throw error;
          await Promise.all([...checkpoints.current]);
          const latest = durable.current;
          if (latest.revision <= prior.revision || latest.authoredRevision !== prior.authoredRevision) throw error;
          return commit(latest);
        });
        pendingSave.current = null;
        accept(receipt);
        deferred.sort((left, right) => left.receipt.state.revision - right.receipt.state.revision);
        for (const { receipt: checkpoint, merge } of deferred) {
          if (checkpoint.state.authoredRevision === receipt.state.authoredRevision
            && checkpoint.endpoint === receipt.endpoint && checkpoint.location === receipt.location) {
            accept(checkpoint, merge, true);
          }
        }
        return durable.current;
      } finally {
        pendingSave.current = null;
      }
    });
    saveQueue.current = next.then(() => undefined, () => undefined);
    return next;
  }, [accept]);

  /** Capture the prior local-save queue and get its acknowledged workspace revision. */
  const savedRevision = useCallback(async () => {
    await saveQueue.current;
    return durable.current.revision;
  }, []);

  return { state, current, change, accept, persist, savedRevision, trackCheckpoint, durable };
}
