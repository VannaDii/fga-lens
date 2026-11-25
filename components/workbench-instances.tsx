"use client";

import { useCallback, useEffect, useImperativeHandle, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import { Info } from "lucide-react";

import type { Draft, InstalledModel, Tuple } from "@/lib/workbench-contract";
import { sameTuple, tupleKey } from "@/lib/workbench-contract";
import { inspectTupleDraft, tupleDraftIssue, tupleIndex, tupleSourceFormat, tupleSourceRange } from "@/lib/workbench-drafts";
import { DirectTuples, indexInstances, InstanceGraph } from "./workbench-instance-graph";
import { TuplePublishDiagnostics, type TuplePublishFeedback } from "./workbench-tuple-diagnostics";
import { Dialog, Disclosure, Select } from "./workbench-ui";
import { SourceEditor } from "./source-editor";
import { highlightStructuredSource, JsonBlock } from "./workbench-source-syntax";

/** Let the shared header open the active Instances screen's existing creation dialog. */
export type InstanceDialogHandle = { openNewInstance: () => void };

/** Show counts from the actual receipt separately from persisted publication history. */
export type TuplePublishCounts = { completed: number; pending: number };

/** Edit tuple source and inspect authored objects and the concrete relationship graph. */
export function InstancesScreen({ draft, model, edit, add, notice, progress, resolve, selections, remember, recover, committingFetch, ref,
  actions, sync, publication, publicationSourceMatches, publishNotice, publishCounts }: {
  draft: Draft; model?: InstalledModel; edit: (yaml: string) => void; add: (value: string) => void;
  actions: ReactNode; sync: ReactNode; committingFetch: boolean; notice: string; progress: ReactNode; recover?: () => void;
  selections?: Record<string, string>; remember: (values: Record<string, string>) => void;
  resolve: (conflict: Draft["conflicts"][number], useServer: boolean) => void; ref: Ref<InstanceDialogHandle>;
  publication?: TuplePublishFeedback; publicationSourceMatches: boolean; publishNotice?: string; publishCounts?: TuplePublishCounts;
}) {
  const [newInstance, setNewInstance] = useState(false);
  const syncInfo = useId();
  useImperativeHandle(ref, () => ({ openNewInstance: () => setNewInstance(true) }), []);
  const [type, setType] = useState("");
  const [id, setId] = useState("");
  const search = selections?.instanceSearch ?? "";
  const filter = selections?.instanceType ?? "";
  const savedFocus = selections?.instanceFocus ?? "";
  const edge = selections?.instanceEdge ?? "";
  const trigger = useRef<HTMLButtonElement>(null);
  const focusPicker = useRef<HTMLSelectElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const { tuples: parsed, issue } = useMemo(() => inspectTupleDraft(draft.yaml), [draft.yaml]);
  const format = useMemo(() => tupleSourceFormat(draft.yaml), [draft.yaml]);
  const highlighted = useMemo(() => highlightStructuredSource(draft.yaml, format), [draft.yaml, format]);
  const records = parsed ?? draft.baseline;
  const types = model?.type_definitions.map((entry) => entry.type) ?? [];
  const instances = useMemo(() => indexInstances(records, draft.inventory), [records, draft.inventory]);
  const objects = useMemo(() => [...instances.keys()].sort(), [instances]);
  const node = instances.has(savedFocus) ? savedFocus : "";
  const selected = useMemo(() => tupleIndex(records).get(edge), [records, edge]);
  const baseline = useMemo(() => tupleIndex(draft.baseline), [draft.baseline]);
  const source = selected && parsed ? tupleSourceRange(draft.yaml, parsed.findIndex((entry) => tupleKey(entry) === edge)) : null;
  const query = search.toLowerCase();
  const completed = publishCounts?.completed ?? draft.tupleCompleted;
  const pending = publishCounts?.pending ?? draft.tuplePending;

  /** Select the exact authored text while keeping keyboard focus in the editor. */
  function jump(start: number, end: number) {
    editor.current?.focus();
    editor.current?.setSelectionRange(start, end);
  }

  /** Scope the filters to neighbor and browse cards while keeping the chosen focus visible. */
  const matches = (value: string) => (!filter || value.startsWith(filter + ":")) && value.toLowerCase().includes(query);

  /** Change the focused neighborhood and keep keyboard position at its picker. */
  function focus(value: string) {
    remember({ instanceFocus: value, instanceEdge: "" });
    focusPicker.current?.focus();
  }

  /** Open the exact tuple and remember the action for Escape or Close focus return. */
  function inspect(tuple: Tuple, button: HTMLButtonElement) {
    trigger.current = button;
    remember({ instanceEdge: tupleKey(tuple) });
    window.requestAnimationFrame(() => inspectorClose.current?.focus());
  }

  /** Return to the action that opened the inspector, or the focus picker if it disappeared. */
  const close = useCallback(() => {
    remember({ instanceEdge: "" });
    window.requestAnimationFrame(() => {
      const opener = trigger.current;
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
      else focusPicker.current?.focus();
    });
  }, [remember]);

  useEffect(() => {
    if (!selected) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open], :popover-open")) close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selected, close]);

  return <main className="wb-split wb-instances">
    <section className="wb-pane" aria-label="Instances">
      <header className="wb-pane-heading">
        <div className="wb-heading-label">
          <h1>Instances</h1>
          <button type="button" className="wb-icon-button wb-icon-button-quiet" aria-label="Tuple sync information"
            popoverTarget={syncInfo}><Info size={17} aria-hidden /></button>
          <div id={syncInfo} popover="auto" className="wb-sync-popover" role="region" aria-label="Tuple sync">
            <strong>Tuple sync</strong>
            {sync}
            {completed !== undefined && <p>{publishCounts ? "This attempt" : "Previous attempt"}
              {" · "}{completed} completed · {pending} pending</p>}
          </div>
        </div>
        {actions}
      </header>
      {progress}
      {notice && <p role="status">{notice}</p>}
      {publishNotice && <p role="status">{publishNotice}</p>}
      {recover && <button onClick={recover}>Download local draft</button>}
      {publication && <TuplePublishDiagnostics feedback={publication} jump={publicationSourceMatches ? (start, end) => {
        if (editor.current?.value === publication.draft.yaml) jump(start, end);
      } : undefined} />}
      {issue && <p role="alert" id="tuple-draft-issue">{tupleDraftIssue(issue)}</p>}
      <p className="wb-tuple-help" id="tuple-source-help">Create an object with <strong>New instance</strong>. In a tuple, <code>user</code> is the subject and can be an organization or another object.</p>
      <div className="live-editor wb-tuple-editor">
        <div className="code-toolbar"><span>tuples.{format}</span></div>
        <SourceEditor aria-label={format === "json" ? "Tuple JSON" : "Tuple YAML"} ref={editor}
          paintLine={(line, index) => highlighted[index]?.length ? highlighted[index] : line}
          diagnosticLines={issue ? new Set([issue.line]) : undefined}
          readOnly={committingFetch} aria-invalid={Boolean(issue)} aria-describedby={issue ? "tuple-source-help tuple-draft-issue" : "tuple-source-help"}
          value={draft.yaml} onChange={(event) => edit(event.target.value)} />
      </div>
      {draft.conflicts.map((conflict) => <Disclosure key={conflict.key} title={"Tuple conflict " + conflict.key}>
        <JsonBlock value={{ local: conflict.local, server: conflict.server }} />
        <div className="wb-actions">
          <button disabled={committingFetch} onClick={() => resolve(conflict, true)}>Use server</button>
          <button disabled={committingFetch} onClick={() => resolve(conflict, false)}>Keep local</button>
        </div>
      </Disclosure>)}
    </section>
    <section className="wb-pane wb-graph-pane">
      <header className="wb-pane-heading"><h2>Instance graph</h2></header>
      <div className="wb-instance-tools">
        <label>Focus instance<select ref={focusPicker} value={node} onChange={(event) => focus(event.target.value)}>
          <option value="">All instances</option>
          {objects.map((object) => <option key={object} value={object}>{object}</option>)}
        </select></label>
        <label>Search instances<input value={search} onChange={(event) => remember({ instanceSearch: event.target.value })} /></label>
        <Select label="Model type" value={filter} options={types} change={(value) => remember({ instanceType: value })} />
      </div>
      <InstanceGraph instances={instances} focused={node} selected={edge} matches={matches} focus={focus} inspect={inspect} />
      {selected && <aside className="wb-inspector" aria-label="Tuple inspector">
        <div className="wb-actions"><strong>Tuple</strong><button type="button" ref={inspectorClose} onClick={close}>Close</button></div>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
        <div className="wb-actions">
          <span>{sameTuple(baseline.get(edge) ?? null, selected) ? "Fetched" : "Local change"}</span>
          {source && <button type="button" onClick={() => jump(source.start, source.end)}>Source line {source.line}</button>}
        </div>
      </aside>}
      <DirectTuples records={records} links={instances.get(node)} inspect={inspect} />
    </section>
    {newInstance && <Dialog title="New instance" iconClose close={() => setNewInstance(false)}>
      <form className="wb-instance-create" onSubmit={(event) => { event.preventDefault(); add(type + ":" + id); setNewInstance(false); }}>
        <Select label="Type" value={type} options={types} change={setType} />
        <label>Instance ID<input required pattern="[^\s:#]+" value={id} onChange={(event) => setId(event.target.value)} /></label>
        <button disabled={!type || !id} type="submit">Create instance</button>
      </form>
    </Dialog>}
  </main>;
}
