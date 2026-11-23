import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type Node, type YAMLError } from "yaml";

import { defaultModel } from "./fga-model";
import {
  conditionContext, decode, nonempty, sameTuple, tuple, tupleConditionFields, tupleKey, tupleKeyFields,
  type Draft, type Tuple, type Workspace,
} from "./workbench-contract";
import * as t from "io-ts";

/** Initial local state works before any OpenFGA endpoint is connected. */
export const emptyWorkspace: Workspace = {
  revision: 0, route: "model", store: "", model: "", autoSave: true, autoPublish: false, drafts: {}, batches: [],
};

/** Draft defaults for a previously unused endpoint and store. */
export const emptyDraft: Draft = {
  dsl: defaultModel, validDsl: defaultModel, yaml: "[]\n", inventory: [], baseline: [], conflicts: [],
};

const tupleSequence = t.array(tuple);

/** Safe YAML error location and edit guidance for the author's local editor. */
type DraftIssue = { line: number; column: number; guidance: string; row?: number };

/** A rejected document never supplies a fallback tuple sequence. */
type TupleDraft = { tuples: Tuple[]; issue: null } | { tuples: null; issue: DraftIssue };

/** Give parser errors a local repair instruction without a source excerpt. */
function syntaxAdvice(error: YAMLError) {
  if (error.message.startsWith("Flow sequence") && error.message.endsWith("]")) {
    return "Close the flow sequence with a ] before the next field.";
  }
  if (error.message.startsWith("Flow map") && error.message.endsWith("}")) {
    return "Close the flow mapping with a } before the next field.";
  }
  if (error.message.startsWith("Missing closing")) return "Close the text with its matching quote.";
  switch (error.code) {
    case "ALIAS_PROPS": return "Remove the anchor or tag from this alias.";
    case "BAD_ALIAS": return "Use the name of an anchor defined earlier in this document.";
    case "BAD_DIRECTIVE": return "Correct the YAML directive or remove it.";
    case "BAD_INDENT": return "Align this field with the surrounding fields using spaces.";
    case "TAB_AS_INDENT": return "Replace the indentation tab with spaces.";
    case "BAD_DQ_ESCAPE": return "Correct the escape or use single quotes for literal text.";
    case "BAD_PROP_ORDER": return "Place the anchor and tag before the value.";
    case "BAD_SCALAR_START": return "Quote this value if the first character is literal text.";
    case "BLOCK_AS_IMPLICIT_KEY": return "Use a single text key or quote the entire field name.";
    case "BLOCK_IN_FLOW": return "Use [] or {} for a nested collection in flow-style YAML.";
    case "DUPLICATE_KEY": return "Keep one occurrence of this mapping field.";
    case "KEY_OVER_1024_CHARS": return "Use a shorter field name.";
    case "MULTILINE_IMPLICIT_KEY": return "Keep the field name on one line.";
    case "MULTIPLE_ANCHORS": return "Keep one anchor on this value.";
    case "MULTIPLE_DOCS": return "Combine all tuple rows into one YAML sequence.";
    case "MULTIPLE_TAGS": return "Keep one tag on this value.";
    case "NON_STRING_KEY": return "Quote the field name so the parser reads it as text.";
    case "RESOURCE_EXHAUSTION": return "Reduce nesting or replace repeated aliases with explicit values.";
    case "TAG_RESOLVE_FAILED": return "Remove the unsupported tag or use a native YAML value.";
    case "BAD_COLLECTION_TYPE": return "Use a mapping for tuple fields and a sequence for the tuple list.";
    default: return "Correct the token or delimiter at the reported location and try again.";
  }
}

/** Locate the authored key node for one tuple or condition field. */
function mappingKey(node: Node | null | undefined, name: string) {
  return isMap(node) ? node.items.find(({ key }) => isScalar(key) && key.value === name) : undefined;
}

/** Choose the exact key offset when the source contains the field. */
function fieldOffset(node: Node | null | undefined, name: string, fallback: number) {
  const field = mappingKey(node, name)?.key;
  return isScalar(field) ? field.range?.[0] ?? fallback : fallback;
}

/** Locate the first alias whose anchor is absent or follows it in the document. */
function unresolvedAliasOffset(document: ReturnType<typeof parseDocument>) {
  let offset: number | undefined;
  visit(document, { Alias: (_, alias) => {
    if (alias.resolve(document)) return;
    offset = alias.range?.[0] ?? 0;
    return visit.BREAK;
  } });
  return offset;
}

