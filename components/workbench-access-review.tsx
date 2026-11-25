"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TypeOf } from "io-ts";

import {
  reviewCatalog, reviewCheckObject, reviewLinkKey, reviewPair, reviewPreferences, reviewScope,
  type ReviewCatalog, type ReviewLink, type ReviewPreferences, type ReviewResource, type ReviewScope,
} from "@/lib/workbench-access-review-contract";
import { decode, evidenceResult, tupleKey, type ConditionContext, type Target } from "@/lib/workbench-contract";
import { contextValue, invalidContext } from "@/lib/workbench-models";

import { AccessReviewGraph } from "./workbench-access-review-graph";
import { useReviewEvaluation, type Row } from "./workbench-access-review-state";
import { failureText, invoke, Select } from "./workbench-ui";

type Read<T> = { epoch: number; value?: T; error?: string };
type ScopeRead = Read<ReviewScope> & { key: string };
type Inspection = {
  runKey: string; object: string; relation: string; subject: string; allowed: boolean;
  evidence?: TypeOf<typeof evidenceResult>; error?: string;
};
const emptyLinks: ReviewLink[] = [];
const emptyNames: string[] = [];
const roles = { grant: "Assignment", group: "Group membership", parent: "Parent relationship",
  required: "Required relationship", blocking: "Blocking relationship" };

const typeOf = (object: string) => object.split(":", 1)[0];
const words = (value: string) => value.replace(/[-_]+/g, " ").replace(/^\p{L}/u, (first) => first.toUpperCase());
const objectLabel = (object: string) => words(object.slice(object.indexOf(":") + 1));
const actionKey = ({ object }: ReviewResource, relation: string) => typeOf(object) + "#" + relation;
const message = (error: unknown) => error instanceof Error ? error.message : "server error";
const time = (stamp: number) => new Date(stamp).toLocaleTimeString();

function restore(saved?: string): ReviewPreferences {
  try { return decode(reviewPreferences, JSON.parse(saved ?? "")) ?? {}; }
  catch { return {}; }
}

function defaults(catalog: ReviewCatalog, saved: ReviewPreferences): ReviewPreferences {
  const types = catalog.types;
  const rootType = saved.rootType && types.includes(saved.rootType) ? saved.rootType
    : types.includes("organization") ? "organization" : types[0];
  const subjectType = saved.subjectType && types.includes(saved.subjectType) ? saved.subjectType
    : types.includes("user") ? "user" : types[0];
  const available = new Set(catalog.links.map(reviewLinkKey));
  const retained = saved.links?.filter((link) => available.has(reviewLinkKey(link)));
  const links = retained ?? catalog.links.filter(({ relation, direction }) =>
    relation === "parent" && direction === "subject-to-object");
  const promote = new Set(catalog.relations);
  return {
    rootType, subjectType, links, promoted: saved.promoted?.filter((key) => promote.has(key)) ?? [],
    root: saved.root && typeOf(saved.root) === rootType && catalog.objects.includes(saved.root) ? saved.root : "",
    subject: saved.subject && typeOf(saved.subject) === subjectType && catalog.objects.includes(saved.subject) ? saved.subject : "",
  };
}

