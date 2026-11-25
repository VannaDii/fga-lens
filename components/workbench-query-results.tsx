import type * as t from "io-ts";
import type { evidenceResult, Json, Query, queryResult, Target, Tuple } from "@/lib/workbench-contract";
import { queryPath } from "@/lib/workbench-query-request";
import { highlightModelLine, JsonBlock } from "./workbench-source-syntax";
import { Disclosure, failureText, JobStatus, Select } from "./workbench-ui";

/** Keep the presentation tied to a captured request even when the form changes. */
export type CapturedQuery = {
  id: string; target: Target; storeName?: string; input: Query; request: Json; sentAt: number;
  result?: t.TypeOf<typeof queryResult>; evidence?: t.TypeOf<typeof evidenceResult>; error?: string; job?: string;
  listEntries: string[];
};

function ObservationTime({ value }: { value: number }) {
  const time = new Date(value);
  return <time dateTime={time.toISOString()}>{time.toLocaleTimeString()}</time>;
}

function Verdict({ allowed }: { allowed: boolean }) {
  return <span className="wb-result-tag" data-tone={allowed ? "allowed" : "denied"}>{allowed ? "Allowed" : "Denied"}</span>;
}

function ResultTag({ side }: { side: CapturedQuery }) {
  const outcome = side.result?.outcome;
  if (typeof outcome === "boolean") return <Verdict allowed={outcome} />;
  if (outcome) return <span className="wb-result-tag" data-tone={outcome.length ? "info" : undefined}>
    {outcome.length} {outcome.length === 1 ? "result" : "results"}
  </span>;
  return <span className="wb-result-tag" data-tone={side.error ? "denied" : undefined}>
    {side.error ? "Query failed" : "Running"}
  </span>;
}

function TupleFields({ user, relation, object }: Pick<Tuple, "user" | "relation" | "object">) {
  return <dl className="wb-result-fields">
    <div><dt>Subject</dt><dd><code>{user}</code></dd></div>
    <div><dt>Relation</dt><dd><code className="wb-result-tag" data-tone="info">{relation}</code></dd></div>
    <div><dt>Object</dt><dd><code>{object}</code></dd></div>
  </dl>;
}

function ModelRules({ side, evidence }: { side: CapturedQuery; evidence: NonNullable<CapturedQuery["evidence"]> }) {
  return <section className="wb-result-evidence-group">
    <h3>Model rules</h3>
    {evidence.rules.map(({ type, name, expression, line: location }) => {
      const identity = type ? `${type}#${name}` : `condition ${name}`;
      const definition = type ? `define ${name}: ${expression}` : `condition ${name} { ${expression} }`;
      const source = location && new URLSearchParams({ ...side.target, line: String(location) });
      return <div className="wb-result-observation" key={identity}>
        <div className="wb-model-rule-heading">
          <strong><code>{identity}</code></strong>
          {source && <a className="wb-source-link" href={`/model/source?${source}`} target="_blank" rel="noopener"
            aria-label={`View ${identity} source, line ${location} (opens in a new tab)`}>Line {location}</a>}
        </div>
        <code className="wb-model-rule-definition">{highlightModelLine(definition)}</code>
      </div>;
    })}
  </section>;
}