/** Decode a complete authored tuple sequence and return the first source-level issue. */
export function inspectTupleDraft(source: string): TupleDraft {
  const lines = new LineCounter();
  let parsed: ReturnType<typeof parseDocument> | undefined;
  /** Report a safe location in the exact buffer this call inspected. */
  const reject = (guidance: string, offset = 0, row?: number): TupleDraft => {
    const { line, col } = lines.linePos(offset);
    return { tuples: null, issue: { line: line || 1, column: col || 1, guidance, row } };
  };
  try {
    const document = parseDocument(source, { lineCounter: lines, prettyErrors: false, stringKeys: true, logLevel: "silent" });
    parsed = document;
    const error = document.errors[0] ?? document.warnings[0];
    if (error) {
      const cause = error.message.split("\n")[0].slice(0, 160);
      return reject(cause + " · " + syntaxAdvice(error), error.pos[0]);
    }
    const sequence = document.contents;
    if (!isSeq(sequence)) {
      return reject("Start with a tuple list, such as - user: user:alex. Use [] for an intentionally empty list.",
        sequence?.range?.[0]);
    }
    const result = tupleSequence.decode(document.toJS());
    if (result._tag === "Left") {
      const { context } = result.left[0];
      const index = Number(context[1]?.key);
      const item = sequence.items[index];
      const base = item?.range?.[0] ?? 0;
      const row = Number.isSafeInteger(index) ? index + 1 : undefined;
      const fields = decode(conditionContext, context[1]?.actual);
      if (!fields) {
        const field = context.find(({ key }) => key === "condition" || tupleKeyFields.some((name) => name === key))?.key;
        const guidance = field === "condition" ? "Give condition a name and an optional context mapping with JSON values."
          : field ? "Enter " + field + " as nonempty text."
            : "Write each tuple as a mapping with user, relation and object fields.";
        return reject(guidance, field ? fieldOffset(item, field, base) : base, row);
      }
      const extra = Object.keys(fields).find((key) => key !== "condition" && !tupleKeyFields.some((name) => name === key));
      if (extra !== undefined) {
        return reject("Remove or correct the unsupported field " + JSON.stringify(extra) + ". Use user, relation, object and optional condition.",
          fieldOffset(item, extra, base), row);
      }
      for (const key of tupleKeyFields) {
        if (!nonempty.is(fields[key])) return reject("Enter " + key + " as nonempty text.", fieldOffset(item, key, base), row);
      }
      const condition = decode(conditionContext, fields.condition);
      const conditionAt = fieldOffset(item, "condition", base);
      const conditionField = mappingKey(item, "condition");
      const conditionNode = isMap(conditionField?.value) ? conditionField.value : undefined;
      if (!condition) return reject("Write condition as a mapping with a name and optional context.", conditionAt, row);
      const conditionExtra = Object.keys(condition).find((key) => !tupleConditionFields.some((name) => name === key));
      if (conditionExtra !== undefined) {
        return reject("Remove or correct the unsupported condition field " + JSON.stringify(conditionExtra) + ". Use name or context.",
          fieldOffset(conditionNode, conditionExtra, conditionAt), row);
      }
      if (!nonempty.is(condition.name)) {
        return reject("Enter condition.name as nonempty text.", fieldOffset(conditionNode, "name", conditionAt), row);
      }
      if (condition.context !== undefined && !conditionContext.is(condition.context)) {
        return reject("Write condition.context as a mapping with JSON values.", fieldOffset(conditionNode, "context", conditionAt), row);
      }
      return reject("Write condition with a name and optional context mapping.", conditionAt, row);
    }

    const seen = new Map<string, number>();
    for (const [index, record] of result.right.entries()) {
      const key = tupleKey(record);
      const prior = seen.get(key);
      if (prior !== undefined) {
        return reject("This entry repeats the user, relation and object from tuple " + prior + ". Keep one entry for that key.",
          sequence.items[index]?.range?.[0], index + 1);
      }
      seen.set(key, index + 1);
    }
    return { tuples: result.right, issue: null };
  } catch (error) {
    if (error instanceof ReferenceError) {
      const cause = error.message.split("\n")[0].slice(0, 160);
      const offset = parsed && cause.startsWith("Unresolved alias") ? unresolvedAliasOffset(parsed) : undefined;
      const guidance = offset === undefined ? "Replace the affected aliases with explicit fields."
        : "Define the referenced anchor before its alias or replace the alias with an explicit value.";
      return reject(cause + " · " + guidance, offset);
    }
    if (error instanceof RangeError) return reject("Tuple data is nested too deeply. Reduce nesting or replace recursive aliases with explicit fields.");
    return reject("The YAML values could not be read. Use plain mappings and lists for tuple data.");
  }
}

/** Format only safe diagnostic text for the local editor and Fetch status. */
export function tupleDraftIssue(issue: DraftIssue) {
  const row = issue.row === undefined ? "" : "Tuple " + issue.row + " · ";
  return row + "Line " + issue.line + ", column " + issue.column + " · " + issue.guidance;
}

