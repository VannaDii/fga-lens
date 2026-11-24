import { sameTuple, tupleKey, type Draft, type InstalledModel, type Target, type Tuple, type TupleIssue } from "./workbench-contract";
import { emptyDraft, publicationConflicts, readYaml, resolveTupleSource, tupleIndex } from "./workbench-drafts";
import { diagnose, OperationFailure, TuplePlanRejection } from "./workbench-errors";
import { modelFingerprint, tupleKeyIssues, tupleModelIssues } from "./workbench-models";
import { endpoint, models, preflightTupleAdditions, publishModel, readModel, readTuples, reserve, savedModel, stores, writeTuple } from "./workbench-server";
import { captureWorkspace, checkpoint, draftKey } from "./workbench-workspace";

/** Apply a publication checkpoint only to the captured draft in the latest workspace. */
function updateDraft(key: string, update: (draft: Draft) => Draft) {
  return checkpoint((state) => ({
    ...state, drafts: { ...state.drafts, [key]: update(state.drafts[key] ?? emptyDraft) },
  }));
}

/** Order model publications for one endpoint and store while captures or writes are active. */
type ModelPublications = {
  /** Highest captured workspace revision admitted while this queue is active. */
  latest: number;
  /** Captures and publications still in flight, including requests that have yet to capture. */
  pending: number;
  /** Resolves after the last admitted publication settles, even if it failed. */
  tail: Promise<void>;
};

/** Single-process queues for workbench model writes, keyed by endpoint and store. */
const modelPublications = new Map<string, ModelPublications>();

/**
 * Publish a saved model in captured order and preserve an intentional historical selection.
 * Capture before waiting so later workspace saves cannot replace the request's source.
 * @param store Store captured at dispatch.
 * @param revision Workspace revision containing the saved model.
 * @param signal Cancellation signal for the publication.
 * @returns The workspace checkpoint after provider completion.
 * @throws A scoped conflict for a stale capture, or the operation's validation or provider failure.
 */
export async function publishSavedModel(store: string, revision: number, signal: AbortSignal) {
  const key = draftKey(store);
  const queue = modelPublications.get(key) ?? { latest: -1, pending: 0, tail: Promise.resolve() };
  modelPublications.set(key, queue);
  queue.pending += 1;
  try {
    const { state } = await captureWorkspace(revision, true);
    const saved = state.drafts[key];
    if (!saved) throw new OperationFailure("invalid input");
    const content = savedModel(saved.dsl);
    if (revision < queue.latest) throw new OperationFailure("conflict");
    queue.latest = revision;
    const publication = queue.tail.then(async () => {
      if (signal.aborted) throw new OperationFailure("cancellation");
      const result = await publishModel(store, content, signal);
      return checkpoint((current) => {
        const latest = current.drafts[key] ?? emptyDraft;
        const followsPublished = !latest.modelManual || latest.modelSelection === saved.published;
        const modelSelection = followsPublished ? result.revision : latest.modelSelection;
        return {
          ...current,
          ...(current.store === store && followsPublished ? { model: result.revision } : {}),
          drafts: { ...current.drafts, [key]: { ...latest, published: result.revision,
            publishedDsl: saved.dsl, modelSelection, modelManual: !followsPublished, modelChecked: Date.now() } },
        };
      });
    });
    queue.tail = publication.then(() => undefined, () => undefined);
    return await publication;
  } finally {
    queue.pending -= 1;
    if (!queue.pending) modelPublications.delete(key);
  }
}

/** Resolve a tuple conflict against the saved YAML without saving the live editor buffer. */
export function resolveTupleConflict(store: string, identity: string, useServer: boolean, revision: number) {
  const key = draftKey(store);
  return checkpoint((state) => {
    const saved = state.drafts[key];
    const conflict = saved?.conflicts.find((entry) => entry.key === identity);
    if (!saved || !conflict) throw new OperationFailure("invalid input");
    const baseline = saved.baseline.filter((entry) => tupleKey(entry) !== identity);
    if (conflict.server) baseline.push(conflict.server);
    const replacement = saved.replacement && tupleKey(saved.replacement.original) === identity
      ? undefined : saved.replacement;
    const journaled = Boolean(saved.replacement && !replacement);
    const yaml = resolveTupleSource(saved.yaml, conflict, useServer, journaled);
    return { ...state, authoredRevision: state.revision + 1, drafts: {
      ...state.drafts, [key]: { ...saved, baseline, replacement, yaml,
        conflicts: saved.conflicts.filter((entry) => entry.key !== identity) },
    } };
  }, revision);
}

