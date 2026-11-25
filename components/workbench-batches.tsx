"use client";

import { useEffect, useState } from "react";
import * as t from "io-ts";

import { exportBatch, importBatch } from "@/lib/workbench-batches";
import { decode, modelsResponse, mutationResult, target as targetCodec, type Batch, type InstalledModel,
  type Target, type Workspace, type WorkspaceView,
} from "@/lib/workbench-contract";
import { Dialog, download, failureText, invoke, JobStatus, revisionOptions, Select } from "./workbench-ui";

/** Show the workspace's authored regression batches and isolated fixture targets. */
export function BatchScreen({ state, target, stores, endpoint, remember, add, savedRevision, trackCheckpoint, apply }: {
  state: Workspace; target: Target; stores: Array<{ id: string; name: string }>; endpoint: string;
  remember: (value: Record<string, string>) => void; add: (batch: Batch) => Promise<void>;
  savedRevision: () => Promise<number>; apply: (receipt: WorkspaceView) => void;
  /** Register the request through receipt application so overlapping preference saves can retry. */
  trackCheckpoint: <A>(operation: Promise<A>) => Promise<A>;
}) {
  const active = state.batches.find((batch) => batch.id === state.selections?.batch) ?? state.batches[0];
  const installation = active?.installations?.[endpoint];
  const known = installation?.source;
  const storeKey = "batch-source-store/" + endpoint + "/" + active?.id;
  const modelKey = "batch-source-model/" + endpoint + "/" + active?.id;
  const selectionKey = "batch-cases/" + active?.id;
  const store = state.selections?.[storeKey] ?? known?.store ?? target.store;
  const revision = state.selections?.[modelKey] ?? known?.revision ?? (store === target.store ? target.revision : "");
  const [models, setModels] = useState<{ store: string; rows: InstalledModel[] }>({ store: "", rows: [] });
  const [suggestion, setSuggestion] = useState<{ batchId: string; target: Target } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [split, setSplit] = useState(false);
  const [pending, setPending] = useState("");
  const [job, setJob] = useState("");
  const [message, setMessage] = useState("");
  const modelRows = models.store === store ? models.rows : [];
  const selected = chooseCases(state.selections?.[selectionKey], active);
  const installed = modelRows.some((model) => model.id === revision);
  const fixture = installation?.fixture;
  const staged = fixture && known?.store === store && known.revision === revision && installed;
  const report = active?.id === state.report?.batchId && endpoint === state.report?.connection ? state.report : undefined;
  const rows = report?.rows ?? [];
  const focusedBatch = active?.id;

  /** Read revisions for the current source store, ignoring prior selector requests. */
  useEffect(() => {
    if (!store) return;
    let live = true;
    void invoke(modelsResponse, { action: "models", store }).then((result) => {
      if (live) setModels({ store, rows: result.authorization_models });
    }).catch((error) => { if (live) setMessage("Load source revisions · " + error.message); });
    return () => { live = false; };
  }, [store]);

  /** Offer uniquely matching imported model content as an optional source. */
  const importedDsl = active?.model;
  useEffect(() => {
    if (!focusedBatch || !importedDsl || installed || !stores.length) return;
    const controller = new AbortController();
    void invoke(t.type({ match: t.union([targetCodec, t.null]) }), {
      action: "suggest-model", dsl: importedDsl,
    }, controller.signal).then(({ match }) => {
      if (match) setSuggestion({ batchId: focusedBatch, target: match });
    }).catch((error) => {
      if (!controller.signal.aborted) setMessage("Find published model · " + error.message);
    });
    return () => controller.abort();
  }, [focusedBatch, importedDsl, installed, stores.length]);

  /**
   * Preserve fixture sync on errors and retain the captured source and run report on success.
   * Register the mutation only after waiting for prior saves so retries cannot wait in a cycle.
   * @param kind Whether to install the captured fixture or run the captured cases.
   */
  async function execute(kind: "fixture" | "batch") {
    if (!active) return;
    setPending(kind);
    setMessage("");
    try {
      const workspaceRevision = await savedRevision();
      const id = crypto.randomUUID();
      if (kind === "batch") setJob(id);
      const receipt = await trackCheckpoint(invoke(mutationResult, kind === "fixture"
        ? { action: kind, source: { store, revision }, batchId: active.id, revision: workspaceRevision }
        : { action: kind, batchId: active.id, cases: selected, job: id, revision: workspaceRevision })
        .then((receipt) => {
          apply(receipt);
          return receipt;
        }));
      if (receipt.failure) setMessage("Publish fixture · " + failureText(receipt.failure) + " · Publish fixture again");
    } catch (error) {
      const label = kind === "batch" ? "Run selected" : "Publish fixture";
      setMessage(label + " · " + (error instanceof Error ? error.message : "server error") + " · Check the installed target and fixture");
    } finally {
      setPending("");
      setJob("");
    }
  }

  /** Read one import selection and retain the author's supplied file names in any validation error. */
  async function importFiles(files: File[]) {
    setMessage("");
    try {
      const imported = await importBatch(files);
      await add(imported);
      remember({ batch: imported.id });
      setImporting(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invalid batch");
    }
  }

  const offered = !installed && suggestion?.batchId === active?.id ? suggestion?.target : undefined;
  return <main className="wb-split wb-batches">
    <section className="wb-pane" aria-label="Saved batches">
      <header className="wb-pane-heading"><h1>Batches</h1><button onClick={() => { setMessage(""); setImporting(true); }}>Import</button></header>
      <div className="wb-list">{state.batches.map((batch) => <button key={batch.id}
        aria-pressed={batch.id === active?.id} onClick={() => { setMessage(""); remember({ batch: batch.id }); }}>{batch.name}</button>)}</div>
    </section>
    <section className="wb-pane" aria-label="Selected batch">
      <header className="wb-pane-heading"><h2>{active?.name ?? "Fixture"}</h2>
        <button disabled={!active} onClick={() => { setSplit(false); setExporting(true); }}>Export</button>
      </header>
      <div className="wb-actions">
        <Select label="Source store" value={store} options={stores.map((entry) => ({ value: entry.id, label: entry.name }))}
          change={(store) => remember({ [storeKey]: store, [modelKey]: "" })} />
        <Select label="Source model revision" value={revision} options={revisionOptions(modelRows)} title={revision || undefined}
          change={(revision) => remember({ [modelKey]: revision })} />
        {offered && <button onClick={() => remember({ [storeKey]: offered.store, [modelKey]: offered.revision })}>
          Use matching published model
        </button>}
        <button disabled={!active || !installed || Boolean(pending)} onClick={() => execute("fixture")}>Publish fixture</button>
        <button disabled={!staged || !selected.length || Boolean(pending)} onClick={() => execute("batch")}>Run selected</button>
      </div>
      {job ? <JobStatus key={job} id={job} label="Running selected cases" unit="cases" />
        : <p role="status">{pending ? "Publishing fixture…" : staged && !message ? "Fixture staged" : "Fixture needs verification"}</p>}
      {message && !importing && <p role="status">{message}</p>}
      {active && <>
        <dl><dt>Source model</dt><dd>{known ? known.store + " · " + known.revision : "Unstaged"}</dd>
          <dt>Actual fixture</dt><dd>{fixture ? fixture.store + " · " + fixture.revision : installation?.store ?? "Unstaged"}</dd></dl>
        <div className="wb-actions"><h3>Cases</h3><label><input type="checkbox" checked={active.cases.length === selected.length}
          onChange={(event) => remember({ [selectionKey]: JSON.stringify(event.target.checked ? active.cases.map((entry) => entry.id) : []) })} />
          Select all</label></div>
        {active.cases.map((entry, index) => <label key={entry.id}><input type="checkbox" checked={selected.includes(entry.id)}
          onChange={(event) => remember({ [selectionKey]: JSON.stringify(event.target.checked
            ? [...selected, entry.id] : selected.filter((id) => id !== entry.id)) })} />
          {index + 1}. {entry.name} · {rows.some((row) => row.caseId === entry.id) ? "Results below" : "Not run"}
        </label>)}
        {report && <><h3>Last run</h3>
          <p>Source {report.source.store} · {report.source.revision}</p>
          <p>Fixture {report.fixture.store} · {report.fixture.revision}</p>
          <p>Higher consistency · {(["pass", "fail", "error", "unrun"] as const)
            .map((status) => status + " " + rows.filter((row) => row.status === status).length).join(" · ")}</p>
          <div className="wb-table"><table><thead><tr><th>Case</th><th>Operation</th><th>Expected</th><th>Actual</th><th>Result</th><th>Time</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={index}><td>Case {row.caseIndex + 1} · {row.name}</td>
              <td>{row.operation}{row.input && " · " + row.input.relation}
                {row.input && <details><summary>Assertion {(row.assertionIndex ?? 0) + 1} request</summary>
                  <pre>{JSON.stringify(row.input, null, 2)}</pre></details>}
              </td>
              <td>{JSON.stringify(row.expected)}</td><td>{row.actual === null ? "—" : JSON.stringify(row.actual)}</td>
              <td>{row.status}{row.failure && " · " + failureText(row.failure)}</td><td>{row.elapsed.toFixed(1)} ms</td></tr>)}</tbody></table></div></>}
      </>}
    </section>
    {importing && <Dialog title="Import batch" close={() => setImporting(false)}>
      <label>Batch and companion files<input type="file" multiple onChange={(event) => {
        void importFiles(Array.from(event.target.files ?? []));
      }} /></label>
      <label>Folder containing batch and companions<input type="file" multiple ref={(input) => {
        input?.setAttribute("webkitdirectory", "");
      }} onChange={(event) => {
        void importFiles(Array.from(event.target.files ?? []));
      }} /></label>
      {message && <p role="status">{message}</p>}
    </Dialog>}
    {exporting && active && <Dialog title="Export batch" close={() => setExporting(false)}>
      <label><input type="checkbox" checked={split} onChange={(event) => setSplit(event.target.checked)} /> CLI compatible</label>
      {exportBatch(active, split).map((file) => <button key={file.name} onClick={() => download(file.name, file.content)}>
        Download {file.name}
      </button>)}
    </Dialog>}
  </main>;
}

/** Decode a remembered case checklist and retain only currently authored case IDs. */
function chooseCases(saved: string | undefined, batch: Batch | undefined) {
  if (!batch) return [];
  if (saved !== undefined) {
    try {
      const values = decode(t.array(t.string), JSON.parse(saved));
      if (values) return batch.cases.filter((entry) => values.includes(entry.id)).map((entry) => entry.id);
    } catch { /* Ignore an invalid preference and restore the default checklist. */ }
  }
  return batch.cases.map((entry) => entry.id);
}