/** Read a tuple sequence without turning invalid text into deletions. */
export function readYaml(source: string) {
  return inspectTupleDraft(source).tuples;
}

/** Index tuples by the engine's replacement identity. */
export function tupleIndex(tuples: Tuple[]) {
  return new Map(tuples.map((item) => [tupleKey(item), item]));
}

/** Retain native YAML comments and untouched sequence entries when values change. */
function patchTupleSource(source: string, before: Tuple[], after: Tuple[]) {
  const former = tupleIndex(before);
  const desired = tupleIndex(after);
  if (desired.size === former.size && after.every((entry) => sameTuple(entry, former.get(tupleKey(entry)) ?? null))) {
    return source;
  }
  const lines = new LineCounter();
  const document = parseDocument(source, { lineCounter: lines, logLevel: "silent" });
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const updated = desired.get(tupleKey(before[index]));
    if (!updated) document.deleteIn([index]);
    else if (!sameTuple(before[index], updated)) document.setIn([index], updated);
  }
  for (const entry of after) if (!former.has(tupleKey(entry))) document.add(entry);
  try {
    return document.toString();
  } catch (error) {
    const alias = unresolvedAliasOffset(document);
    if (alias === undefined) throw error;
    const { line, col } = lines.linePos(alias);
    throw new Error(tupleDraftIssue({ line, column: col,
      guidance: "This change would remove the anchor used by this alias. Replace the alias with an explicit value and save the draft." }));
  }
}

/** Apply a complete fetched snapshot against the latest draft and baseline. */
export function mergeFetched(draft: Draft, local: Tuple[], remote: Tuple[]): Draft {
  const base = tupleIndex(draft.baseline);
  const ours = tupleIndex(local);
  const theirs = tupleIndex(remote);
  const conflicts: Draft["conflicts"] = [];
  const pending = new Set(draft.conflicts.map((conflict) => conflict.key));
  const merged: Tuple[] = [];
  for (const key of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const previous = base.get(key) ?? null;
    const current = ours.get(key) ?? null;
    const fetched = theirs.get(key) ?? null;
    const localChanged = !sameTuple(previous, current);
    const serverChanged = !sameTuple(previous, fetched);
    if (((localChanged && serverChanged) || pending.has(key)) && !sameTuple(current, fetched)) {
      conflicts.push({ key, local: current, server: fetched });
    }
    const choice = localChanged ? current : fetched;
    if (choice) merged.push(choice);
  }
  return { ...draft, baseline: remote, yaml: patchTupleSource(draft.yaml, local, merged), conflicts, tuplesChecked: Date.now() };
}


/** Tuple inspector and publication issue fields that may have their own source range. */
export type TupleSourceField = "object" | "relation" | "user" | "condition" | "condition.name" | "condition.context";

/** Parse once and locate each tuple or field using the authored sequence order. */
export function tupleSourceLookup(source: string) {
  const lines = new LineCounter();
  const document = parseDocument(source, { lineCounter: lines, logLevel: "silent" });
  const rows = isSeq(document.contents) ? document.contents.items : [];
  return (index: number, field?: TupleSourceField) => {
    const row = rows[index];
    if (!row?.range) return null;
    const [key, nested] = field?.split(".") ?? [];
    const value = key && isMap(row) ? row.get(key, true) : undefined;
    const node = nested && isMap(value) ? value.get(nested, true) : value;
    const range = (isScalar(node) || isMap(node) || isSeq(node) ? node.range : undefined) ?? row.range;
    const { line, col } = lines.linePos(range[0]);
    return { start: range[0], end: range[1], line, column: col };
  };
}

/** Find an authored tuple row for the existing graph inspector. */
export function tupleSourceRange(source: string, index: number) {
  return index < 0 ? null : tupleSourceLookup(source)(index);
}


/** A pending replacement is independent of conflicts for other authored tuple keys. */
export function publicationConflicts(draft: Draft) {
  if (!draft.replacement) return draft.conflicts.length > 0;
  const identity = tupleKey(draft.replacement.original);
  return draft.conflicts.some((conflict) => conflict.key === identity);
}

/** Apply a resolution to a single buffer while preserving newer journaled input and unrelated text. */
export function resolveTupleSource(source: string, conflict: Draft["conflicts"][number], useServer: boolean, journaled: boolean) {
  if (!useServer) return source;
  const records = readYaml(source);
  if (!records) return source;
  const current = tupleIndex(records).get(conflict.key) ?? null;
  if (sameTuple(current, conflict.server) || (journaled && !sameTuple(current, conflict.local))) return source;
  const merged = records.filter((entry) => tupleKey(entry) !== conflict.key);
  if (conflict.server) merged.push(conflict.server);
  return patchTupleSource(source, records, merged);
}