/** Determine the explicit edits captured against a saved full baseline. */
function capturedEdits(saved: Draft, records: Tuple[]) {
  const before = tupleIndex(saved.baseline);
  const after = tupleIndex(records);
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((identity) => {
    const prior = before.get(identity) ?? null;
    const desired = after.get(identity) ?? null;
    return sameTuple(prior, desired) ? [] : [{ identity, prior, desired }];
  });
}

/** Capture the source coordinate of a changed row without duplicating its tuple in any diagnostic. */
type PlannedTuple = { value: Tuple; row: NonNullable<TupleIssue["row"]>; operation: "add" | "remove" };

/**
 * Validate all changed keys and the installed model before the first upstream write.
 * Only additions must satisfy the captured model's grant restrictions.
 * @param captured The store and installed revision bound to this attempt.
 * @param plan The changed additions and removals with their diagnostic source coordinates.
 * @param signal The publication cancellation signal.
 * @throws A structured plan rejection for input errors or the underlying operation failure.
 */
async function validateCapturedPlan(captured: Target, plan: PlannedTuple[], signal: AbortSignal) {
  const issues: TupleIssue[] = [];
  const checked = plan.map((entry) => ({ ...entry, keys: tupleKeyIssues(entry.value, entry.operation === "remove") }));
  let model: InstalledModel | undefined;
  try {
    model = await readModel(captured, signal);
  } catch (error) {
    if (!(error instanceof OperationFailure)) throw error;
    if (error.category === "invalid input") issues.push({ reason: "model" });
    else if (signal.aborted || !checked.some(({ keys }) => keys.length)) throw error;
  }
  const supported = model && (model.schema_version === "1.1" || model.schema_version === "1.2");
  if (model && !supported) issues.push({ reason: "schema" });

  for (const { value, row, operation, keys } of checked) {
    const details = operation === "add" && supported && model ? tupleModelIssues(value, model) : [];
    for (const detail of [...keys, ...details.filter(({ reason }) => !keys.some((item) => item.reason === reason))]) {
      issues.push({ ...detail, row, operation });
    }
  }
  if (issues.length) throw new TuplePlanRejection(issues);

  const additions = plan.filter((entry) => entry.operation === "add");
  const rejected = await preflightTupleAdditions(captured, additions.map(({ value }) => value), signal);
  for (const { index, reason } of rejected) {
    issues.push({ reason, operation: "add", ...(index !== undefined ? { row: additions[index].row } : {}) });
  }
  if (issues.length) throw new TuplePlanRejection(issues);
}

