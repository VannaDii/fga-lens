"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import * as t from "io-ts";
import {
  decode, evidenceResult, json, modelsResponse, query, queryResult, sameTuple, tupleKey,
  type Batch, type ConditionContext, type Draft, type InstalledModel, type Json, type Parameter, type Target,
} from "@/lib/workbench-contract";
import { readYaml, tupleIndex } from "@/lib/workbench-drafts";
import { contextValue, inspectableListEntry, invalidContext, parameters } from "@/lib/workbench-models";
import { queryRequest } from "@/lib/workbench-query-request";
import { QueryResults, type CapturedQuery } from "./workbench-query-results";
import { JsonBlock } from "./workbench-source-syntax";
import { Dialog, Disclosure, invoke, revisionOptions, Select } from "./workbench-ui";

const operations = [
  { value: "check", label: "Check" }, { value: "list-objects", label: "ListObjects" },
  { value: "list-users", label: "ListUsers" },
];

/** Read stored selections while preserving an invalid editor value for correction. */
function selectedKeys(value: string) {
  try { return decode(t.array(t.string), JSON.parse(value)) ?? []; }
  catch { return []; }
}

/** Give a condition field a distinct namespace for its declared types. */
function conditionKey(name: string, types: Parameter[]) {
  return "query-context/" + name + "/" + JSON.stringify([...new Set(types.map((type) => JSON.stringify(type)))].sort());
}

/** Select a represented value or explicitly include independent typed input. */
function ConditionFields({ declared, values, inputs, remember }: {
  declared: Map<string, Parameter[]>; values: Map<string, Json[]>; inputs: Record<string, string>;
  remember: (value: Record<string, string>) => void;
}) {
  return <Disclosure title="Condition context">
    {[...declared].map(([name, types]) => {
      const key = conditionKey(name, types);
      const represented = (values.get(name) ?? []).map((value) => JSON.stringify(value));
      const chosen = inputs[key + "/choice"];
      const selected = inputs[key + "/source"] === "workspace" && chosen && represented.includes(chosen) ? chosen : "";
      const included = inputs[key + "/include"] === "yes" && (inputs[key + "/source"] !== "workspace" || Boolean(selected));
      return <div key={name}>
        <label><input type="checkbox" checked={included} onChange={(event) => remember({
          [key + "/include"]: event.target.checked ? "yes" : "", ...(!selected ? { [key + "/source"]: "manual" } : {}),
        })} /> Include {name}</label>
        {represented.length > 0 && <Select label={name + " context source"} value={selected ? "choice:" + selected : "entry"}
          options={[{ value: "entry", label: "Enter a value" }, ...represented.map((value) => ({
            value: "choice:" + value, label: value,
          }))]} change={(value) => remember({
            [key + "/source"]: value.startsWith("choice:") ? "workspace" : "manual",
            [key + "/choice"]: value.startsWith("choice:") ? value.slice(7) : "",
            ...(value.startsWith("choice:") ? { [key + "/include"]: "yes" } : {}),
          })} />}
        {!selected && <label>{name}<input value={inputs[key + "/text"] ?? ""} onChange={(event) => remember({
          [key + "/text"]: event.target.value, [key + "/source"]: "manual", [key + "/include"]: "yes",
        })} />
          <small>{[...new Set(types.map((type) => type.type_name.replace("TYPE_NAME_", "").toLowerCase()))].join(" or ")}</small>
        </label>}
      </div>;
    })}
    {!declared.size && <p>The selected revision has no condition parameters.</p>}
  </Disclosure>;
}

