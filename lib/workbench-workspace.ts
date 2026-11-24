import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decode, workspace, type Workspace } from "./workbench-contract";
import { emptyWorkspace } from "./workbench-drafts";
import { OperationFailure } from "./workbench-errors";
import { endpoint } from "./workbench-server";

/** Workspace files on one filesystem allow a same-directory atomic replacement. */
const directory = resolve(/* turbopackIgnore: true */ process.env.FGA_WORKSPACE_DIR ?? ".fga-workspace");
const original = resolve(directory, "workspace.json");
const recovery = resolve(directory, "workspace.recovery.json");
const backup = resolve(directory, "workspace.recovery.backup.json");
let workspaceQueue = Promise.resolve();

/**
 * Read a snapshot without replacing malformed UTF-8 or treating read failures as corruption.
 * @param path The original workspace, recovery file, or backup.
 * @returns Whether the file was found and its validated state if readable.
 * @throws Filesystem errors other than a missing file.
 */
async function readWorkspaceFile(path: string) {
  try {
    const bytes = await readFile(path);
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { found: true, state: decode(workspace, JSON.parse(text)) };
    } catch { return { found: true, state: null }; }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { found: false, state: null };
    throw error;
  }
}

/** Expose the active state and retain the original path for recoverable corruption. */
export async function readWorkspace() {
  const saved = await readWorkspaceFile(original);
  const damaged = saved.found && !saved.state;
  const recoveryFile = damaged ? await readWorkspaceFile(recovery) : saved;
  const active = damaged && recoveryFile.found && !recoveryFile.state
    ? await readWorkspaceFile(backup) : recoveryFile;
  const connection = endpoint();
  const state = active.state ?? emptyWorkspace;
  const store = state.selections?.["primary-store/" + connection] ?? "";
  return {
    state: state.connection === connection ? state : { ...state, connection, store,
      model: state.drafts[connection + "/" + store]?.modelSelection ?? "" },
    endpoint: connection, location: original, recovery: damaged,
  };
}

/** Serve the original damaged bytes using an explicit same-origin download. */
export async function downloadRecovery() {
  if (!(await readWorkspace()).recovery) throw new OperationFailure("missing target");
  return new Response(new Uint8Array(await readFile(original)), {
    headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=workspace.json", "cache-control": "private, no-store" },
  });
}

/** Check the dispatch revision without silently moving a stale tab onto another snapshot. */
export async function captureWorkspace(revision: number) {
  const view = await readWorkspace();
  if (view.state.revision !== revision) throw new OperationFailure("conflict");
  return view;
}

/** Update local editor state while retaining server-owned fixture and recovery bindings. */
export function saveWorkspace(next: Workspace) {
  return checkpoint((current) => {
    const ids = new Set(next.batches.map((batch) => batch.id));
    if (ids.size !== next.batches.length) throw new OperationFailure("invalid input");
    const installations = new Map(current.batches.map((batch) => [batch.id, batch.installations]));
    return {
      ...next, authoredRevision: current.revision + 1, connection: current.connection, report: current.report,
      batches: next.batches.map((batch) => ({ ...batch, installations: installations.get(batch.id) })),
      drafts: Object.fromEntries(Object.entries(next.drafts).map(([key, draft]) => [
        key, {
          ...draft, published: current.drafts[key]?.published, publishedDsl: current.drafts[key]?.publishedDsl,
          modelChecked: current.drafts[key]?.modelChecked, replacement: current.drafts[key]?.replacement,
          tupleCompleted: current.drafts[key]?.tupleCompleted, tuplePending: current.drafts[key]?.tuplePending,
        },
      ])),
    };
  }, next.revision);
}

/** Scope local edits to the configured connection and store, without using credentials. */
export function draftKey(store: string) {
  return endpoint() + "/" + store;
}

/** Serialize writes and checkpoint server operations against the newest persisted input. */
export function checkpoint(update: (state: Workspace) => Workspace, expectedRevision?: number) {
  const action = workspaceQueue.then(async () => {
    const current = expectedRevision === undefined ? await readWorkspace() : await captureWorkspace(expectedRevision);
    const state = { ...update(current.state), revision: current.state.revision + 1 };
    const repaired = current.recovery ? await readWorkspaceFile(recovery) : null;
    const path = repaired ? repaired.found && !repaired.state ? backup : recovery : original;
    await persistState(state, path);
    return { ...current, state };
  });
  workspaceQueue = action.then(() => undefined, () => undefined);
  return action;
}

/** Create a private snapshot and replace the active file atomically. */
async function persistState(state: Workspace, path: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
