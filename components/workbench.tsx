"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import * as t from "io-ts";

import { FgaLens, LogoMark } from "./fga-lens";
import { QueryScreen } from "./workbench-queries";
import { BatchScreen } from "./workbench-batches";
import { InstancesScreen, type InstanceDialogHandle, type TuplePublishCounts } from "./workbench-instances";
import type { TuplePublishFeedback } from "./workbench-tuple-diagnostics";
import { useWorkbenchState } from "./workbench-state";
import { Dialog, download, failureText, invoke, JobStatus, Select, TuplePublishRejection } from "./workbench-ui";
import {
  engineId, modelsResponse, sameTuple, screen, storesResponse, tuple, tupleKey, tuplePublicationResult, workspaceView,
  type Draft, type InstalledModel, type Target, type Tuple, type Workspace, type WorkspaceView,
} from "@/lib/workbench-contract";
import {
  emptyDraft, inspectTupleDraft, mergeFetched, publicationConflicts, readYaml, resolveTupleSource, tupleDraftIssue, tupleIndex,
} from "@/lib/workbench-drafts";

const screens = { model: "Model", instances: "Instances", queries: "Queries", batches: "Batches" };
type Editor = "model" | "instances";

/** Identify the editor snapshot that can receive a diagnostic source jump. */
type TupleAttempt = { selectedRevision: string; draft: Draft };

/** Keep the last outcome for a store separate from the status of local saves and fetches. */
type TuplePublication = {
  notice?: string;
  report?: TupleAttempt & TuplePublishFeedback;
  counts?: TuplePublishCounts;
};

/** Attach safe issues to the captured draft, including a replacement's original revision. */
function tupleIssueReport(
  attempt: TupleAttempt | undefined, phase: TuplePublishFeedback["phase"], issues: TuplePublishFeedback["issues"],
): TuplePublication["report"] {
  if (!attempt) return undefined;
  return { ...attempt, phase, issues, revision: attempt.draft.replacement?.target.revision ?? attempt.selectedRevision };
}

/** Patch one store draft without mutating unrelated local or saved data. */
function changeDraft(prior: Workspace, key: string, update: (draft: Draft) => Draft) {
  return { ...prior, drafts: { ...prior.drafts, [key]: update(prior.drafts[key] ?? emptyDraft) } };
}

/** Copy only the editor that was explicitly saved. */
function savedEditor(kind: Editor, input: Draft) {
  return kind === "model" ? { dsl: input.dsl, validDsl: input.validDsl }
    : { yaml: input.yaml, inventory: input.inventory, conflicts: input.conflicts };
}

/** Compare native tuple content independently of YAML formatting and ordering. */
function tupleChanges(records: Tuple[], baseline: Tuple[]) {
  const stored = tupleIndex(baseline);
  return records.length !== stored.size || records.some((row) => !sameTuple(row, stored.get(tupleKey(row)) ?? null));
}

/** Report synchronization for the visible editor and the time of its last check. */
function EditorSync({ editor, draft }: { editor: Editor; draft: Draft }) {
  const model = editor === "model";
  const checked = model ? draft.modelChecked : draft.tuplesChecked;
  const local = model ? null : readYaml(draft.yaml);
  const status = model
    ? draft.dsl !== draft.validDsl ? "Draft issues" : draft.published && draft.publishedDsl === draft.dsl ? "In sync" : "Local draft"
    : draft.conflicts.length ? "Conflict" : draft.replacement ? "Interrupted" : !local ? "Draft issues"
      : tupleChanges(local, draft.baseline) ? "Pending edits" : checked ? "In sync" : "Unfetched";
  const time = checked ? new Date(checked) : null;
  return <span className="wb-toolbar-sync" aria-live="polite">{model ? "Model" : "Tuples"} · {status}
    {time && Number.isFinite(time.getTime()) && <> · <time dateTime={time.toISOString()}>{time.toLocaleTimeString()}</time></>}
  </span>;
}

/** Check whether a save actually contains a new publishable edit. */
function editedForPublication(kind: Editor, previous: Draft, next: Draft) {
  if (kind === "model") return next.dsl !== previous.dsl && next.dsl === next.validDsl;
  const current = readYaml(next.yaml);
  const saved = readYaml(previous.yaml) ?? previous.baseline;
  return current && tupleChanges(current, saved) && tupleChanges(current, previous.baseline);
}