/** Build and run application requests from the primary revision and local identifiers. */
export function QueryScreen({ draft, target, model, storeList, batches, selections, remember, saveBatch }: {
  draft: Draft; target: Target; model?: InstalledModel; storeList: Array<{ id: string; name: string }>;
  batches: Batch[]; selections?: Record<string, string>; remember: (value: Record<string, string>) => void;
  saveBatch: (value: Batch) => Promise<void>;
}) {
  const inputs = selections ?? {};
  const operation = operations.find((entry) => entry.value === inputs.operation)?.value ?? "check";
  const user = inputs.user ?? "";
  const object = inputs.object ?? "";
  const type = inputs.type ?? "";
  const relation = inputs.relation ?? "";
  const filter = inputs.filter ?? "";
  const compare = inputs.compare === "yes";
  const alternateStore = storeList.find((entry) => entry.id === inputs.alternateStore)?.id ?? "";
  const alternateRevision = inputs.alternateRevision ?? "";
  const [search, setSearch] = useState("");
  const [alternateModels, setAlternateModels] = useState<InstalledModel[]>([]);
  const [captured, setCaptured] = useState<CapturedQuery[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [entries, setEntries] = useState<Record<number, string>>({});
  const local = useMemo(() => readYaml(draft.yaml) ?? [], [draft.yaml]);
  const baseline = useMemo(() => tupleIndex(draft.baseline), [draft.baseline]);
  const temporary = selectedKeys(inputs["query-tuples/" + target.store] ?? "");
  const definitions = model?.type_definitions ?? [];
  const stored = new Set(draft.baseline.flatMap((entry) => [entry.user, entry.object]));
  const identifiers = [...new Set([...stored, ...draft.inventory, ...local.flatMap((entry) => [entry.user, entry.object])])].sort();
  const display = (value: string) => ({ value, label: value + (stored.has(value) ? "" : " (local only)") });
  const visible = (value: string) => value === user || value === object || value.toLowerCase().includes(search.toLowerCase());
  const objects = identifiers.filter((value) => !value.includes("#") && !value.endsWith(":*")
    && definitions.some((entry) => entry.type === value.split(":")[0]));
  const users = identifiers.filter((value) => definitions.some((entry) => entry.type === value.split(":")[0]));
  const filters = definitions.flatMap((entry) => [entry.type, ...Object.keys(entry.relations ?? {}).map((rel) => entry.type + "#" + rel)]);
  const selectedUser = users.includes(user) ? user : "";
  const selectedObject = objects.includes(object) ? object : "";
  const selectedType = operation === "list-objects" ? definitions.find((entry) => entry.type === type)?.type ?? ""
    : selectedObject.split(":")[0];
  const selectedFilter = filters.includes(filter) ? filter : "";
  const alternateRevisions = revisionOptions(alternateModels)
    .filter(({ value }) => alternateStore !== target.store || value !== target.revision);
  const selectedAlternateRevision = alternateStore && alternateRevisions.some(({ value }) => value === alternateRevision)
    ? alternateRevision : "";
  const relations = Object.keys(definitions.find((entry) => entry.type === selectedType)?.relations ?? {});
  const selectedRelation = relations.includes(relation) ? relation : "";
  const declared = model ? parameters(model) : new Map<string, Parameter[]>();
  const represented = new Map<string, Json[]>();
  for (const tuple of [...draft.baseline, ...local]) {
    for (const [name, value] of Object.entries(tuple.condition?.context ?? {})) {
      if (!declared.has(name) || invalidContext({ [name]: value }, declared)) continue;
      const values = represented.get(name) ?? [];
      if (!values.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) represented.set(name, [...values, value]);
    }
  }
  const obsolete = JSON.stringify([...declared].flatMap(([name, types]) => {
    const key = conditionKey(name, types);
    return inputs[key + "/source"] === "workspace"
      && !represented.get(name)?.some((value) => JSON.stringify(value) === inputs[key + "/choice"]) ? [key] : [];
  }));
  useEffect(() => {
    const keys = selectedKeys(obsolete);
    if (keys.length) queueMicrotask(() => remember(Object.fromEntries(keys.flatMap((key) =>
      [[key + "/include", ""], [key + "/choice", ""], [key + "/source", "manual"]]))));
  }, [obsolete, remember]);
  const candidates = local.filter((tuple) => !sameTuple(tuple, baseline.get(tupleKey(tuple)) ?? null));
  const incompatible = {
    user: Boolean(user) && !users.includes(user),
    object: Boolean(object) && !objects.includes(object),
    type: Boolean(type) && !definitions.some((entry) => entry.type === type),
    filter: Boolean(filter) && !filters.includes(filter),
    relation: Boolean(relation) && !selectedRelation,
  };

  /** Clear incompatible saved selections after the installed model and inventory resolve. */
  useEffect(() => {
    if (!model) return;
    const updates: Record<string, string> = {};
    if (incompatible.user) updates.user = "";
    if (incompatible.object) updates.object = "";
    if (incompatible.type) updates.type = "";
    if (incompatible.filter) updates.filter = "";
    if (incompatible.relation) updates.relation = "";
    if (Object.keys(updates).length) queueMicrotask(() => remember(updates));
  }, [model, incompatible.user, incompatible.object, incompatible.type, incompatible.filter, incompatible.relation, remember]);

  /** Load alternate revisions without modifying primary request inputs. */
  useEffect(() => {
    if (!alternateStore || !compare) return;
    let active = true;
    void invoke(modelsResponse, { action: "models", store: alternateStore }).then((result) => {
      if (active) setAlternateModels(result.authorization_models);
    }).catch((error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [alternateStore, compare]);

  /** Apply later observations only to the exact captured result still on screen. */
  async function collect(side: CapturedQuery, index: number, selected?: string) {
    if (!side.result) return;
    const job = crypto.randomUUID();
    const patch = (update: Partial<CapturedQuery>) => setCaptured((rows) => rows.map((row, position) =>
      position === index && row.input === side.input ? { ...row, ...update } : row));
    patch({ job, error: undefined });
    try {
      const evidence = await invoke(evidenceResult, { action: "evidence", target: side.target, input: side.input,
        outcome: side.result.outcome, selected, job });
      patch({ evidence });
    } catch (error) {
      patch({ error: error instanceof Error ? error.message : "server error" });
    } finally {
      patch({ job: undefined });
    }
  }

  /**
   * Build one immutable operation and execute primary and alternate requests independently.
   * Each side can inspect its own returned list entries and captured workspace candidates.
   */
  async function run(event: MouseEvent<HTMLButtonElement>) {
    const missing = event.currentTarget.closest(".workbench")?.querySelector<HTMLSelectElement>('select[required][aria-invalid="true"]');
    if (missing) {
      setMessage("");
      missing.focus();
      return;
    }
    const context: ConditionContext = Object.fromEntries([...declared].flatMap(([name, types]) => {
      const key = conditionKey(name, types);
      if (inputs[key + "/include"] !== "yes") return [];
      if (inputs[key + "/source"] !== "workspace") return [[name, contextValue(inputs[key + "/text"] ?? "", types)]];
      const value = represented.get(name)?.find((entry) => JSON.stringify(entry) === inputs[key + "/choice"]);
      return value === undefined ? [] : [[name, value]];
    }));
    const invalid = invalidContext(context, declared);
    if (invalid) { setMessage("Invalid condition value · " + invalid); return; }
    const [userType, userset] = selectedFilter.split("#");
    const contextual = candidates.filter((tuple) => temporary.includes(tupleKey(tuple)));
    const input = decode(query, {
      operation, user: selectedUser, object: selectedObject,
      type: selectedType, relation: selectedRelation, filter: { type: userType,
        ...(userset ? { relation: userset } : {}) }, context, tuples: contextual,
    });
    if (!input || !target.store || !model || (compare && !selectedAlternateRevision)) {
      setMessage("Check the query inputs.");
      return;
    }
    const targets = [target, ...(compare ? [{ store: alternateStore, revision: selectedAlternateRevision }] : [])];
    const listEntries = identifiers.filter((identity) => inspectableListEntry(input, identity));
    const requests = targets.map((queryTarget) => ({
      id: crypto.randomUUID(), target: queryTarget, input, listEntries,
      storeName: storeList.find((store) => store.id === queryTarget.store)?.name,
      request: decode(json, queryRequest(input, queryTarget.revision)),
    }));
    if (requests.some((side) => side.request === null)) { setMessage("Invalid request or more than 100 contextual tuples"); return; }
    const sides = requests.map((side) => ({ ...side, sentAt: Date.now() }));
    setMessage("");
    setRunning(true);
    setEntries({});
    setCaptured(sides);
    await Promise.all(sides.map(async (side, index) => {
      try {
        const result = await invoke(queryResult, { action: "query", target: side.target, input });
        const returned = typeof result.outcome === "boolean" ? []
          : result.outcome.filter((identity) => inspectableListEntry(input, identity));
        const listEntries = [...new Set([...side.listEntries, ...returned])].sort();
        setCaptured((prior) => prior.map((row) => row.id === side.id ? { ...row, result, listEntries } : row));
        if (input.operation === "check") await collect({ ...side, result }, index);
      } catch (error) {
        const message = error instanceof Error ? error.message : "server error";
        setCaptured((prior) => prior.map((row, position) => index === position ? { ...row, error: message } : row));
      }
    }));
    setRunning(false);
  }

  return <main className="wb-split">
    <section className="wb-pane wb-form">
      <header className="wb-pane-heading"><h1>Query request</h1></header>
      <div className="wb-fields">
        <Select label="Operation" required value={operation} options={operations} change={(operation) => {
          if (operation) remember({ operation });
        }} />
        <label>Search identifiers<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        {operation !== "list-users" && <Select label="View as" required value={selectedUser}
          options={users.filter(visible).map(display)} change={(user) => remember({ user })} />}
        {operation !== "list-objects" && <Select label="Object" required value={selectedObject}
          options={objects.filter(visible).map(display)} change={(object) => remember({ object })} />}
        {operation === "list-objects" && <Select label="Object type" required value={selectedType}
          options={definitions.map((entry) => entry.type)} change={(type) => remember({ type })} />}
        <Select label="Relation" required value={selectedRelation} options={relations} change={(relation) => remember({ relation })} />
        {operation === "list-users" && <Select label="User type or userset" required value={selectedFilter} options={filters}
          change={(filter) => remember({ filter })} />}
      </div>
      {!(operation === "list-users" ? objects.length : users.length) && <Link href="/instances">Open Instances to add or fetch IDs</Link>}
      <ConditionFields declared={declared} values={represented} inputs={inputs} remember={remember} />
      <Disclosure title="Contextual tuples" open>
        {candidates.map((tuple) => {
          const key = tupleKey(tuple);
          return <label key={key}><input type="checkbox" checked={temporary.includes(key)} onChange={(event) => {
            const next = event.target.checked ? [...temporary, key] : temporary.filter((value) => value !== key);
            remember({ ["query-tuples/" + target.store]: JSON.stringify(next) });
          }} />{tuple.user} · {tuple.relation} · {tuple.object}</label>;
        })}
        {!candidates.length && <p><Link href="/instances">Add a local relationship in Instances to try a grant.</Link></p>}
      </Disclosure>
      <Disclosure title="Compare" open={compare} onOpenChange={(open) => remember({ compare: open ? "yes" : "no" })}>
        {compare && <>
          <div className="wb-fields">
            <Select label="Alternate store" required value={alternateStore}
              options={storeList.map((store) => ({ value: store.id, label: store.name }))}
              change={(store) => { setAlternateModels([]); remember({ alternateStore: store, alternateRevision: "" }); }} />
            <Select label="Alternate revision" required value={selectedAlternateRevision} options={alternateRevisions} title={selectedAlternateRevision || undefined}
              change={(alternateRevision) => remember({ alternateRevision })} />
          </div>
          {alternateStore === target.store && alternateModels.length > 0 && !alternateRevisions.length &&
            <p className="wb-result-note">Choose a different store or close Compare.</p>}
        </>}
      </Disclosure>
      <div className="wb-actions wb-form-actions wb-query-actions">
        <button onClick={run} disabled={running}>Run</button>
        <button onClick={() => setSaving(true)} disabled={!captured.some((side) => side.result)}>Save query</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
    <QueryResults captured={captured} entries={entries}
      selectEntry={(index, entry) => setEntries((prior) => ({ ...prior, [index]: entry }))}
      checkEntry={collect} />
    {saving && <SaveQuery captured={captured} batches={batches} save={saveBatch} close={() => setSaving(false)} />}
  </main>;
}

/** Save or replace one named case using the selected successful response and expectation. */
function SaveQuery({ captured, batches, save, close }: {
  captured: CapturedQuery[]; batches: Batch[]; save: (value: Batch) => Promise<void>; close: () => void;
}) {
  const successes = captured.filter((side) => side.result !== undefined);
  const [sideId, setSideId] = useState(successes[0].id);
  const [destination, setDestination] = useState(batches[0]?.id ?? "");
  const [name, setName] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const [separate, setSeparate] = useState(false);
  const [expectedEdit, setExpectedEdit] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const side = successes.find((result) => result.id === sideId) ?? successes[0];
  const authored = batches.find((entry) => entry.id === destination);
  const current = authored ?? { name: "Saved queries", tuples: [], cases: [] };
  const fixture = tupleIndex(current.tuples);
  const replacements = (side.input.tuples ?? []).flatMap((tuple) => {
    const previous = fixture.get(tupleKey(tuple));
    return previous && !sameTuple(previous, tuple) ? [{ previous, tuple }] : [];
  });
  const selected = separate && replacements.length ? undefined : authored;
  const existing = selected?.cases.filter((entry) => entry.name === name) ?? [];
  const collision = existing.length === 1 ? existing[0] : existing.find((entry) => entry.id === occurrence);
  const initial = side.result?.outcome ?? false;
  const expected = expectedEdit === null ? initial : typeof initial === "boolean" ? expectedEdit === "true"
    : expectedEdit.split("\n").map((identifier) => identifier.trim()).filter(Boolean);
  const shared = tupleIndex(current.tuples);
  if (!selected && separate) for (const replacement of replacements) shared.set(tupleKey(replacement.tuple), replacement.tuple);
  const next = { name, tuples: (side.input.tuples ?? []).filter((tuple) => !sameTuple(tuple, shared.get(tupleKey(tuple)) ?? null)),
    assertions: [{ input: side.input, expected }] };

  return <Dialog title="Save query" close={close}>
    <form onSubmit={(event) => {
      event.preventDefault();
      setPending(true);
      const entry = { id: crypto.randomUUID(), ...next };
      const output = selected ? {
        ...selected, cases: collision ? selected.cases.map((prior) => prior.id === collision.id ? entry : prior) : [...selected.cases, entry],
      } : { id: crypto.randomUUID(), name: separate ? current.name + " · effective fixture" : current.name,
        tuples: [...shared.values()], cases: [entry] };
      void save(output).then(close).catch((error) => {
        setNotice(error.message + " · Retry Save");
        setPending(false);
      });
    }}>
      <Select label="Expectation source" value={sideId} options={successes.map((side) => ({
        value: side.id, label: side.target.store + " · " + side.target.revision,
      }))} change={(value) => { if (value) { setSideId(value); setExpectedEdit(null); } }} />
      <Select label="Destination batch" value={destination} options={batches.map((entry) => ({
        value: entry.id, label: entry.name,
      }))} change={(value) => { setDestination(value); setOccurrence(""); }} />
      {!destination && <p>Save in a new batch named Saved queries.</p>}
      <label>Case name<input required value={name} onChange={(event) => { setName(event.target.value); setOccurrence(""); }} /></label>
      {typeof initial === "boolean" ? <Select label="Expected result" value={String(expected)}
        options={["true", "false"]} change={(value) => { if (value) setExpectedEdit(value); }} />
        : <label>Expected identifiers, one per line<textarea value={expectedEdit ?? initial.join("\n")}
          onChange={(event) => setExpectedEdit(event.target.value)} /></label>}
      <p>Not run</p>
      {replacements.length > 0 && <><JsonBlock value={replacements} />
        <label><input type="checkbox" checked={separate} onChange={(event) => setSeparate(event.target.checked)} />
          Save separate batch with effective fixture</label></>}
      {existing.length > 1 && <Select label="Matching case occurrence" value={occurrence}
        options={existing.map((entry) => ({ value: entry.id, label: "Case " + ((selected?.cases.findIndex((caseEntry) => caseEntry.id === entry.id) ?? 0) + 1) }))}
        change={setOccurrence} />}
      {collision && <JsonBlock value={{ previous: collision, next }} />}
      {notice && <p role="status">{notice}</p>}
      <div className="wb-actions"><button type="submit" disabled={Boolean(pending || !name.trim()
        || (existing.length && !collision) || (replacements.length && !separate))}>
        {existing.length ? "Overwrite" : "Save"}</button><button type="button" onClick={close}>Cancel</button></div>
    </form>
  </Dialog>;
}