/** Capture scope independently of the selected person, and keep the last complete read on refresh failure. */
function useReviewDiscovery(
  target: Target, epoch: number, selection: number, preferences: ReviewPreferences, save: (patch: ReviewPreferences) => void,
  latest: React.RefObject<ReviewPreferences>,
) {
  const { store, revision } = target;
  const [catalog, setCatalog] = useState<Read<ReviewCatalog>>();
  const [scope, setScope] = useState<ScopeRead>();
  const [removed, setRemoved] = useState<{ root: string; epoch: number }>();
  const root = preferences.root ?? "";
  const links = preferences.links ?? emptyLinks;
  const scopeKey = JSON.stringify([selection, root, links.map(reviewLinkKey)]);

  useEffect(() => {
    if (!store || !revision) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void invoke(reviewCatalog, { action: "access-review-catalog", target: { store, revision },
        job: crypto.randomUUID() }, controller.signal).then((value) => {
        if (controller.signal.aborted) return;
        const result = defaults(value, latest.current);
        if (latest.current.root && !result.root) setRemoved({ root: latest.current.root, epoch });
        if (JSON.stringify(result) !== JSON.stringify(latest.current)) save(result);
        setCatalog({ epoch, value });
      }).catch((error) => {
        if (!controller.signal.aborted) setCatalog((prior) => ({ epoch, value: prior?.value, error: message(error) }));
      });
    });
    return () => controller.abort();
  }, [store, revision, epoch, latest, save]);

  const ready = catalog?.epoch === epoch && !catalog.error;
  const needsLinks = Boolean(catalog?.value?.links.length && !links.length);
  useEffect(() => {
    if (!ready || !root || needsLinks) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void invoke(reviewScope, { action: "access-review-scope", target: { store, revision }, root, links,
        job: crypto.randomUUID() }, controller.signal).then((value) => {
        if (controller.signal.aborted) return;
        if (value.resources.length === 0) {
          setRemoved({ root, epoch });
          save({ root: "" });
          setCatalog((prior) => prior?.value ? { ...prior,
            value: { ...prior.value, objects: prior.value.objects.filter((object) => object !== root) },
          } : prior);
        }
        setScope({ key: scopeKey, epoch, value });
      }).catch((error) => {
        if (!controller.signal.aborted) setScope((prior) => ({ key: scopeKey, epoch,
          value: prior?.key === scopeKey ? prior.value : undefined, error: message(error),
        }));
      });
    });
    return () => controller.abort();
  }, [ready, root, needsLinks, scopeKey, links, epoch, revision, store, save]);

  const selected = scope?.key === scopeKey && scope.value?.resources.length ? scope.value : undefined;
  const issue = catalog?.epoch === epoch && catalog.error ? "Catalog read failed · " + catalog.error
    : scope?.key === scopeKey && scope.epoch === epoch && scope.error ? "Scope read failed · " + scope.error : "";
  return { catalog: catalog?.value, scope: selected, current: ready && scope?.key === scopeKey && scope.epoch === epoch && !scope.error,
    needsLinks, issue, removed: !root && removed?.epoch === epoch ? removed.root : undefined,
    loading: Boolean(store && revision && (!catalog || catalog.epoch !== epoch ||
      (ready && root && !needsLinks && (scope?.key !== scopeKey || scope.epoch !== epoch)))),
  };
}

function branchInventory(scope: ReviewScope) {
  const resources = new Map(scope.resources.map((resource) => [resource.object, resource]));
  const children = Map.groupBy(scope.edges, ({ parent }) => parent);
  return new Map(scope.resources.map(({ object, parent }) => {
    const visited = new Set<string>();
    for (let ancestor = parent; ancestor; ancestor = resources.get(ancestor)?.parent ?? null) visited.add(ancestor);
    const branch: ReviewResource[] = [];
    const remaining = [object];
    while (remaining.length) {
      const current = remaining.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      branch.push(resources.get(current)!);
      remaining.push(...(children.get(current)?.map(({ child }) => child) ?? []));
    }
    return [object, branch];
  }));
}

function summarize(branch: ReviewResource[], promoted: Set<string>, rows?: Map<string, Row>) {
  let actions = 0;
  let related = 0;
  let allowed = 0;
  let denied = 0;
  let incomplete = 0;
  for (const resource of branch) {
    for (const relation of resource.relations) {
      const result = rows?.get(reviewPair(resource.object, relation));
      if (!result || !("allowed" in result)) incomplete++;
      if (!isAction(resource, relation, promoted)) { related++; continue; }
      actions++;
      if (result && "allowed" in result) {
        if (result.allowed) allowed++;
        else denied++;
      }
    }
  }
  const label = !actions ? (related ? "Relationships only" : "No applicable relations")
    : allowed === actions ? "Access to all items" : allowed ? "Access to some items"
      : denied === actions ? "No access for the actions checked" : "Access incomplete";
  return { label, denied: actions > 0 && denied === actions, incomplete };
}