function QueryEvidence({ side }: { side: CapturedQuery }) {
  const { evidence, job } = side;
  const reason = job ? "Looking up evidence" : evidence?.reason && evidence.reason !== "Reason undetermined"
    ? "Later observation · " + evidence.reason : "Reason undetermined";
  return <>
    {job && <JobStatus key={job} id={job} label="Collecting evidence" unit="calls" />}
    {evidence?.failure && <p role="status">{failureText(evidence.failure)} · Run again</p>}
    <Disclosure title="Evidence" meta={<>
      <span>{reason}</span>
      {evidence && !job && <span title="Evidence collection time">{evidence.elapsed.toFixed(1)} ms</span>}
    </>}>
      <p className="wb-result-note">Tuple reads and follow-up checks were collected after the query.</p>
      {evidence?.checkReason && <p>Selected-entry Check · {evidence.checkReason}</p>}
      {!!evidence?.tuples.length && <section className="wb-result-evidence-group">
        <h3>Tuple reads</h3>
        {evidence.tuples.map(({ tuple, source, observedAt }, index) => <div className="wb-result-observation" key={index}>
          <div className="wb-result-observation-header">
            <span className="wb-result-tag" data-tone={source === "stored" ? "info" : "contextual"}>
              {source === "stored" ? "Stored" : "Contextual"}
            </span>
            <span>Observed <ObservationTime value={observedAt} /></span>
          </div>
          <TupleFields {...tuple} />
          {tuple.condition && <div className="wb-result-condition">
            <span>Condition</span> <code>{tuple.condition.name}</code>
            {tuple.condition.context && <JsonBlock value={tuple.condition.context} />}
          </div>}
        </div>)}
      </section>}
      {!!evidence?.checks.length && <section className="wb-result-evidence-group">
        <h3>Follow-up Checks</h3>
        {evidence.checks.map((check, index) => <div className="wb-result-observation" key={index}>
          <div className="wb-result-observation-header">
            <span>Follow-up Check <Verdict allowed={check.allowed} /></span>
            <span>Observed <ObservationTime value={check.observedAt} /></span>
          </div>
          <TupleFields {...check} />
        </div>)}
      </section>}
      {!!evidence?.rules.length && <ModelRules key={side.id} side={side} evidence={evidence} />}
      {evidence?.expansion && <Disclosure title="Expand observation">
        <JsonBlock value={evidence.expansion} />
      </Disclosure>}
    </Disclosure>
  </>;
}

export function QueryResults({ captured, entries, selectEntry, checkEntry }: {
  captured: CapturedQuery[]; entries: Record<number, string>;
  selectEntry: (index: number, entry: string) => void;
  checkEntry: (side: CapturedQuery, index: number, entry: string) => void;
}) {
  const comparing = captured.length > 1;
  const sideName = (index: number) => index === 0 ? "Primary" : "Comparison";
  return <section className="wb-pane">
    <header className="wb-pane-heading wb-result-heading">
      <h2>Result</h2>
      <div className="wb-result-outcomes" aria-live="polite">{captured.map((side, index) => <span key={index}>
        {comparing && <span>{sideName(index)}</span>}
        <ResultTag side={side} />
      </span>)}</div>
    </header>
    <div className="wb-results">{captured.map((side, index) => <article key={index}>
      {comparing && <h3>{sideName(index)}</h3>}
      <dl className="wb-result-fields">
        {side.storeName && <div><dt>Store</dt><dd>{side.storeName}</dd></div>}
        <div><dt>Store ID</dt><dd><code>{side.target.store}</code></dd></div>
        <div><dt>Model revision ID</dt><dd><code>{side.target.revision}</code></dd></div>
      </dl>
      <Disclosure title="API request" className="wb-query-api-disclosure"
        preview={<code className="wb-result-endpoint">
          <strong>POST</strong>{" "}<span>{queryPath(side.target, side.input)}</span>
        </code>}
        meta={<>Sent <ObservationTime value={side.sentAt} /></>}>
        <JsonBlock value={side.request} />
      </Disclosure>
      {side.result && <>
        <Disclosure title="Raw response" meta={<>
          <span>Received <ObservationTime value={side.result.observedAt} /></span>
          <span title="OpenFGA response time">{side.result.elapsed.toFixed(1)} ms</span>
        </>}>
          <JsonBlock value={side.result.raw} />
        </Disclosure>
        {Array.isArray(side.result.outcome) && side.result.outcome.length > 0
          && <ul className="wb-result-list">{side.result.outcome.map((value) => <li key={value}>{value}</li>)}</ul>}
        {side.input.operation !== "check" && <div className="wb-actions wb-form-actions">
          <Select label={"Inspect list entry" + (index ? " on comparison target" : "")}
            value={entries[index] ?? ""} options={side.listEntries} change={(entry) => selectEntry(index, entry)} />
          <button disabled={!entries[index] || Boolean(side.job)}
            onClick={() => checkEntry(side, index, entries[index])}>Check entry</button>
        </div>}
        <QueryEvidence side={side} />
      </>}
      {side.error && <p role="status">{side.error} · Run again</p>}
    </article>)}</div>
  </section>;
}
