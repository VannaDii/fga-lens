import * as t from "io-ts";

import { decode, engineId, outcome, query, target, workspace, workspaceRevision } from "@/lib/workbench-contract";
import { explain } from "@/lib/workbench-evidence";
import { diagnose, OperationFailure, TuplePlanRejection } from "@/lib/workbench-errors";
import { cancelJob, jobProgress, runJob } from "@/lib/workbench-jobs";
import { publishSavedModel, publishTuples, resolveTupleConflict, suggestModel } from "@/lib/workbench-publish";
import { installFixture, runBatch } from "@/lib/workbench-regression";
import { createStore, models, readTuples, runQuery, stores } from "@/lib/workbench-server";
import { captureWorkspace, checkpoint, downloadRecovery, readWorkspace, saveWorkspace } from "@/lib/workbench-workspace";

/** App commands decode at the server boundary before any workspace or engine access. */
const revision = workspaceRevision;
const command = t.union([
  t.type({ action: t.literal("save"), state: workspace }),
  t.type({ action: t.literal("stores") }),
  t.type({ action: t.literal("create"), name: t.string }),
  t.type({ action: t.literal("models"), store: engineId }),
  t.type({ action: t.literal("publish-model"), store: engineId, revision }),
  t.type({ action: t.literal("fetch-tuples"), store: engineId, job: t.string }),
  t.type({ action: t.literal("publish-tuples"), target, revision }),
  t.type({ action: t.literal("resolve-tuple"), store: engineId, identity: t.string, useServer: t.boolean, revision }),
  t.type({ action: t.literal("query"), target, input: query }),
  t.intersection([t.type({ action: t.literal("evidence"), target, input: query, outcome, job: t.string }),
    t.partial({ selected: t.string })]),
  t.type({ action: t.literal("suggest-model"), dsl: t.string }),
  t.type({ action: t.literal("fixture"), source: target, batchId: t.string, revision }),
  t.type({ action: t.literal("batch"), batchId: t.string, cases: t.array(t.string), job: t.string, revision }),
  t.type({ action: t.literal("progress"), job: t.string }),
  t.type({ action: t.literal("cancel"), job: t.string }),
]);

/** Validate the local listener and browser context before reading private data or mutating it. */
function assertLocal(request: Request, requireOrigin: boolean) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const listener = new URL(request.url);
  const host = request.headers.get("host") ?? listener.host;
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host);
  if (!local) throw new OperationFailure("invalid input");
  const expected = URL.parse(listener.protocol + "//" + host);
  const crossSite = site === "cross-site" || site === "same-site";
  if (!expected || crossSite || (origin ? origin !== expected.origin : requireOrigin)) {
    throw new OperationFailure("invalid input");
  }
}

/** Emit the safe failure and only application-generated hints for a rejected tuple plan. */
function errorResponse(error: OperationFailure | null, started: number) {
  const diagnostic = diagnose(error, started);
  const status = ({
    "invalid input": 400, "missing target": 404, authentication: 401, connection: 502,
    timeout: 504, "server error": 502, conflict: 409, "partial publication": 409,
    cancellation: 409, "Batch running": 409,
  })[diagnostic.error];
  return Response.json(error instanceof TuplePlanRejection ? { ...diagnostic, tupleIssues: error.issues } : diagnostic, { status });
}

/** Load workspace state or explicitly download the damaged original. */
export async function GET(request: Request) {
  const started = performance.now();
  try {
    assertLocal(request, false);
    if (new URL(request.url).searchParams.has("recovery")) return await downloadRecovery();
    return Response.json(await readWorkspace(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error instanceof OperationFailure ? error : null, started);
  }
}

/** Decode and dispatch a same-origin workbench request. */
export async function POST(request: Request) {
  const started = performance.now();
  try {
    assertLocal(request, true);
    const input = decode(command, await request.json().catch(() => null));
    if (!input) throw new OperationFailure("invalid input");
    const { signal } = request;
    switch (input.action) {
      case "save": return Response.json(await saveWorkspace(input.state));
      case "stores": return Response.json(await stores(signal));
      case "create": return Response.json(await createStore(input.name, signal));
      case "models": return Response.json(await models(input.store, signal));
      case "publish-model": return Response.json(await publishSavedModel(input.store, input.revision, signal));
      case "fetch-tuples": {
        const tuples = await runJob(input.job, signal, (job, bounded) => readTuples(input.store, bounded, undefined, () => {
          job.completed += 1;
        }));
        return Response.json({ tuples });
      }
      case "publish-tuples": return Response.json(await publishTuples(input.target, input.revision, signal));
      case "resolve-tuple":
        return Response.json(await resolveTupleConflict(input.store, input.identity, input.useServer, input.revision));
      case "query": return Response.json(await runQuery(input.target, input.input, signal));
      case "evidence": return Response.json(await runJob(input.job, signal, (job, bounded) =>
        explain(input.target, input.input, input.outcome, bounded, () => { job.completed += 1; }, input.selected)));
      case "suggest-model": return Response.json(await suggestModel(input.dsl, signal));
      case "fixture": return Response.json(await installFixture(input.batchId, input.source, input.revision, signal));
      case "batch": return Response.json(await runJob(input.job, signal, async (job, bounded) => {
        const { state } = await captureWorkspace(input.revision);
        const batch = state.batches.find((entry) => entry.id === input.batchId);
        if (!batch) throw new OperationFailure("invalid input");
        job.total = input.cases.length;
        const report = await runBatch(batch, input.cases, bounded, () => job.cancelled, () => { job.completed += 1; }, (active) => { job.activeCase = active; });
        return checkpoint((prior) => ({ ...prior, report }));
      }));
      case "progress": return Response.json(jobProgress(input.job));
      case "cancel": return Response.json(cancelJob(input.job));
    }
  } catch (error) {
    return errorResponse(error instanceof OperationFailure ? error : null, started);
  }
}
