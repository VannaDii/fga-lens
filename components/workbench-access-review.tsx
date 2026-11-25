"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TypeOf } from "io-ts";
import { ChevronDown, ChevronRight, CircleQuestionMark, Eye, Info, RefreshCw, Target as TargetIcon, X } from "lucide-react";

import {
  reviewCatalog, reviewPair, reviewPreferences, reviewScope,
  type ReviewCatalog, type ReviewPreferences, type ReviewResource, type ReviewScope,
} from "@/lib/workbench-access-review-contract";
import { decode, evidenceResult, tupleKey, type ConditionContext, type Target } from "@/lib/workbench-contract";
import { contextValue, invalidContext } from "@/lib/workbench-models";

import { AccessReviewGraph, type AccessReviewGraphHandle, type ReviewTone } from "./workbench-access-review-graph";
import { useReviewEvaluation, type Row } from "./workbench-access-review-state";
import { Disclosure, failureText, invoke } from "./workbench-ui";

type Read<T> = { epoch: number; value?: T; error?: string };
type ScopeRead = Read<ReviewScope> & { key: string };
type Inspection = {
  runKey: string; object: string; relation: string; subject: string; allowed: boolean;
  scope: ReviewScope;
  evidence?: TypeOf<typeof evidenceResult>; error?: string;
};
const emptyNames: string[] = [];
const roles = { grant: "Assignment", group: "Group membership", parent: "Parent relationship",
  required: "Required relationship", blocking: "Blocking relationship" };

const typeOf = (object: string) => object.split(":", 1)[0];
const words = (value: string) => value.replace(/[-_]+/g, " ").replace(/^\p{L}/u, (first) => first.toUpperCase());
const objectLabel = (object: string) => words(object.slice(object.indexOf(":") + 1));
const isAction = (relation: string) => relation.startsWith("can_");
const message = (error: unknown) => error instanceof Error ? error.message : "server error";
const time = (stamp: number) => new Date(stamp).toLocaleTimeString();
const duration = (ms: number) => ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms.toFixed(1) + " ms";

function restore(saved?: string): ReviewPreferences {
  try {
    const { root, subject } = decode(reviewPreferences, JSON.parse(saved ?? "")) ?? {};
    return { root, subject };
  }
  catch { return {}; }
}

function defaults(catalog: ReviewCatalog, saved: ReviewPreferences): ReviewPreferences {
  return {
    root: saved.root && catalog.objects.includes(saved.root) ? saved.root : "",
    subject: saved.subject && catalog.objects.includes(saved.subject) ? saved.subject : "",
  };
}

