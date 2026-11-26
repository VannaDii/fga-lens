"use client";

import { useState } from "react";
import type { BatchReport, Target } from "@/lib/workbench-contract";
import { queryPath, queryRequest } from "@/lib/workbench-query-request";
import { JsonBlock } from "./workbench-source-syntax";
import { Disclosure, failureText } from "./workbench-ui";

type Row = BatchReport["rows"][number];
type Status = Row["status"];
const statuses = {
  pass: { label: "Passed", count: "passed", tone: "allowed" },
  fail: { label: "Failed", count: "failed", tone: "denied" },
  error: { label: "Error", count: "errors", tone: "denied" },
  unrun: { label: "Unrun", count: "unrun", tone: undefined },
} as const;
const operations: Record<string, string> = { check: "Check", "list-objects": "List objects", "list-users": "List users" };

function StatusCounts({ rows, showZero = false }: { rows: Row[]; showZero?: boolean }) {
  const counts: Record<Status, number> = { pass: 0, fail: 0, error: 0, unrun: 0 };
  for (const row of rows) counts[row.status] += 1;
  return (Object.keys(counts) as Status[]).filter((status) => showZero || counts[status] > 0).map((status) =>
    <span key={status} className="wb-result-tag" data-tone={counts[status] ? statuses[status].tone : undefined}>
      {counts[status]} {status === "error" && counts[status] === 1 ? "error" : statuses[status].count}
    </span>);
}

/** Show both model bindings with explicit labels, including a partially staged fixture. */
export function BatchTargets({ source, fixture, fixtureStore }: { source?: Target; fixture?: Target; fixtureStore?: string }) {
  return <div className="wb-batch-targets">
    {[{ label: "Source model", store: source?.store, revision: source?.revision },
      { label: "Fixture", store: fixture?.store ?? fixtureStore, revision: fixture?.revision }].map(({ label, store, revision }) =>
      <div key={label}>
        <strong>{label}</strong>
        {store ? <dl className="wb-result-fields">
          <div><dt>Store ID</dt><dd><code>{store}</code></dd></div>
          <div><dt>Model revision ID</dt><dd><code>{revision ?? "—"}</code></dd></div>
        </dl> : <p className="wb-result-note">Unstaged</p>}
      </div>)}
  </div>;
}

function outcomeLabel(value: Row["actual"], operation: string) {
  if (typeof value === "boolean") return value ? "Allowed" : "Denied";
  if (!value) return "—";
  const noun = operation === "list-users" ? "user" : "object";
  return `${value.length} ${noun}${value.length === 1 ? "" : "s"}`;
}

function AssertionResult({ row, index, fixture }: { row: Row; index: number; fixture: Target }) {
  const [open, setOpen] = useState(false);
  const { input, status, expected, actual, response, failure } = row;
  const body = open && input ? queryRequest(input, fixture.revision) : null;
  const result = statuses[status];
  const parameters = Object.keys(input?.context ?? {}).length;
  const tuples = input?.tuples?.length ?? 0;
  const contextCounts = [parameters && `${parameters} condition ${parameters === 1 ? "parameter" : "parameters"}`,
    tuples && `${tuples} contextual ${tuples === 1 ? "tuple" : "tuples"}`].filter(Boolean).join(" · ");
  return <Disclosure className="wb-batch-assertion" open={open} onOpenChange={setOpen}
    title={`Assertion ${(row.assertionIndex ?? index) + 1} · ${operations[row.operation] ?? row.operation}`}
    meta={<>
      <span>Expected <strong>{outcomeLabel(expected, row.operation)}</strong></span>
      <span>Actual <strong>{outcomeLabel(actual, row.operation)}</strong></span>
      <span className="wb-result-tag" data-tone={result.tone}>{result.label}</span>
      {status !== "unrun" && <span className="wb-batch-time">{row.elapsed.toFixed(1)} ms</span>}
    </>}
    preview={input && <span className="wb-batch-input">
      {input.operation !== "list-users" && <span>Subject <code>{input.user}</code></span>}
      <span>Relation <code>{input.relation}</code></span>
      {input.operation === "list-objects" ? <span>Object type <code>{input.type}</code></span>
        : <span>Object <code>{input.object}</code></span>}
      {input.operation === "list-users" && <span>User filter <code>{input.filter.type}{input.filter.relation && `#${input.filter.relation}`}</code></span>}
      {contextCounts && <span>{contextCounts}</span>}
    </span>}>
    {open && <div className="wb-batch-payloads">
      <div>
        <h4>{status === "unrun" ? "Planned API request" : status === "error" ? "Request details" : "API request"}</h4>
        {input && body ? <>
          <code className="wb-result-endpoint"><strong>POST</strong> <span>{queryPath(fixture, input)}</span></code>
          <JsonBlock value={body} />
        </> : <p className="wb-result-note">Request data unavailable.</p>}
      </div>
      <div>
        <h4>{response !== undefined ? "JSON response" : actual !== null ? "Saved result" : "Result details"}</h4>
        {response !== undefined || actual !== null ? <JsonBlock value={response !== undefined ? response : actual} />
          : <p className="wb-result-note">{status === "unrun" ? "This assertion did not run."
            : failure ? failureText(failure) : "Response unavailable."}</p>}
      </div>
      {Array.isArray(expected) && <div><h4>Expected identifiers</h4><JsonBlock value={expected} /></div>}
    </div>}
  </Disclosure>;
}

/** Group the immutable run by recorded case ID, even when current case names or definitions have changed. */
export function BatchResults({ report }: { report: BatchReport }) {
  const id = "wb-batch-last-run";
  return <section className="wb-batch-results" aria-labelledby={id}>
    <header><h3 id={id}>Last run</h3><div className="wb-batch-counts"><StatusCounts rows={report.rows} showZero /></div></header>
    <Disclosure title="Run details" meta="Higher consistency">
      <BatchTargets source={report.source} fixture={report.fixture} />
    </Disclosure>
    {[...Map.groupBy(report.rows, (row) => row.caseId)].map(([id, rows]) =>
      <Disclosure key={id} title={`Case ${rows[0].caseIndex + 1} · ${rows[0].name}`} meta={<StatusCounts rows={rows} />}>
        <ul className="wb-batch-result-list" role="list">
          {rows.map((row, index) => <li key={row.assertionIndex ?? index}>
            <AssertionResult row={row} index={index} fixture={report.fixture} />
          </li>)}
        </ul>
      </Disclosure>)}
  </section>;
}