function isAction(resource: ReviewResource, relation: string, promoted: Set<string>) {
  return relation.startsWith("can_") || promoted.has(actionKey(resource, relation));
}

function ReviewSettings({ catalog, preferences, save }: {
  catalog: ReviewCatalog; preferences: ReviewPreferences; save: (patch: ReviewPreferences) => void;
}) {
  const chosen = preferences.links ?? emptyLinks;
  const keys = new Set(chosen.map(reviewLinkKey));
  const promoted = preferences.promoted ?? emptyNames;
  return <details className="review-settings nodrag">
    <summary>Scope relationships</summary>
    <div className="wb-actions">
      <Select label="Root type" value={preferences.rootType ?? ""} options={catalog.types}
        change={(rootType) => { if (rootType) save({ rootType, root: "" }); }} />
      <Select label="Subject type" value={preferences.subjectType ?? ""} options={catalog.types}
        change={(subjectType) => { if (subjectType) save({ subjectType, subject: "" }); }} />
    </div>
    <fieldset><legend>Containment links</legend>
      {catalog.links.map((link) => {
        const key = reviewLinkKey(link);
        const [parent, child] = link.direction === "subject-to-object"
          ? [link.subjectType, link.objectType] : [link.objectType, link.subjectType];
        return <label key={key}><input type="checkbox" checked={keys.has(key)} onChange={(event) => save({
          links: event.target.checked ? [...chosen, link] : chosen.filter((entry) => reviewLinkKey(entry) !== key),
        })} />{parent} → {child} <code>{link.objectType}#{link.relation}</code>
          <small>{link.direction === "subject-to-object" ? "Subject is parent" : "Object is parent"}</small></label>;
      })}
    </fieldset>
    <fieldset><legend>Show relationships as actions</legend>
      {catalog.relations.filter((key) => !key.slice(key.indexOf("#") + 1).startsWith("can_") &&
        !chosen.some(({ objectType, relation }) => key === objectType + "#" + relation)).map((key) =>
        <label key={key}><input type="checkbox" checked={promoted.includes(key)} onChange={(event) => save({
          promoted: event.target.checked ? [...promoted, key] : promoted.filter((entry) => entry !== key),
        })} /><code>{key}</code></label>)}
    </fieldset>
  </details>;
}

function decisionLabel(result: Row | undefined, action: boolean) {
  if (!result) return "Not yet checked";
  if ("allowed" in result) {
    if (action) return result.allowed ? "Allowed" : "Denied";
    return result.allowed ? "Matches" : "Does not match";
  }
  return "missing" in result && result.missing?.length ? "Needs context" : "Check unavailable";
}