/** Publish only captured edits, journaling condition replacements before their first write. */
export async function publishTuples(target: Target, revision: number, signal: AbortSignal) {
  const key = draftKey(target.store);
  return reserve(target.store, "publish", async () => {
    const { state } = await captureWorkspace(revision);
    const saved = state.drafts[key];
    if (!saved) throw new OperationFailure("invalid input");
    if (publicationConflicts(saved)) throw new OperationFailure("conflict");
    const interrupted = saved.replacement;
    const captured = interrupted?.target ?? target;
    if (captured.store !== target.store) throw new OperationFailure("invalid input");
    const local = interrupted ? null : readYaml(saved.yaml);
    if (!interrupted && !local) throw new TuplePlanRejection([{ reason: "yaml" }]);
    const changes = interrupted
      ? [{ identity: tupleKey(interrupted.original), prior: interrupted.original, desired: interrupted.desired }]
      : capturedEdits(saved, local ?? []);
    const draftRows = new Map((local ?? []).map((value, index) => [tupleKey(value), index]));
    const baselineRows = new Map(saved.baseline.map((value, index) => [tupleKey(value), index]));
    const planned = changes.map(({ identity, prior, desired }) => {
      /** Record which saved snapshot owns the tuple about to be checked. */
      function reference(value: Tuple, operation: "add" | "remove", index: number | undefined): PlannedTuple {
        if (interrupted) return { value, operation, row: { source: "journal", index: operation === "remove" ? 0 : 1 } };
        if (index === undefined) throw new OperationFailure("server error");
        return { value, operation, row: { source: operation === "add" ? "draft" : "baseline", index } };
      }
      return {
        identity,
        prior: prior && reference(prior, "remove", baselineRows.get(identity)),
        desired: desired && reference(desired, "add", draftRows.get(identity)),
      };
    });
    await validateCapturedPlan(captured, planned.flatMap(({ prior, desired }) =>
      [...(prior ? [prior] : []), ...(desired ? [desired] : [])]), signal);

    let completed = 0;
    let active: PlannedTuple | null = null;
    let phase: "reread" | "write" = "reread";
    const started = performance.now();
    try {
      for (const { identity, prior: removal, desired: addition } of planned) {
        active = removal ?? addition;
        phase = "reread";
        const prior = removal?.value ?? null;
        const desired = addition?.value ?? null;
        const tuple = prior ?? desired;
        if (!tuple) throw new OperationFailure("invalid input");
        const { user, relation, object } = tuple;
        const observed = (await readTuples(captured.store, signal, { user, relation, object }))
          .find((entry) => tupleKey(entry) === identity) ?? null;
        if (!sameTuple(observed, desired)) {
          if (!sameTuple(observed, prior) && !(interrupted && observed === null)) {
            await updateDraft(key, (current) => ({
              ...current, conflicts: [
                ...current.conflicts.filter((entry) => entry.key !== identity), { key: identity, local: desired, server: observed },
              ],
            }));
            throw new OperationFailure("conflict");
          }
          if (observed && desired && !interrupted) {
            await updateDraft(key, (current) => ({
              ...current, replacement: { target: captured, original: observed, desired },
            }));
          }
          if (observed) {
            active = removal;
            phase = "write";
            await writeTuple(captured, observed, true, signal);
          }
          if (desired) {
            active = addition;
            phase = "write";
            await writeTuple(captured, desired, false, signal);
          }
        }
        active = null;
        completed += 1;
        await updateDraft(key, (current) => ({
          ...current, replacement: undefined, tuplesChecked: Date.now(),
          baseline: [...current.baseline.filter((entry) => tupleKey(entry) !== identity), ...(desired ? [desired] : [])],
        }));
      }
      return await updateDraft(key, (current) => ({ ...current, tupleCompleted: completed, tuplePending: changes.length - completed }));
    } catch (error) {
      const view = await updateDraft(key, (current) => ({
        ...current, tupleCompleted: completed, tuplePending: changes.length - completed,
      }));
      const partial = view.state.drafts[key]?.replacement || completed > 0;
      const classified = error instanceof OperationFailure ? error : null;
      return { ...view, failure: diagnose(partial && classified?.category !== "conflict"
        ? new OperationFailure("partial publication") : classified, started),
        ...(classified?.category === "invalid input" && active ? { tupleProblem: {
          phase, issue: { reason: "engine", row: active.row, operation: active.operation },
        } } : {}),
      };
    }
  });
}

/** Suggest a published source only when complete model content matches one installed target. */
export async function suggestModel(dsl: string, signal: AbortSignal) {
  if (!endpoint()) return { match: null };
  const content = savedModel(dsl);
  const fingerprint = modelFingerprint(content);
  let match: Target | null = null;
  for (const store of (await stores(signal)).stores) {
    for (const model of (await models(store.id, signal)).authorization_models) {
      if (modelFingerprint(model) !== fingerprint) continue;
      if (match) return { match: null };
      match = { store: store.id, revision: model.id };
    }
  }
  return { match };
}
