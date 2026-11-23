"use client";

import { useCallback, useRef, useState } from "react";
import { workspaceView, type Workspace, type WorkspaceView } from "@/lib/workbench-contract";
import { emptyWorkspace } from "@/lib/workbench-drafts";
import { invoke } from "./workbench-ui";

/** Hold unsaved UI data separately from the last acknowledged workspace revision. */
export function useWorkbenchState() {
  const [state, setState] = useState(emptyWorkspace);
  const current = useRef(state);
  const durable = useRef(emptyWorkspace);
  const saveQueue = useRef(Promise.resolve());
  const checkpoints = useRef(new Set<Promise<void>>());

  /** Update the local view synchronously for consecutive editor events. */
  const change = useCallback((update: (state: Workspace) => Workspace) => {
    current.current = update(current.current);
    setState(current.current);
  }, []);

  /** Accept a server checkpoint without replacing newer input or regressing the revision. */
  const accept = useCallback((
    receipt: WorkspaceView,
    merge?: (local: Workspace, confirmed: Workspace) => Workspace,
    serverCheckpoint = false,
  ) => {
    if (receipt.state.revision < durable.current.revision) return;
    if (serverCheckpoint && receipt.state.authoredRevision !== durable.current.authoredRevision) return;
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

  /** Send a local patch, retrying only after a known server-only checkpoint from this tab. */
  const persist = useCallback((update: (prior: Workspace) => Workspace) => {
    const next = saveQueue.current.then(async () => {
      const prior = durable.current;
      const commit = (base: Workspace) => invoke(workspaceView, { action: "save", state: update(base) });
      const receipt = await commit(prior).catch(async (error: Error) => {
        if (!error.message.startsWith("conflict")) throw error;
        await Promise.all([...checkpoints.current]);
        const latest = durable.current;
        if (latest.revision <= prior.revision || latest.authoredRevision !== prior.authoredRevision) throw error;
        return commit(latest);
      });
      accept(receipt);
      return receipt.state;
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