function Why({ current, scope, close, panel }: {
  current: Inspection; scope: ReviewScope; close: () => void; panel: React.RefObject<HTMLElement | null>;
}) {
  const nested = new Set(scope.edges.map(({ subject, object, relation }) => JSON.stringify([subject, relation, object])));
  const proof = current.evidence?.supporting ?? [];
  return <section className="wb-pane review-why" aria-label="Why" ref={panel}>
    <header className="wb-actions"><h2>Why</h2><button type="button" onClick={close}>Close</button></header>
    <p><strong>{current.allowed ? "Allowed" : "Denied"}</strong> · {current.subject} · <code>{current.relation}</code> · {current.object}</p>
    <p role="status">{current.evidence?.reason ?? (current.error ? "Reason undetermined" : "Checking relationships…")}</p>
    {current.error && <p>{current.error}</p>}
    {current.evidence?.failure && <p>{failureText(current.evidence.failure)}</p>}
    {proof.length > 0 && <>
      <h3>Observed after the check</h3>
      <ol>{proof.map(({ tuple, role, source }, index) =>
        <li key={index}><strong>{roles[role]}</strong> · <code>{tuple.user} · {tuple.relation} · {tuple.object}</code>
          {source === "contextual" && <small> · Request tuple</small>}
          {tuple.condition && <small> · Condition {tuple.condition.name}</small>}
          {!nested.has(tupleKey(tuple)) && <small> · Relationship outside the hierarchy</small>}</li>)}</ol>
    </>}
    {current.evidence && <details><summary>Rules and later observations</summary>
      {current.evidence.rules.length > 0 && <pre>{current.evidence.rules.join("\n")}</pre>}
      {current.evidence.tuples.length > 0 && <pre>{current.evidence.tuples.map(({ tuple, source }) =>
        [tuple.user, tuple.relation, tuple.object, source, tuple.condition?.name].filter(Boolean).join(" · ")).join("\n")}</pre>}
      {current.evidence.checks.length > 0 && <pre>{current.evidence.checks.map(({ user, relation, object, allowed, observedAt }) =>
        [user, relation, object, allowed ? "Allowed" : "Denied", time(observedAt)].join(" · ")).join("\n")}</pre>}
    </details>}
  </section>;
}

