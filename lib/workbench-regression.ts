import type { Batch, BatchReport, Target } from "./workbench-contract";
import { diagnose, OperationFailure } from "./workbench-errors";
import { modelFingerprint } from "./workbench-models";
import { createStore, endpoint, publishModel, readModel, readStore, reserve, runQuery, stageFixture, verifyFixture } from "./workbench-server";
import { captureWorkspace, checkpoint } from "./workbench-workspace";

/** One staging workflow at a time can allocate or reuse the owned store for a given batch. */
const staging = new Set<string>();

/** Install source content and reconcile shared tuples only within the workbench-owned store. */
export async function installFixture(batchId: string, source: Target, revision: number, signal: AbortSignal) {
  const connection = endpoint();
  const key = connection + "/" + batchId;
  if (staging.has(key)) throw new OperationFailure("conflict");
  staging.add(key);
  const started = performance.now();
  try {
    const { state } = await captureWorkspace(revision);
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new OperationFailure("invalid input");
    const { id, ...content } = await readModel(source, signal);
    const previous = batch.installations?.[connection]?.store;
    const existing = previous ? await readStore(previous, signal).catch((error) => {
      if (error instanceof OperationFailure && error.category === "missing target") return null;
      throw error;
    }) : null;
    const store = existing?.id ?? (await createStore("FGA Playground regression fixture", signal)).id;

    /** Bind owned-store and installation changes to the batch and endpoint captured earlier. */
    const record = (fixture?: Target) => checkpoint((state) => ({
      ...state, batches: state.batches.map((entry) => entry.id === batchId ? {
        ...entry, installations: { ...entry.installations, [connection]: {
          store, source: { store: source.store, revision: id }, fixture,
        } },
      } : entry),
    }));
    return await reserve(store, "publish", async () => {
      await record();
      try {
        const fixture = { store, revision: (await publishModel(store, content, signal)).revision };
        await stageFixture(fixture, batch.tuples, signal);
        return await record(fixture);
      } catch (error) {
        return { ...await record(), failure: diagnose(error instanceof OperationFailure ? error : null, started) };
      }
    });
  } finally {
    staging.delete(key);
  }
}

/** Compare exact boolean decisions and full identifier sets, independent of list ordering. */
function matches(expected: boolean | string[], actual: boolean | string[]) {
  if (typeof expected === "boolean" || typeof actual === "boolean") return expected === actual;
  return JSON.stringify([...new Set(expected)].sort()) === JSON.stringify([...new Set(actual)].sort());
}

/** Run captured cases under the store reservation, preserving shared tuples and case-scoped overlays. */
export async function runBatch(
  batch: Batch, selectedIds: string[], signal: AbortSignal, stop: () => boolean, advance: () => void, setActiveCase: (active: boolean) => void,
): Promise<BatchReport> {
  const connection = endpoint();
  const { source, fixture } = batch.installations?.[connection] ?? {};
  if (!source || !fixture) throw new OperationFailure("missing target");
  const selected = new Set(selectedIds);
  const cases = batch.cases.flatMap((entry, caseIndex) => selected.has(entry.id) ? [{ entry, caseIndex }] : []);
  if (!cases.length || cases.length !== selected.size) throw new OperationFailure("invalid input");
  return reserve(fixture.store, "batch", async () => {
    try {
      await readStore(fixture.store, signal);
      const sourceModel = await readModel(source, signal);
      const fixtureModel = await verifyFixture(fixture, batch.tuples, signal);
      if (modelFingerprint(sourceModel) !== modelFingerprint(fixtureModel)) throw new OperationFailure("conflict");
    } catch (error) {
      if (!stop() || !(error instanceof OperationFailure) || error.category !== "cancellation") throw error;
    }
    const rows: BatchReport["rows"] = [];
    for (const { entry, caseIndex } of cases) {
      const unrun = stop();
      setActiveCase(!unrun);
      for (const [assertionIndex, { expected, input }] of entry.assertions.entries()) {
        const request = { ...input, tuples: entry.tuples, consistent: true };
        const row = { caseId: entry.id, caseIndex, name: entry.name, operation: input.operation, expected,
          assertionIndex, input: request };
        if (unrun) {
          rows.push({ ...row, status: "unrun", actual: null, elapsed: 0 });
          continue;
        }
        const started = performance.now();
        try {
          const found = await runQuery(fixture, request, signal);
          rows.push({ ...row, status: matches(expected, found.outcome) ? "pass" : "fail",
            actual: found.outcome, elapsed: found.elapsed });
        } catch (error) {
          rows.push({ ...row, status: "error", actual: null, elapsed: performance.now() - started,
            failure: diagnose(error instanceof OperationFailure ? error : null, started) });
        }
      }
      setActiveCase(false);
      if (!unrun) advance();
    }
    return { batchId: batch.id, connection, source, fixture, rows };
  });
}