/** Require a parseable buffer before a fetched snapshot can advance its merge basis. */
function mergeableTuples(draft: Draft, saved: boolean) {
  const result = inspectTupleDraft(draft.yaml);
  if (result.issue) throw new Error((saved ? "Saved tuple YAML · " : "") + tupleDraftIssue(result.issue)
    + (saved ? " Save the corrected draft before fetching." : ""));
  return result.tuples;
}

/** Identify which authored buffer prevents a fetched merge, including source rewrite errors. */
function mergeFetchedDraft(draft: Draft, fetched: Tuple[], saved: boolean) {
  const rows = mergeableTuples(draft, saved);
  try {
    return mergeFetched(draft, rows, fetched);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The fetched tuples could not be merged.";
    throw new Error((saved ? "Saved tuple YAML · " : "") + reason);
  }
}

/** Keep the workbench alive across screen changes and scope every edit to its captured store. */
export function Workbench({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, current, change, accept, persist, savedRevision, trackCheckpoint, durable } = useWorkbenchState();
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [storeList, setStoreList] = useState<t.TypeOf<typeof storesResponse>["stores"]>([]);
  const [revisions, setRevisions] = useState<InstalledModel[]>([]);
  const [connected, setConnected] = useState(false);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const [editorNotices, setEditorNotices] = useState<Record<string, string>>({});
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const [fetchJob, setFetchJob] = useState("");
  const [fetchCommitKey, setFetchCommitKey] = useState<string | null>(null);
  const [activePublishes, setActivePublishes] = useState<string[]>([]);
  const [failedModel, setFailedModel] = useState<Record<string, string>>({});
  const [tuplePublications, setTuplePublications] = useState<Record<string, TuplePublication>>({});
  const instanceDialog = useRef<InstanceDialogHandle>(null);
  const selectionEpoch = useRef(new Map<string, number>());
  /** Latest model Publish attempt per endpoint and store, independent of receipt ordering. */
  const modelAttempts = useRef(new Map<string, symbol>());
  const tupleEpoch = useRef(new Map<string, number>());
  const fetchApplies = useRef(new Map<string, Promise<void>>());
  const jobs = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const route = pathname.slice(1);
  const active = screen.is(route) ? route : "model";
  const endpoint = view?.endpoint ?? "";
  const store = state.store;
  const keyFor = (id: string) => endpoint + "/" + id;
  const key = keyFor(store);
  const draft = state.drafts[key] ?? (store ? emptyDraft : state.drafts[keyFor("")] ?? emptyDraft);
  const modelNotice = editorNotices["model/" + key] ?? "";
  const tupleNotice = editorNotices["instances/" + key] ?? "";
  const tuplePublication = tuplePublications[key];
  const target: Target = { store, revision: state.model };
  const model = revisions.find((entry) => entry.id === target.revision);

  /** Provide scoped feedback and keep rejected editor data in the local view. */
  const showError = useCallback((label: string, error: Error, set: (message: string) => void = setNotice) => {
    set(label + " · " + error.message + (error.message.startsWith("conflict")
      ? " · Local input retained. Download the draft before reloading." : " · Retry the operation"));
  }, []);

  /** Load the file workspace and migrate legacy content only before the first file save. */
  useEffect(() => {
    let live = true;
    void invoke(workspaceView).then((receipt) => {
      if (!live) return;
      const recognized = window.location.pathname.slice(1);
      accept(receipt, (_, loaded) => loaded);
      setView(receipt);
      if (!receipt.state.revision && !receipt.recovery) {
        let dsl: string | null = null;
        let validDsl: string | null = null;
        try {
          dsl = localStorage.getItem("fga-lens:model-draft:v1");
          validDsl = localStorage.getItem("fga-lens:last-valid-model:v1");
        } catch { /* Editor state remains available when browser storage is blocked. */ }
        if (dsl !== null || validDsl !== null) {
          const importDraft = (prior: Workspace) => changeDraft(prior, receipt.endpoint + "/", (base) => ({
            ...base, dsl: dsl ?? base.dsl, validDsl: validDsl ?? base.validDsl,
          }));
          change(importDraft);
          void persist(importDraft).catch((error) => showError("Save legacy draft", error));
        }
      }
      if (!recognized) router.replace("/" + receipt.state.route);
    }).catch((error) => showError("Load workspace", error));
    return () => { live = false; };
  }, [accept, change, persist, router, showError]);

  /** Persist direct route visits and browser history navigation as well as navigation links. */
  useEffect(() => {
    if (!view || !screen.is(route)) return;
    queueMicrotask(() => {
      if (current.current.route === route) return;
      const update = (prior: Workspace) => ({ ...prior, route });
      change(update);
      void persist(update).catch((error) => showError("Save screen", error));
    });
  }, [view, route, current, change, persist, showError]);

  /** Refresh available stores without publishing or blocking local drafts. */
  const loadStores = useCallback(async () => {
    try {
      const result = await invoke(storesResponse, { action: "stores" });
      setStoreList(result.stores);
      setConnected(true);
      setNotice((prior) => prior.startsWith("Connect to OpenFGA") ? "" : prior);
    } catch (error) {
      setConnected(false);
      showError("Connect to OpenFGA", error instanceof Error ? error : new Error("connection"));
    }
  }, [showError]);

  useEffect(() => {
    if (view) queueMicrotask(() => { void loadStores(); });
  }, [view, loadStores]);

  /** Keep an intentionally selected revision, with the newest installed option as first default. */
  useEffect(() => {
    if (!store || !view) return;
    let live = true;
    const capturedKey = endpoint + "/" + store;
    void invoke(modelsResponse, { action: "models", store }).then(({ authorization_models }) => {
      if (!live) return;
      setRevisions(authorization_models);
      if (current.current.model || !authorization_models.length) return;
      const revision = authorization_models[0].id;
      const selectDefault = (prior: Workspace) => prior.store === store && !prior.model
        ? { ...changeDraft(prior, capturedKey, (draft) => ({ ...draft, modelSelection: revision, modelManual: false })), model: revision } : prior;
      change(selectDefault);
      void persist(selectDefault).catch((error) => showError("Save model revision", error));
    }).catch((error) => { if (live) showError("Load model revisions", error); });
    return () => { live = false; };
  }, [store, view, endpoint, current, change, persist, showError]);

  /** Apply a non-editor preference or selection without including unsaved draft data. */
  const remember = useCallback((update: (prior: Workspace) => Workspace) => {
    change(update);
    if (view) void persist(update).catch((error) => showError("Save workspace preference", error));
  }, [change, persist, showError, view]);

  /** Store named UI selections without capturing either editor buffer. */
  const rememberKeys = useCallback((selections: Record<string, string>) => {
    remember((prior) => ({ ...prior, selections: { ...prior.selections, ...selections } }));
  }, [remember]);

  /**
   * Apply only server-owned fields to the captured local draft.
   * Reconcile an older model reply from the current acknowledged snapshot if that snapshot still confirms the publication.
   * @param receipt A Publish or tuple conflict resolution receipt.
   * @param capturedKey The originating endpoint and store key.
   * @param capturedStore The originating store.
   * @param kind Which editor owns the server fields.
   * @param dispatchSelection Selection epoch when publication started.
   * @param resolution The exact local tuple conflict to resolve, if applicable.
   */
  function acceptDraft(
    receipt: WorkspaceView, capturedKey: string, capturedStore: string, kind: Editor, dispatchSelection?: number,
    resolution?: { identity: string; source: (draft: Draft) => string },
  ) {
    /** Merge the operation's confirmed fields while retaining newer live input and selections. */
    const merge = (local: Workspace, persisted: Workspace) => {
      const confirmed = persisted.drafts[capturedKey];
      if (!confirmed) return local;
      const follows = (selectionEpoch.current.get(capturedKey) ?? 0) === dispatchSelection;
      if (kind === "model") {
        const next = changeDraft(local, capturedKey, (draft) => ({
          ...draft, published: confirmed.published, publishedDsl: confirmed.publishedDsl, modelChecked: confirmed.modelChecked,
          modelSelection: follows ? confirmed.modelSelection : draft.modelSelection,
          modelManual: follows ? confirmed.modelManual : draft.modelManual,
        }));
        return follows && local.store === capturedStore && persisted.store === capturedStore ? { ...next, model: persisted.model } : next;
      }
      return changeDraft(local, capturedKey, (draft) => ({
        ...draft, baseline: confirmed.baseline, replacement: confirmed.replacement,
        conflicts: resolution ? [...confirmed.conflicts, ...draft.conflicts.filter((item) =>
          item.key !== resolution.identity && !confirmed.conflicts.some((saved) => saved.key === item.key))] : confirmed.conflicts,
        tupleCompleted: confirmed.tupleCompleted, tuplePending: confirmed.tuplePending, tuplesChecked: confirmed.tuplesChecked,
        yaml: resolution?.source(draft) ?? draft.yaml,
      }));
    };
    const acknowledged = durable.current;
    if (kind === "model" && receipt.state.revision < acknowledged.revision) {
      const completed = receipt.state.drafts[capturedKey];
      const latest = acknowledged.drafts[capturedKey];
      if (completed?.published && latest?.published === completed.published
        && latest.publishedDsl === completed.publishedDsl && latest.modelChecked === completed.modelChecked) {
        change((local) => merge(local, acknowledged));
      }
      return;
    }
    accept(receipt, merge, !resolution);
  }

  /** Report an editor operation on the store where it was initiated. */
  function editorMessage(kind: Editor, storeKey: string, message: string) {
    setEditorNotices((notices) => ({ ...notices, [kind + "/" + storeKey]: message }));
  }

  /**
   * Save one editor and publish just the newly saved edit to its captured target.
   * Model checkpoints reconcile independently of which attempt owns the visible feedback.
   * @param kind The editor being saved.
   * @param capturedStore The initiating store.
   * @param revision The installed revision captured for a tuple publication.
   * @param output The editor buffer captured for this save.
   * @param explicit Whether Publish was requested directly.
   */
  async function saveEditor(kind: Editor, capturedStore: string, revision: string, output: Draft, explicit: boolean) {
    const capturedKey = keyFor(capturedStore);
    let modelAttempt: symbol | undefined;
    /** Allow model feedback only from the most recently dispatched attempt for this target. */
    const ownsFeedback = () => !modelAttempt || modelAttempts.current.get(capturedKey) === modelAttempt;
    /** Apply a status message while its attempt still owns the feedback. */
    const set = (message: string) => {
      if (ownsFeedback()) editorMessage(kind, capturedKey, message);
    };
    /** Publish feedback belongs to the initiating store even while another target is visible. */
    const setPublication = (result: TuplePublication) =>
      setTuplePublications((previous) => ({ ...previous, [capturedKey]: result }));
    const label = kind === "model" ? "Publish model" : "Publish tuples";
    const activityKey = kind + "/" + capturedKey;
    const automatic = current.current.autoPublish && Boolean(capturedStore) && (kind === "model" || Boolean(revision));
    let tupleAttempt: TupleAttempt | undefined;
    let shouldPublish = explicit;
    let publicationStarted = false;
    try {
      const saved = await persist((prior) => changeDraft(prior, capturedKey, (draft) => {
        shouldPublish ||= automatic && Boolean(editedForPublication(kind, draft, output));
        return { ...draft, ...savedEditor(kind, output) };
      }));
      const savedDraft = saved.drafts[capturedKey];
      if (kind === "instances" && shouldPublish && savedDraft && publicationConflicts(savedDraft)) {
        setPublication({ notice: "Publish tuples · Resolve tuple conflicts first" });
        return;
      }
      if (!shouldPublish || !capturedStore) {
        setEditorNotices((notices) => kind === "model" && notices[activityKey]?.startsWith("Publish model ·")
          ? notices : { ...notices, [activityKey]: "Saved to workspace" });
        return;
      }
      if (kind === "instances") {
        if (savedDraft) tupleAttempt = { selectedRevision: revision, draft: savedDraft };
        set("");
        setPublication({ notice: "Publishing…" });
      } else {
        modelAttempt = Symbol();
        modelAttempts.current.set(capturedKey, modelAttempt);
        set("Publishing…");
      }
      publicationStarted = true;
      setActivePublishes((active) => [...active, activityKey]);
      const dispatchSelection = selectionEpoch.current.get(capturedKey) ?? 0;
      if (kind === "instances") tupleEpoch.current.set(capturedKey, (tupleEpoch.current.get(capturedKey) ?? 0) + 1);
      const receipt = await trackCheckpoint(invoke(tuplePublicationResult, kind === "model"
        ? { action: "publish-model", store: capturedStore, revision: saved.revision }
        : { action: "publish-tuples", target: { store: capturedStore, revision }, revision: saved.revision })
        .then((receipt) => {
          acceptDraft(receipt, capturedKey, capturedStore, kind, dispatchSelection);
          return receipt;
        }));
      if (kind === "model" && ownsFeedback()) setFailedModel((failures) => {
        const next = { ...failures };
        delete next[capturedKey];
        return next;
      });
      const tupleReceipt = kind === "instances" ? receipt.state.drafts[capturedKey] : undefined;
      const counts = tupleReceipt?.tupleCompleted !== undefined && tupleReceipt.tuplePending !== undefined
        ? { completed: tupleReceipt.tupleCompleted, pending: tupleReceipt.tuplePending } : undefined;
      if (receipt.failure) {
        const notice = label + " · " + failureText(receipt.failure) + (receipt.tupleProblem && receipt.failure.error === "invalid input"
          ? "" : " · Publish again");
        if (kind === "instances") {
          const problem = receipt.tupleProblem;
          setPublication({ notice, counts, report: problem && tupleIssueReport(tupleAttempt, problem.phase, [problem.issue]) });
        } else set(notice);
        return;
      }
      if (kind === "model" && ownsFeedback() && current.current.store === capturedStore) {
        const fresh = await invoke(modelsResponse, { action: "models", store: capturedStore });
        if (ownsFeedback() && current.current.store === capturedStore) setRevisions(fresh.authorization_models);
      }
      if (kind === "instances") setPublication({ notice: "Tuple changes published", counts });
      else set("Model published");
    } catch (error) {
      if (shouldPublish && kind === "model" && ownsFeedback()) {
        setFailedModel((failures) => ({ ...failures, [capturedKey]: output.dsl }));
      }
      if (error instanceof TuplePublishRejection) {
        const report = tupleIssueReport(tupleAttempt, "preflight", error.issues);
        setPublication(report ? { report } : { notice: "Publish blocked · No tuple writes were made in this attempt." });
      } else {
        showError(shouldPublish ? label : "Save editor", error instanceof Error ? error : new Error("server error"),
          shouldPublish && kind === "instances" ? (notice) => setPublication({ notice }) : set);
      }
    } finally {
      if (publicationStarted) setActivePublishes((active) => {
        const position = active.indexOf(activityKey);
        return position === -1 ? active : [...active.slice(0, position), ...active.slice(position + 1)];
      });
    }
  }

  /** Debounce typing independently for each editor and captured store. */
  function saveCurrent(kind: Editor, publish = false, auto = false) {
    const activityKey = kind + "/" + key;
    clearTimeout(jobs.current.get(activityKey));
    jobs.current.delete(activityKey);
    /** Wait for an already-arrived fetch snapshot before capturing the editor buffer. */
    const dispatch = async () => {
      if (kind === "instances") await fetchApplies.current.get(key);
      if (auto && !current.current.autoSave) return;
      const currentDraft = current.current.drafts[key] ?? draft;
      await saveEditor(kind, store, target.revision, currentDraft, publish);
    };
    if (!auto) {
      void dispatch();
      return;
    }
    if (!current.current.autoSave) return;
    const timer = setTimeout(() => {
      jobs.current.delete(activityKey);
      void dispatch();
    }, 320);
    jobs.current.set(activityKey, timer);
  }

  /** Restore the independent draft and model selection when switching stores. */
  function selectStore(next: string) {
    setRevisions([]);
    const capturedKey = keyFor(next);
    remember((prior) => {
      const fallback = !store && next ? { ...emptyDraft, ...savedEditor("model", prior.drafts[key] ?? emptyDraft) } : emptyDraft;
      const nextDraft = prior.drafts[capturedKey] ?? fallback;
      return { ...changeDraft(prior, capturedKey, () => nextDraft), store: next, model: nextDraft.modelSelection ?? "",
        selections: { ...prior.selections, ["primary-store/" + endpoint]: next } };
    });
  }

  /** Persist the engineer's selected revision separately from model publication. */
  function selectRevision(revision: string) {
    selectionEpoch.current.set(key, (selectionEpoch.current.get(key) ?? 0) + 1);
    remember((prior) => ({ ...changeDraft(prior, key, (draft) => ({
      ...draft, modelSelection: revision, modelManual: Boolean(revision && revision !== draft.published),
    })), model: revision }));
  }

  /** Fetch all pages and commit both validated merges together for the captured store. */
  async function fetchTuples() {
    const job = crypto.randomUUID();
    setFetchJob(job);
    editorMessage("instances", key, "");
    try {
      mergeableTuples(current.current.drafts[key] ?? emptyDraft, false);
      mergeableTuples(durable.current.drafts[key] ?? emptyDraft, true);
      const dispatch = tupleEpoch.current.get(key) ?? 0;
      const fetched = await invoke(t.type({ tuples: t.array(tuple) }), { action: "fetch-tuples", store, job });
      let mergedEditor: Draft | undefined;
      const applied = persist((state) => {
        if (dispatch !== (tupleEpoch.current.get(key) ?? 0)) throw new Error("A later tuple publication superseded this fetch");
        const live = current.current.drafts[key] ?? emptyDraft;
        const saved = state.drafts[key] ?? emptyDraft;
        mergedEditor = mergeFetchedDraft(live, fetched.tuples, false);
        const mergedSaved = mergeFetchedDraft(saved, fetched.tuples, true);
        // Rendering the lock synchronously prevents a new edit between validation and the save receipt.
        flushSync(() => setFetchCommitKey(key));
        return changeDraft(state, key, () => mergedSaved);
      }).then(() => {
        const merged = mergedEditor;
        if (!merged) return;
        change((state) => changeDraft(state, key, (latest) => ({
          ...latest, yaml: merged.yaml, baseline: merged.baseline, conflicts: merged.conflicts, tuplesChecked: merged.tuplesChecked,
        })));
      });
      const settled = applied.then(() => undefined, () => undefined);
      fetchApplies.current.set(key, settled);
      try {
        await applied;
      } finally {
        if (fetchApplies.current.get(key) === settled) fetchApplies.current.delete(key);
        setFetchCommitKey((current) => current === key ? null : current);
      }
      editorMessage("instances", key, "Fetched " + fetched.tuples.length + " tuples");
    } catch (error) {
      showError("Fetch store tuples", error instanceof Error ? error : new Error("server error"), (text) => editorMessage("instances", key, text));
    } finally { setFetchJob(""); }
  }

  /** Persist a tuple conflict choice without triggering an automatic publication. */
  async function resolveTuple(conflict: Draft["conflicts"][number], useServer: boolean) {
    try {
      await fetchApplies.current.get(key);
      const revision = await savedRevision();
      const localSource = (local: Draft) => {
        const journaled = Boolean(local.replacement && tupleKey(local.replacement.original) === conflict.key);
        return resolveTupleSource(local.yaml, conflict, useServer, journaled);
      };
      if (!durable.current.drafts[key]?.conflicts.some((entry) => entry.key === conflict.key)) {
        change((state) => changeDraft(state, key, (draft) => ({
          ...draft, yaml: localSource(draft), conflicts: draft.conflicts.filter((entry) => entry.key !== conflict.key),
        })));
        return;
      }
      const receipt = await invoke(workspaceView, { action: "resolve-tuple", store, identity: conflict.key, useServer, revision });
      acceptDraft(receipt, key, store, "instances", undefined, { identity: conflict.key, source: localSource });
    } catch (error) {
      showError("Resolve tuple conflict", error instanceof Error ? error : new Error("server error"), (text) => editorMessage("instances", key, text));
    }
  }

  /** Remember either persistent settings button as the dialog's focus return target. */
  function openSettings(event: MouseEvent<HTMLButtonElement>) {
    event.currentTarget.focus();
    setSettings(true);
  }

  if (route && !screen.is(route)) return children;
  const editor = active === "model" || active === "instances" ? active : null;
  const tupleReport = tuplePublication?.report;
  const tupleSourceMatches = tupleReport?.selectedRevision === target.revision && tupleReport.draft.yaml === draft.yaml;
  const storeName = storeList.find((entry) => entry.id === store)?.name;
  const usePublished = draft.published && draft.published !== state.model;
  const publishLabel = editor === "model"
    ? modelNotice.startsWith("Publish model ·") ? failedModel[key] === draft.dsl ? "Publish again" : "Publish new draft" : "Publish"
    : tupleReport?.phase !== "preflight" && (draft.replacement || tuplePublication?.notice?.includes("Publish again"))
      ? "Publish again" : "Publish";
  return <div className="workbench">
    <header className="wb-header">
      <div className="wb-header-main">
        <div className="wb-header-navigation">
          <div className="brand-lockup"><LogoMark /><strong>FGA Lens</strong></div>
          <nav aria-label="Workbench">{Object.entries(screens).map(([path, label]) =>
            <Link key={path} href={"/" + path} aria-current={active === path ? "page" : undefined}>{label}</Link>)}</nav>
        </div>
        <div className="wb-header-context">
          {active !== "batches" && <>
            <div className="wb-header-target">
              <Select label="Store" value={store} title={storeName ? `${storeName} · ${store}` : store || undefined}
                options={storeList.map((item) => ({ value: item.id, label: item.name }))} change={selectStore} />
              <Select label="Model revision" value={state.model} title={state.model || undefined}
                options={revisions.map((entry) => entry.id)} change={selectRevision} />
            </div>
            {!storeList.length && <button type="button" onClick={(event) => {
              event.currentTarget.focus();
              setCreate(true);
            }}>Create store</button>}
          </>}
          <div className="wb-header-services">
            <button type="button" className="wb-connection" data-connected={connected || undefined}
              onClick={openSettings}>{connected ? "Connected" : "Offline"}</button>
            <button type="button" onClick={openSettings}>Settings</button>
          </div>
        </div>
      </div>
      {editor && <div className="wb-toolbar">
        {editor === "instances" && <>
          <button type="button" onClick={(event) => {
            event.currentTarget.focus();
            instanceDialog.current?.openNewInstance();
          }}>New instance</button>
          <button type="button" onClick={fetchTuples} disabled={!store || Boolean(fetchJob)}>Fetch store tuples</button>
        </>}
        <button type="button" disabled={editor === "model" && !view} onClick={() => saveCurrent(editor)}>Save</button>
        <div className="wb-toolbar-publish">
          <button type="button" className="wb-publish" disabled={!(editor === "model" ? store : target.revision)
            || activePublishes.includes(editor + "/" + key)} onClick={() => saveCurrent(editor, true)}>{publishLabel}</button>
          <EditorSync editor={editor} draft={draft} />
        </div>
      </div>}
    </header>
    {view?.recovery && <p role="status" className="wb-notice">Saved workspace could not be decoded · {view.location} ·
      <Link prefetch={false} download href="/api/workbench?recovery">Download saved workspace</Link></p>}
    {notice && !settings && !create && <p role="status" className="wb-notice">{notice}</p>}
    {active === "model" && <>
      {(modelNotice || usePublished) && <div className="wb-actions wb-editor-feedback">
        {modelNotice.includes("conflict") && <button onClick={() => download("local-model-draft.fga", draft.dsl)}>Download local draft</button>}
        {usePublished
          && <button onClick={() => selectRevision(draft.published ?? "")}>Use published revision</button>}
        {modelNotice && <span role="status">{modelNotice}</span>}
      </div>}
      {view && <FgaLens key={key} draft={draft} relationId={state.selections?.["model-relation/" + key]}
        onRelation={(id) => rememberKeys({ ["model-relation/" + key]: id })} onDraft={(dsl, validDsl) => {
        change((prior) => changeDraft(prior, key, (draft) => ({ ...draft, dsl, validDsl: validDsl ?? draft.validDsl })));
        saveCurrent("model", false, true);
      }} />}
    </>}
    {active === "instances" && <InstancesScreen key={key} draft={draft} model={model} ref={instanceDialog}
      publication={tupleReport} publicationSourceMatches={tupleSourceMatches}
      publishNotice={tuplePublication?.notice} publishCounts={tuplePublication?.counts}
      selections={Object.fromEntries(Object.entries(state.selections ?? {}).filter(([name]) => name.startsWith(key + "/instance"))
        .map(([name, value]) => [name.slice(key.length + 1), value]))}
      remember={(values) => rememberKeys(Object.fromEntries(Object.entries(values).map(([name, value]) => [key + "/" + name, value])))}
      edit={(yaml) => {
        change((prior) => changeDraft(prior, key, (draft) => ({ ...draft, yaml })));
        saveCurrent("instances", false, true);
      }}
      add={(instance) => {
        const update = (prior: Workspace) => changeDraft(prior, key, (draft) => ({
          ...draft, inventory: [...new Set([...draft.inventory, instance])],
        }));
        change(update);
        if (current.current.autoSave) void persist(update).catch((error) => showError("Save instance", error, (text) => editorMessage("instances", key, text)));
      }}
      recover={tupleNotice.includes("conflict") || tuplePublication?.notice?.includes("conflict")
        ? () => download("local-tuple-draft.yaml", draft.yaml) : undefined}
      resolve={resolveTuple} committingFetch={fetchCommitKey === key} notice={tupleNotice}
      progress={fetchJob && <JobStatus key={fetchJob} id={fetchJob} label="Fetching store tuples" unit="pages" />} />}
    {active === "queries" && <QueryScreen {...{
      draft, target, model, storeList, batches: state.batches, selections: state.selections,
      remember: rememberKeys,
      saveBatch: (batch) => {
        const update = (prior: Workspace) => ({
          ...prior, batches: prior.batches.some((entry) => entry.id === batch.id)
            ? prior.batches.map((entry) => entry.id === batch.id ? batch : entry) : [...prior.batches, batch],
        });
        return persist(update).then(() => change(update));
      },
    }} />}
    {active === "batches" && <BatchScreen state={state} target={target} stores={storeList} endpoint={endpoint}
      remember={rememberKeys}
      add={async (batch) => {
        const update = (prior: Workspace) => ({ ...prior, batches: [...prior.batches, batch] });
        await persist(update);
        change(update);
      }}
      savedRevision={savedRevision} trackCheckpoint={trackCheckpoint}
      apply={(receipt) => accept(receipt, (prior, persisted) => ({ ...prior, batches: persisted.batches, report: persisted.report }), true)} />}
    {settings && <Dialog title="Settings" close={() => setSettings(false)}>
      <dl><dt>Endpoint</dt><dd>{endpoint || "Unavailable"}</dd><dt>Workspace</dt><dd>{view?.location ?? "Loading"}</dd>
        <dt>Connection</dt><dd>{connected ? "Connected" : "Offline"}</dd></dl>
      <label><input type="checkbox" checked={state.autoSave} onChange={(event) => {
        const autoSave = event.target.checked;
        remember((prior) => ({ ...prior, autoSave }));
      }} /> Auto-save</label>
      <label><input type="checkbox" checked={state.autoPublish} onChange={(event) => {
        const autoPublish = event.target.checked;
        remember((prior) => ({ ...prior, autoPublish }));
      }} /> Auto-publish</label>
      <button onClick={loadStores}>Retry connection</button>
      {notice.startsWith("Connect to OpenFGA") && <p role="status">{notice}</p>}
    </Dialog>}
    {create && <Dialog title="Create store" close={() => setCreate(false)}>
      <form onSubmit={(event) => {
        event.preventDefault();
        void invoke(t.type({ id: engineId }), { action: "create", name }).then((created) => {
          selectStore(created.id);
          setCreate(false);
          return loadStores();
        }).catch((error) => showError("Create store", error));
      }}><label>Store name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="submit">Create store</button></form>
      {notice.startsWith("Create store") && <p role="status">{notice}</p>}
    </Dialog>}
  </div>;
}