export function AccessReviewScreen({ target, preferenceKey, saved, remember }: {
  target: Target; preferenceKey: string; saved?: string; remember: (values: Record<string, string>) => void;
}) {
  const [preferences, setPreferences] = useState(() => restore(saved));
  const [structureSelection, setStructureSelection] = useState(0);
  const [checkSelection, setCheckSelection] = useState(0);
  const latest = useRef(preferences);
  const rememberLatest = useRef(remember);
  useEffect(() => { rememberLatest.current = remember; }, [remember]);
  const save = useCallback((patch: ReviewPreferences) => {
    const next = { ...latest.current, ...patch };
    if (next.root !== latest.current.root ||
      JSON.stringify(next.links?.map(reviewLinkKey)) !== JSON.stringify(latest.current.links?.map(reviewLinkKey))) {
      setStructureSelection((previous) => previous + 1);
    }
    if (next.subject !== latest.current.subject) setCheckSelection((previous) => previous + 1);
    latest.current = next;
    setPreferences(next);
    rememberLatest.current({ [preferenceKey]: JSON.stringify(next) });
  }, [preferenceKey]);

  const [epoch, setEpoch] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [emptyStrings, setEmptyStrings] = useState<Set<string>>(() => new Set());
  const [inspection, setInspection] = useState<Inspection>();
  const evidenceRequest = useRef<AbortController>(null);
  const evidenceTrigger = useRef<HTMLButtonElement>(null);
  const whyPanel = useRef<HTMLElement>(null);
  const { catalog, scope, current, needsLinks, issue, removed, loading } = useReviewDiscovery(target, epoch, structureSelection, preferences, save, latest);
  const subject = preferences.subject ?? "";
  const declared = useMemo(() => new Map(catalog?.parameters), [catalog?.parameters]);
  const context: ConditionContext = useMemo(() => Object.fromEntries([...declared].flatMap(([name, types]) =>
    inputs[name] || emptyStrings.has(name) ? [[name, contextValue(inputs[name] ?? "", types)]] : [])),
  [declared, emptyStrings, inputs]);
  const invalid = invalidContext(context, declared);
  const visible = useMemo(() => {
    const shown = new Set<string>();
    return scope?.resources.filter(({ depth, parent, object }) => {
      if (depth > 1 && (!parent || !shown.has(parent) || !expanded.has(parent))) return false;
      shown.add(object);
      return true;
    }) ?? [];
  }, [scope, expanded]);
  const { run, key: runKey, total, cancel } = useReviewEvaluation(scope, target, subject, context, current && !invalid, visible, checkSelection);
  const activeWhy = !invalid && inspection?.runKey === runKey && runKey ? inspection : undefined;
  useEffect(() => {
    if (!current || invalid) evidenceRequest.current?.abort();
    return () => evidenceRequest.current?.abort();
  }, [runKey, current, invalid]);
  const branches = useMemo(() => scope ? branchInventory(scope) : new Map<string, ReviewResource[]>(), [scope]);
  const promoted = useMemo(() => new Set(preferences.promoted), [preferences.promoted]);
  const summaries = new Map([...branches].map(([object, branch]) => [object, summarize(branch, promoted, run?.rows)]));
  const children = useMemo(() => Map.groupBy(scope?.resources ?? [], ({ parent }) => parent), [scope]);
  const incoming = useMemo(() => Map.groupBy(scope?.edges ?? [], ({ child }) => child), [scope]);
  const muted = new Set([...summaries].filter(([, summary]) => summary.denied).map(([object]) => object));
  const highlighted = new Set(activeWhy?.evidence?.supporting?.map(({ tuple }) => tupleKey(tuple)));
  const available = catalog?.objects ?? emptyNames;

  function closeWhy(returnFocus = false) {
    evidenceRequest.current?.abort();
    setInspection(undefined);
    if (returnFocus) evidenceTrigger.current?.focus();
    evidenceTrigger.current = null;
  }

  function explain(resource: ReviewResource, relation: string, allowed: boolean, trigger: HTMLButtonElement) {
    evidenceRequest.current?.abort();
    const controller = new AbortController();
    evidenceRequest.current = controller;
    evidenceTrigger.current = trigger;
    const captured = { runKey, subject, object: resource.object, relation, allowed };
    setInspection(captured);
    requestAnimationFrame(() => {
      if (!controller.signal.aborted) whyPanel.current?.scrollIntoView({ block: "nearest" });
    });
    void invoke(evidenceResult, { action: "evidence", mode: "access-review", job: crypto.randomUUID(), target,
      input: { operation: "check", user: subject, object: resource.object, relation, context, consistent: true },
      outcome: allowed,
    }, controller.signal).then((evidence) => {
      if (!controller.signal.aborted) setInspection({ ...captured, evidence });
    }).catch((error) => {
      if (!controller.signal.aborted) setInspection({ ...captured, error: message(error) });
    });
  }

  function decision(resource: ReviewResource, relation: string, action: boolean) {
    const row = !invalid ? run?.rows.get(reviewPair(resource.object, relation)) : undefined;
    const status = decisionLabel(row, action);
    const checked = row && "allowed" in row;
    const details = row && "failure" in row ? ("missing" in row && row.missing
      ? "Enter " + row.missing.join(", ") + " in Condition context" : failureText(row.failure)) : "";
    return <button type="button" key={relation} className="review-decision nodrag"
      data-state={checked ? (row.allowed ? "allowed" : "denied") : undefined}
      title={[relation, details].filter(Boolean).join(" · ")} disabled={!checked}
      onClick={(event) => { if (checked) explain(resource, relation, row.allowed, event.currentTarget); }}>
      {action ? words(relation.replace(/^can_/, "")) : relation} · {status}
    </button>;
  }

  function renderResource(resource: ReviewResource, outline: boolean) {
    const { object, depth, relations } = resource;
    const label = objectLabel(object);
    const actions = relations.filter((relation) => isAction(resource, relation, promoted));
    const relationships = relations.filter((relation) => !isAction(resource, relation, promoted));
    const descendants = (branches.get(object)?.length ?? 1) - 1;
    const expandable = depth > 0 && Boolean(children.get(object)?.length);
    const open = expanded.has(object);
    const summary = summaries.get(object);
    const checkable = reviewCheckObject.is(object);
    return <>
      <div className="review-resource-header"><strong title={object}>{label}</strong><small>{words(typeOf(object))}</small></div>
      {!checkable && <small className="review-rollup">ID exceeds the Check object limit</small>}
      {checkable && summary && <small className="review-rollup">{!subject && actions.length ? "Select a person" : summary.label}
        {subject && summary.incomplete > 0 && <> · {summary.incomplete} incomplete</>}</small>}
      {actions.length > 0 && <div className="review-decisions nowheel">{actions.map((relation) => decision(resource, relation, true))}</div>}
      {outline && relationships.length > 0 && <details><summary>Relationships</summary>
        <div className="review-decisions">{relationships.map((relation) => decision(resource, relation, false))}</div>
      </details>}
      {outline && relations.some((relation) => {
        const row = !invalid && run?.rows.get(reviewPair(object, relation));
        return row && !("allowed" in row) && "failure" in row;
      }) && <details><summary>Check details</summary>
        {relations.map((relation) => {
          const row = run?.rows.get(reviewPair(object, relation));
          if (!row || !("failure" in row)) return null;
          return <p key={relation}><code>{relation}</code> · {row.missing?.length
            ? "Enter " + row.missing.join(", ") + " in Condition context"
            : failureText(row.failure) + " · Refresh to try again."}</p>;
        })}
      </details>}
      {outline && <details><summary>Resource details</summary>
        <p><code>{object}</code></p>
        {incoming.get(object)?.map((edge) => <p key={JSON.stringify(edge)}>
          <code>{edge.subject} · {edge.relation} · {edge.object}</code>
          {edge.parent !== resource.parent && <> · Secondary link</>}
          {edge.condition && <> · Condition {edge.condition}</>}</p>)}
      </details>}
      {expandable && <button type="button" className="review-expand nodrag" aria-expanded={open}
        aria-label={(open ? "Collapse " : "Expand ") + label + (open ? "" : " · " + descendants + " below")}
        onClick={() => setExpanded((prior) => {
          const next = new Set(prior);
          if (next.has(object)) next.delete(object);
          else next.add(object);
          return next;
        })}>{open ? "Collapse" : "Expand · " + descendants + " below"}</button>}
    </>;
  }

  const unavailable = [...(run?.rows.values() ?? [])].filter((row) => !("allowed" in row) && !("missing" in row && row.missing?.length)).length;
  const checkRecovery = run?.diagnostic?.startsWith("invalid input")
    ? "Verify the selected revision and that the endpoint accepts up to 25 checks per request."
    : run?.diagnostic?.startsWith("missing target") ? "Select another installed revision." : "Refresh to try again.";

  return <main className="review-page">
    <section className="wb-pane review-controls">
      <h1>Access Review</h1>
      <div className="wb-actions">
        <Select label="Organization" value={preferences.root ?? ""} options={available.filter((object) => typeOf(object) === preferences.rootType)
          .map((object) => ({ value: object, label: objectLabel(object) }))} title={preferences.root}
          change={(root) => { setExpanded(new Set()); closeWhy(); save({ root }); }} />
        <Select label="View as" value={subject} options={available.filter((object) => typeOf(object) === preferences.subjectType)
          .map((object) => ({ value: object, label: objectLabel(object) }))} title={subject}
          change={(subject) => { closeWhy(); save({ subject }); }} />
        <button type="button" disabled={!target.store || !target.revision} onClick={() => {
          closeWhy();
          setEpoch((previous) => previous + 1);
        }}>Refresh</button>
      </div>
      {catalog && <ReviewSettings catalog={catalog} preferences={preferences} save={save} />}
      {declared.size > 0 && <details className="review-settings"><summary>Condition context</summary>
        {[...declared].map(([name, types]) => <div key={name}>
          <label>{name}
            <input value={inputs[name] ?? ""} autoComplete="off" aria-invalid={invalid === name}
              placeholder={[...new Set(types.map(({ type_name }) => type_name.replace(/^TYPE_NAME_/, "").toLowerCase()))].join(" or ")}
              onChange={(event) => {
                closeWhy();
                setInputs({ ...inputs, [name]: event.target.value });
                setCheckSelection((previous) => previous + 1);
              }} />
          </label>
          {types.some(({ type_name }) => type_name === "TYPE_NAME_STRING") && !inputs[name] &&
            <label><input type="checkbox" checked={emptyStrings.has(name)} onChange={(event) => {
              closeWhy();
              const next = new Set(emptyStrings);
              if (event.target.checked) next.add(name);
              else next.delete(name);
              setEmptyStrings(next);
              setCheckSelection((previous) => previous + 1);
            }} />Send an empty string for {name}</label>}
        </div>)}
      </details>}
      {invalid && <p role="alert">Invalid condition value · {invalid}. Use the declared type shown in the field.</p>}
      {catalog && !available.some((object) => typeOf(object) === preferences.rootType) &&
        <p>No published objects for root type {preferences.rootType}. Change the root type in Scope relationships.</p>}
      {catalog && !available.some((object) => typeOf(object) === preferences.subjectType) &&
        <p>No published objects for subject type {preferences.subjectType}. Change the subject type in Scope relationships.</p>}
      {catalog && !loading && !issue && !preferences.root && available.some((object) => typeOf(object) === preferences.rootType) &&
        <p>Select an organization to review.</p>}
      {scope && !subject && <p>Select a person to evaluate access.</p>}
      {needsLinks && <p>Choose containment links in Scope relationships.</p>}
      {catalog && !catalog.links.length && <p>No scope relationships defined</p>}
      {scope?.resources.length === 1 && <p>No linked resources</p>}
      {removed && <p role="status">{removed} is no longer in the published store. Select another organization or refresh.</p>}
      {issue && <p role="alert">{issue}{scope && " · Stale scope from " + time(scope.observedAt)}
        {run?.observedAt && " · Decisions from " + time(run.observedAt)}
        {issue.includes("· missing target") && " · Select another installed revision."}</p>}
      {loading && <p role="status">Reading published relationships…</p>}
      {(!target.store || !target.revision) && <p>Select a store and an installed model revision.</p>}
      {scope && <div className="review-status">
        <p>{objectLabel(scope.root)}{subject && " · View as " + subject}
          {" · Hierarchy read " + time(scope.observedAt)}
          {run?.observedAt && " · Decisions observed " + time(run.observedAt)}</p>
        {subject && !invalid && total > 0 && <div className="wb-actions">
          <p role="status">{run?.phase === "cancelled" ? "Review cancelled · " : run?.phase === "timeout" ? "Review timed out · " : ""}
            {run?.rows.size ?? 0} of {total} checks processed · {unavailable} unavailable · {total - (run?.rows.size ?? 0)} unfinished</p>
          {run?.phase === "running" && current && <button type="button" onClick={cancel}>Cancel review</button>}
        </div>}
        {run?.diagnostic && <p role="alert">Checks unavailable · {run.diagnostic} · {checkRecovery}</p>}
      </div>}
    </section>
    {scope && <div className="review-layout">
      <section className="wb-pane review-chart" aria-label="Access chart"><h2>Access chart</h2>
        <AccessReviewGraph scope={scope} visible={visible} muted={muted} highlighted={highlighted}
          render={(resource) => renderResource(resource, false)} />
        {scope.edges.some(({ subject, object, relation }) => highlighted.has(tupleKey({ user: subject, object, relation }))) &&
          <p className="review-legend">Highlighted links show relationships observed after the check.</p>}
      </section>
      <section className="wb-pane review-outline" aria-label="Access outline"><h2>Access outline</h2>
        <ul>{visible.map((resource) => <li key={resource.object} data-muted={muted.has(resource.object) || undefined}
          style={{ marginInlineStart: Math.min(resource.depth, 3) * 0.45 + "rem" }}>{renderResource(resource, true)}</li>)}</ul>
      </section>
      {activeWhy && <Why current={activeWhy} scope={scope} close={() => closeWhy(true)} panel={whyPanel} />}
    </div>}
  </main>;
}