function ReviewPicker({ label, value, objects, preferredType, change }: {
  label: string; value: string; objects: string[]; preferredType: string; change: (value: string) => void;
}) {
  const groups = Map.groupBy(objects, typeOf);
  const types = [...groups.keys()].sort((a, b) =>
    Number(b === preferredType) - Number(a === preferredType) || a.localeCompare(b));
  return <label>{label}<select value={value} title={value || undefined} onChange={(event) => change(event.target.value)}>
    <option value="">Select an instance</option>
    {types.map((type) => <optgroup key={type} label={words(type)}>
      {groups.get(type)?.map((object) => <option key={object} value={object}>{objectLabel(object)}</option>)}
    </optgroup>)}
  </select></label>;
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
  const scopeKey = JSON.stringify([selection, root]);

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
  useEffect(() => {
    if (!ready || !root) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void invoke(reviewScope, { action: "access-review-scope", target: { store, revision }, root,
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
  }, [ready, root, scopeKey, epoch, revision, store, save]);

  const selected = scope?.key === scopeKey && scope.value?.resources.length ? scope.value : undefined;
  const issue = catalog?.epoch === epoch && catalog.error ? "Catalog read failed · " + catalog.error
    : scope?.key === scopeKey && scope.epoch === epoch && scope.error ? "Scope read failed · " + scope.error : "";
  return { catalog: catalog?.value, scope: selected, current: ready && scope?.key === scopeKey && scope.epoch === epoch && !scope.error,
    issue, removed: !root && removed?.epoch === epoch ? removed.root : undefined,
    loading: Boolean(store && revision && (!catalog || catalog.epoch !== epoch ||
      (ready && root && (scope?.key !== scopeKey || scope.epoch !== epoch)))),
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

function summarize(branch: ReviewResource[], rows?: Map<string, Row>): ReviewTone | undefined {
  if (!rows) return;
  let hasActions = false;
  let pendingAction = false;
  let pendingRelationship = false;
  let matches = false;
  let hasRelationships = false;
  for (const resource of branch) {
    for (const relation of resource.relations) {
      const row = rows.get(reviewPair(resource.object, relation));
      const allowed = row && "allowed" in row ? row.allowed : undefined;
      if (isAction(relation)) {
        if (allowed) return "allowed";
        hasActions = true;
        pendingAction ||= allowed === undefined;
      } else {
        hasRelationships = true;
        matches ||= allowed === true;
        pendingRelationship ||= allowed === undefined;
      }
    }
  }
  if (hasActions) return pendingAction ? undefined : "denied";
  if (matches) return "matches";
  if (hasRelationships && !pendingRelationship) return "muted";
}

function decisionLabel(result: Row | undefined, action: boolean) {
  if (!result) return "Not yet checked";
  if ("allowed" in result) {
    if (action) return result.allowed ? "Allowed" : "Denied";
    return result.allowed ? "Matches" : "Does not match";
  }
  return "missing" in result && result.missing?.length ? "Needs context" : "Check unavailable";
}

function unavailableDetails(row?: Row) {
  if (!row) return "";
  if ("reason" in row && row.reason === "object-too-long") return "OpenFGA limits Check object identifiers to 256 characters.";
  if (!("failure" in row)) return "";
  return row.missing?.length ? "Enter " + row.missing.join(", ") + " in Condition context"
    : failureText(row.failure) + " · Refresh to try again.";
}

function Why({ current, previous, close, panel }: {
  current: Inspection; previous: boolean; close: () => void; panel: React.RefObject<HTMLElement | null>;
}) {
  const nested = new Set(current.scope.edges.map(({ subject, object, relation }) => JSON.stringify([subject, relation, object])));
  const proof = current.evidence?.supporting ?? [];
  return <section className="wb-pane review-why" popover="manual" role="dialog" tabIndex={-1} aria-label="Why" ref={panel}>
    <header className="wb-pane-heading"><h2>Why</h2>
      <button type="button" className="wb-icon-button" aria-label="Close Why" title="Close Why" onClick={close}>
        <X size={16} aria-hidden />
      </button>
    </header>
    {previous && <small>Result from the previous review</small>}
    <p><strong>{isAction(current.relation) ? (current.allowed ? "Allowed" : "Denied")
      : (current.allowed ? "Matches" : "Does not match")}</strong> · {current.subject} · <code>{current.relation}</code> · {current.object}</p>
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
    {current.evidence && <Disclosure title="Rules and later observations">
      {current.evidence.rules.length > 0 && <pre>{current.evidence.rules.map(({ type, name, expression }) => type
        ? `type ${type} · define ${name}: ${expression}` : `condition ${name} { ${expression} }`).join("\n")}</pre>}
      {current.evidence.tuples.length > 0 && <pre>{current.evidence.tuples.map(({ tuple, source }) =>
        [tuple.user, tuple.relation, tuple.object, source, tuple.condition?.name].filter(Boolean).join(" · ")).join("\n")}</pre>}
      {current.evidence.checks.length > 0 && <pre>{current.evidence.checks.map(({ user, relation, object, allowed, observedAt }) =>
        [user, relation, object, allowed ? "Allowed" : "Denied", time(observedAt)].join(" · ")).join("\n")}</pre>}
    </Disclosure>}
  </section>;
}

/** Place the popover beside the transformed card at normal text size. */
function placeWhy(panel: HTMLElement, anchor: HTMLElement | null) {
  const gap = 12;
  const { width, height, x, y } = panel.getBoundingClientRect();
  const right = document.documentElement.clientWidth - gap - width;
  const bottom = window.innerHeight - gap - height;
  const box = anchor?.getBoundingClientRect();
  let left = x;
  let top = y;
  if (box) {
    top = box.top;
    if (box.right + gap <= right) left = box.right + gap;
    else if (box.left - gap - width >= gap) left = box.left - gap - width;
    else {
      left = box.left;
      top = box.bottom + gap <= bottom ? box.bottom + gap : box.top - gap - height;
    }
  }
  panel.style.left = Math.max(gap, Math.min(right, left)) + "px";
  panel.style.top = Math.max(gap, Math.min(bottom, top)) + "px";
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
    if (next.root !== latest.current.root) setStructureSelection((previous) => previous + 1);
    if (next.subject !== latest.current.subject) setCheckSelection((previous) => previous + 1);
    latest.current = next;
    setPreferences(next);
    rememberLatest.current({ [preferenceKey]: JSON.stringify(next) });
  }, [preferenceKey]);

  const [epoch, setEpoch] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [emptyStrings, setEmptyStrings] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<{ object: string; focusChart: boolean }>();
  const [inspection, setInspection] = useState<Inspection>();
  const infoId = useId();
  const evidenceRequest = useRef<AbortController>(null);
  const evidenceTrigger = useRef<HTMLButtonElement>(null);
  const whyPanel = useRef<HTMLElement>(null);
  const chartPanel = useRef<HTMLElement>(null);
  const chartGraph = useRef<AccessReviewGraphHandle>(null);
  const outlineList = useRef<HTMLDivElement>(null);
  const whyFrame = useRef<number>(null);
  const { catalog, scope, current, issue, removed, loading } = useReviewDiscovery(target, epoch, structureSelection, preferences, save, latest);
  const subject = preferences.subject ?? "";
  const declared = useMemo(() => new Map(catalog?.parameters), [catalog?.parameters]);
  const context: ConditionContext = useMemo(() => Object.fromEntries([...declared].flatMap(([name, types]) =>
    inputs[name] || emptyStrings.has(name) ? [[name, contextValue(inputs[name] ?? "", types)]] : [])),
  [declared, emptyStrings, inputs]);
  const invalid = invalidContext(context, declared);
  const { run, key: runKey, total, cancel } = useReviewEvaluation(scope, target, subject, context, current && !invalid, checkSelection);
  const activeWhy = !invalid && inspection?.runKey === runKey && runKey ? inspection : undefined;
  useEffect(() => () => evidenceRequest.current?.abort(), []);
  const children = useMemo(() => Map.groupBy(scope?.resources ?? [], ({ parent }) => parent), [scope]);
  const visible = useMemo(() => {
    const shown = new Set<string>();
    return scope?.resources.filter(({ object, parent }) => {
      if (parent && (!shown.has(parent) || collapsed.has(parent))) return false;
      shown.add(object);
      return true;
    }) ?? [];
  }, [scope, collapsed]);
  const branches = useMemo(() => scope ? branchInventory(scope) : new Map<string, ReviewResource[]>(), [scope]);
  const incoming = useMemo(() => Map.groupBy(scope?.edges ?? [], ({ child }) => child), [scope]);
  const rows = invalid ? undefined : run?.rows;
  const cardTones = new Map(scope?.resources.map((resource) => [resource.object, summarize([resource], rows)]));
  const branchTones = new Map([...branches].map(([object, branch]) => [object, summarize(branch, rows)]));
  const highlighted = new Set(activeWhy?.evidence?.supporting?.map(({ tuple }) => tupleKey(tuple)));
  const available = catalog?.objects ?? emptyNames;

  const inspectedObject = inspection?.object;
  const positionWhy = useCallback(() => {
    const panel = whyPanel.current;
    if (!panel || !inspectedObject) return;
    const card = chartPanel.current?.querySelector<HTMLElement>(
      '.react-flow__node[data-id="' + CSS.escape(inspectedObject) + '"]') ?? null;
    placeWhy(panel, card);
  }, [inspectedObject]);

  const viewportChanged = useCallback(() => {
    if (whyPanel.current && whyFrame.current === null) {
      whyFrame.current = requestAnimationFrame(() => {
        whyFrame.current = null;
        positionWhy();
      });
    }
  }, [positionWhy]);

  useLayoutEffect(() => {
    const panel = whyPanel.current;
    if (!panel) return;
    if (!panel.matches(":popover-open")) {
      panel.showPopover();
      panel.focus({ preventScroll: true });
    }
    positionWhy();
    const resize = new ResizeObserver(positionWhy);
    resize.observe(panel);
    window.addEventListener("scroll", positionWhy, { capture: true, passive: true });
    window.addEventListener("resize", positionWhy);
    return () => {
      resize.disconnect();
      window.removeEventListener("scroll", positionWhy, true);
      window.removeEventListener("resize", positionWhy);
      if (whyFrame.current !== null) cancelAnimationFrame(whyFrame.current);
      whyFrame.current = null;
    };
  }, [positionWhy]);

  useLayoutEffect(() => {
    positionWhy();
    const list = outlineList.current;
    if (!list || !selection) return;
    const item = list.querySelector<HTMLElement>('[data-review-object="' + CSS.escape(selection.object) + '"]');
    if (!item) return;
    const viewport = list.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < viewport.top || row.height > viewport.height) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
    if (row.left < viewport.left || row.width > list.clientWidth) list.scrollLeft += row.left - viewport.left;
    else if (row.right > viewport.left + list.clientWidth) list.scrollLeft += row.right - viewport.left - list.clientWidth;
  }, [positionWhy, selection, visible]);

  function selectResource(object: string, focusChart = false) {
    setSelection({ object, focusChart });
  }

  function toggleBranch(object: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(object)) next.add(object);
      return next;
    });
  }

  function closeWhy() {
    evidenceRequest.current?.abort();
    setInspection(undefined);
    evidenceTrigger.current?.focus({ preventScroll: true });
    evidenceTrigger.current = null;
  }

  function explain(resource: ReviewResource, relation: string, allowed: boolean, trigger: HTMLButtonElement) {
    if (!scope) return;
    evidenceRequest.current?.abort();
    const controller = new AbortController();
    evidenceRequest.current = controller;
    evidenceTrigger.current = trigger;
    const captured = { runKey, subject, object: resource.object, relation, allowed, scope };
    setInspection(captured);
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
    const row = rows?.get(reviewPair(resource.object, relation));
    const status = decisionLabel(row, action);
    const checked = row && "allowed" in row;
    const tone = checked && action ? (row.allowed ? "allowed" : "denied")
      : checked && row.allowed ? "matches" : undefined;
    return <button type="button" key={relation} className="review-decision nodrag"
      aria-label={action ? undefined : "Relationship " + relation + " · " + status}
      data-state={tone}
      title={[relation, unavailableDetails(row)].filter(Boolean).join(" · ")} disabled={!checked}
      onClick={(event) => {
        if (checked) explain(resource, relation, row.allowed, event.currentTarget);
      }}>
      {action ? words(relation.replace(/^can_/, "")) : <code>{relation}</code>} · {status}
    </button>;
  }

  function renderResource(resource: ReviewResource, outline: boolean) {
    const { object, relations } = resource;
    const label = objectLabel(object);
    const actions = relations.filter(isAction);
    const relationships = relations.filter((relation) => !isAction(relation));
    const folded = collapsed.has(object);
    const selected = selection?.object === object;
    const whyRelation = [...actions, ...relationships].find((relation) => {
      const row = rows?.get(reviewPair(object, relation));
      return row && "allowed" in row;
    });
    const focusLabel = "Focus " + label + " on chart";
    return <>
      <div className="review-resource-header">
        {children.get(object)?.length ? <button type="button" className="wb-icon-button review-card-button nodrag"
          aria-expanded={!folded} aria-label={(folded ? "Expand " : "Collapse ") + label}
          onClick={() => toggleBranch(object)}>
          {folded ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
        </button> : null}
        {outline ? <>
          <strong className="review-outline-name" title={object}>{label}</strong>
          <button type="button" className="wb-icon-button review-card-button" aria-label={focusLabel} title={focusLabel}
            aria-pressed={selected} onClick={() => selectResource(object, true)}><Eye size={16} aria-hidden /></button>
          <small>{words(typeOf(object))}</small>
        </> : <div className="review-card-identity">
          <button type="button" className="review-resource-name nodrag" title={object}
            aria-pressed={selected} onClick={() => selectResource(object)}>{label}</button>
          <small>{words(typeOf(object))}</small>
        </div>}
        {!outline && whyRelation && <button type="button" className="wb-icon-button review-card-button nodrag"
          aria-haspopup="dialog" aria-label="Why" title="Why" onClick={(event) => {
            const row = rows?.get(reviewPair(object, whyRelation));
            if (row && "allowed" in row) explain(resource, whyRelation, row.allowed, event.currentTarget);
          }}>
          <CircleQuestionMark size={16} aria-hidden />
        </button>}
      </div>
      {relations.length > 0 && <div className="review-decisions">
        {actions.map((relation) => decision(resource, relation, true))}
        {relationships.map((relation) => decision(resource, relation, false))}
      </div>}
      {outline && relations.some((relation) => unavailableDetails(rows?.get(reviewPair(object, relation)))) && <Disclosure title="Check details">
        {relations.map((relation) => {
          const details = unavailableDetails(rows?.get(reviewPair(object, relation)));
          return details && <p key={relation}><code>{relation}</code> · {details}</p>;
        })}
      </Disclosure>}
      {outline && <Disclosure title="Resource details">
        <p><code>{object}</code></p>
        {incoming.get(object)?.map((edge) => <p key={JSON.stringify(edge)}>
          <code>{edge.subject} · {edge.relation} · {edge.object}</code>
          {edge.parent !== resource.parent && <> · Secondary link</>}
          {edge.condition && <> · Condition {edge.condition}</>}</p>)}
      </Disclosure>}
    </>;
  }

  function outlineBranch(resource: ReviewResource) {
    const descendants = children.get(resource.object);
    const tone = cardTones.get(resource.object);
    return <li key={resource.object} data-branch-tone={branchTones.get(resource.object)}>
      <article className="review-outline-card" data-review-object={resource.object}
        data-muted={tone === "muted" || tone === "denied" || undefined} data-allowed={tone === "allowed" || undefined}
        data-denied={tone === "denied" || undefined}
        data-matches={tone === "matches" || undefined} data-selected={selection?.object === resource.object || undefined}>
        {renderResource(resource, true)}
      </article>
      {!collapsed.has(resource.object) && descendants?.length
        ? <ul>{descendants.map(outlineBranch)}</ul> : null}
    </li>;
  }

  const processed = run?.rows.size ?? 0;
  const unavailable = [...(run?.rows.values() ?? [])].filter((row) => !("allowed" in row) && !("missing" in row && row.missing?.length)).length;
  const showChecks = Boolean(subject && !invalid && total > 0);
  const checking = current && (!run || run.phase === "running");
  const { firstResults, laterBatches, elapsed } = run?.timing ?? {};
  const checkRecovery = run?.diagnostic?.startsWith("invalid input")
    ? "Verify the selected revision and that the endpoint accepts up to 25 checks per request."
    : run?.diagnostic?.startsWith("missing target") ? "Select another installed revision." : "Refresh to try again.";

  return <main className="review-page">
    <div className="review-layout">
      <section className="wb-pane review-chart" aria-label="Access chart" ref={chartPanel}>
        <header className="wb-pane-heading">
          <div className="wb-heading-label">
            <h1>Access chart</h1>
            {scope && <>
              <button type="button" className="wb-icon-button wb-icon-button-quiet" aria-label="Recenter chart" title="Recenter chart"
                onClick={() => chartGraph.current?.recenter()}><TargetIcon size={15} aria-hidden /></button>
              <button type="button" className="wb-icon-button wb-icon-button-quiet" aria-label="Review information"
                popoverTarget={infoId}><Info size={17} aria-hidden /></button>
              <div id={infoId} popover="auto" className="wb-sync-popover" role="region" aria-label="Review information">
                <strong>Review information</strong>
                <dl className="review-info">
                  <div><dt>Start at</dt><dd title={scope.root}>{objectLabel(scope.root)}</dd></div>
                  <div><dt>View as</dt><dd title={subject || undefined}>{subject ? objectLabel(subject) : "—"}</dd></div>
                  {showChecks && <>
                    <div className="review-info-divider">
                      <dt title="Time until the first batch of checks returns">First results</dt>
                      <dd>{firstResults !== undefined ? duration(firstResults) : checking ? "Pending" : "—"}</dd>
                    </div>
                    <div>
                      <dt title="Round-trip times for batches returned after the first">Later batches</dt>
                      <dd>{laterBatches ? <>
                        {duration(laterBatches.sum / laterBatches.count)} average
                        <small>{laterBatches.count === 1 ? "1 batch" :
                          `${laterBatches.count} batches · ${duration(laterBatches.min)}–${duration(laterBatches.max)}`}</small>
                      </> : checking ? "Pending" : "None"}</dd>
                    </div>
                    <div><dt>Total check time</dt><dd>{elapsed !== undefined ? duration(elapsed) : checking ? "In progress" : "—"}</dd></div>
                  </>}
                </dl>
                {showChecks && <>
                  <div role="status">
                    <dl className="review-info review-info-divider">
                      <div><dt>Checks processed</dt><dd>{processed} of {total}</dd></div>
                      <div><dt>Unavailable</dt><dd>{unavailable}</dd></div>
                      <div><dt>Unfinished</dt><dd>{total - processed}</dd></div>
                    </dl>
                    {run?.phase === "cancelled" && <p>Review cancelled</p>}
                    {run?.phase === "timeout" && <p>Review timed out</p>}
                  </div>
                  {run?.phase === "running" && current && <button type="button" onClick={cancel}>Cancel review</button>}
                </>}
              </div>
            </>}
          </div>
          <div className="review-chart-selectors">
            <ReviewPicker label="Start at" value={preferences.root ?? ""} objects={available} preferredType="organization"
              change={(root) => { setCollapsed(new Set()); setSelection(undefined); save({ root }); }} />
            <ReviewPicker label="View as" value={subject} objects={available} preferredType="user"
              change={(subject) => save({ subject })} />
            <button type="button" className="wb-icon-button wb-icon-button-quiet" aria-label="Refresh" title="Refresh review"
              disabled={!target.store || !target.revision} onClick={() => {
              setEpoch((previous) => previous + 1);
            }}><RefreshCw size={16} aria-hidden="true" /></button>
          </div>
        </header>
        {declared.size > 0 && <Disclosure title="Condition context">
          {[...declared].map(([name, types]) => <div key={name}>
            <label>{name}
              <input value={inputs[name] ?? ""} autoComplete="off" aria-invalid={invalid === name}
                placeholder={[...new Set(types.map(({ type_name }) => type_name.replace(/^TYPE_NAME_/, "").toLowerCase()))].join(" or ")}
                onChange={(event) => {
                  setInputs({ ...inputs, [name]: event.target.value });
                  setCheckSelection((previous) => previous + 1);
                }} />
            </label>
            {types.some(({ type_name }) => type_name === "TYPE_NAME_STRING") && !inputs[name] &&
              <label><input type="checkbox" checked={emptyStrings.has(name)} onChange={(event) => {
                const next = new Set(emptyStrings);
                if (event.target.checked) next.add(name);
                else next.delete(name);
                setEmptyStrings(next);
                setCheckSelection((previous) => previous + 1);
              }} />Send an empty string for {name}</label>}
          </div>)}
        </Disclosure>}
        {invalid && <p role="alert">Invalid condition value · {invalid}. Use the declared type shown in the field.</p>}
        {catalog && !available.length && <p>No published instances in this store.</p>}
        {catalog && !loading && !issue && !preferences.root && available.length > 0 &&
          <p>Select a starting instance to review.</p>}
        {scope && !subject && <p>Select a person to evaluate access.</p>}
        {catalog && !catalog.links.length && <p>No scope relationships defined</p>}
        {scope?.resources.length === 1 && <p>No linked resources</p>}
        {removed && <p role="status">{removed} is no longer in the published store. Select another instance or refresh.</p>}
        {issue && <p role="alert">{issue}{scope && " · Stale scope from " + time(scope.observedAt)}
          {run?.observedAt && " · Decisions from " + time(run.observedAt)}
          {issue.includes("· missing target") && " · Select another installed revision."}</p>}
        {loading && <p role="status">Reading published relationships…</p>}
        {(!target.store || !target.revision) && <p>Select a store and an installed model revision.</p>}
        {run?.diagnostic && <p role="alert">Checks unavailable · {run.diagnostic} · {checkRecovery}</p>}
        {scope && <>
          <AccessReviewGraph scope={scope} visible={visible} selection={selection} cardTones={cardTones} branchTones={branchTones}
            highlighted={highlighted} render={(resource) => renderResource(resource, false)} select={selectResource}
            viewportChanged={viewportChanged} ref={chartGraph} />
          {scope.edges.some(({ subject, object, relation }) => highlighted.has(tupleKey({ user: subject, object, relation }))) &&
            <p className="review-legend">Highlighted links show relationships observed after the check.</p>}
        </>}
      </section>
      {scope && <section className="wb-pane review-outline" aria-label="Access outline"><header className="wb-pane-heading"><h2>Access outline</h2></header>
        <div className="review-outline-list" ref={outlineList}><ul>{(children.get(null) ?? []).map(outlineBranch)}</ul></div>
      </section>}
    </div>
    {inspection && <Why current={inspection} previous={!activeWhy} close={closeWhy} panel={whyPanel} />}
  </main>;
}
