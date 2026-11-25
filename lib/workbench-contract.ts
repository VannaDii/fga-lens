import * as t from "io-ts";
import { isLeft } from "fp-ts/Either";

/** JSON data carried by OpenFGA conditions and preserved in raw responses. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Finite JSON values, including recursive arrays and maps. */
export const json: t.Type<Json> = t.recursion("JSON", () => t.union([
  t.null, t.boolean, t.refinement(t.number, Number.isFinite), t.string, t.array(json), t.record(t.string, json),
]));

/** Name-to-value map used by request and tuple conditions. */
export const conditionContext = t.record(t.string, json);
export type ConditionContext = t.TypeOf<typeof conditionContext>;

/** Identifiers are retained verbatim and must contain a non-whitespace character. */
export const nonempty = t.refinement(t.string, (value) => value.trim().length > 0, "Nonempty string");

/** Store and immutable authorization model identifiers are OpenFGA ULIDs. */
export const engineId = t.refinement(t.string, (value) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value), "OpenFGA ID");

/** Field names shared by the authored tuple decoder and source diagnostics. */
export const tupleKeyFields = ["user", "relation", "object"] as const;
export const tupleConditionFields = ["name", "context"] as const;
const tupleFields: ReadonlySet<string> = new Set([...tupleKeyFields, "condition"]);
const conditionFields: ReadonlySet<string> = new Set(tupleConditionFields);

const tupleIdentity = t.type({ user: nonempty, relation: nonempty, object: nonempty });
const conditionName = t.type({ name: nonempty });
const tupleCondition = t.refinement(t.intersection([conditionName, t.partial({ context: conditionContext })]),
  (condition) => Object.keys(condition).every((key) => conditionFields.has(key)));

/** Reject misspelled authored tuple fields before they can change authorization semantics. */
export const tuple = t.refinement(t.intersection([tupleIdentity, t.partial({ condition: tupleCondition })]),
  (tuple) => Object.keys(tuple).every((key) => tupleFields.has(key)));

/** OpenFGA Read includes a null condition for unconditional records. */
export const storedTuple = t.exact(t.intersection([tupleIdentity, t.partial({
  condition: t.union([t.intersection([conditionName, t.partial({ context: t.union([conditionContext, t.null]) })]), t.null]),
})]));
export type Tuple = t.TypeOf<typeof tuple>;

/** Binding for an operation against an installed revision in a specific store. */
export const target = t.type({ store: engineId, revision: engineId });
export type Target = t.TypeOf<typeof target>;

/** One-based line in the DSL generated from an installed model. */
export const modelSourceLine = t.refinement(t.number, (line) => Number.isSafeInteger(line) && line > 0);

/** Accepted subject reference within authorization-model relation metadata. */
const relationRef = t.intersection([t.type({ type: nonempty }), t.partial({
  relation: t.string, condition: t.string, wildcard: t.type({}),
})]);

/** Reference to a named relation in an OpenFGA rewrite. */
const computed = t.intersection([t.type({ relation: nonempty }), t.partial({ object: t.string })]);

/** Recursive shape for the mutually exclusive rewrite branches. */
type Rewrite = {
  this?: object;
  computedUserset?: t.TypeOf<typeof computed>;
  tupleToUserset?: { tupleset: t.TypeOf<typeof computed>; computedUserset: t.TypeOf<typeof computed> };
  union?: { child: Rewrite[] };
  intersection?: { child: Rewrite[] };
  difference?: { base: Rewrite; subtract: Rewrite };
};

/** Decode an OpenFGA rewrite branch and its recursively typed children. */
export const rewrite: t.Type<Rewrite> = t.recursion("Relation rewrite", () => t.refinement(t.exact(t.partial({
  this: t.type({}),
  computedUserset: computed,
  tupleToUserset: t.type({ tupleset: computed, computedUserset: computed }),
  union: t.type({ child: t.array(rewrite) }),
  intersection: t.type({ child: t.array(rewrite) }),
  difference: t.type({ base: rewrite, subtract: rewrite }),
})), (value) => Object.keys(value).length === 1));

/** Parameter definitions can recursively contain list and map element types. */
export type Parameter = { type_name: string; generic_types?: Parameter[] };
export const parameter: t.Type<Parameter> = t.recursion("Condition parameter", () => t.intersection([
  t.type({ type_name: nonempty }), t.partial({ generic_types: t.array(parameter) }),
]));

/** Source metadata and relation metadata emitted by stock OpenFGA. */
const sourceInfo = t.union([t.null, t.partial({ file: t.string })]);
const attributes = t.partial({ module: t.string, source_info: sourceInfo });
const relationMetadata = t.intersection([attributes, t.partial({ directly_related_user_types: t.array(relationRef) })]);
const typeMetadata = t.intersection([attributes, t.partial({ relations: t.record(t.string, relationMetadata) })]);

/** Type definition preserves relation rewrites and relation metadata. */
const definition = t.intersection([t.type({ type: nonempty }), t.partial({
  relations: t.record(t.string, rewrite), metadata: t.union([t.null, typeMetadata]),
})]);

/** Complete, publishable model data excluding its server-assigned ID. */
export const modelContent = t.intersection([t.type({
  schema_version: nonempty, type_definitions: t.array(definition),
}), t.partial({ conditions: t.record(t.string, t.intersection([
  t.type({ name: nonempty, expression: nonempty }),
  t.partial({ parameters: t.record(t.string, parameter), metadata: t.union([attributes, t.null]) }),
])) })]);
export type ModelContent = t.TypeOf<typeof modelContent>;

/** Immutable model returned by the engine. */
export const installedModel = t.intersection([t.type({ id: engineId }), modelContent]);
export type InstalledModel = t.TypeOf<typeof installedModel>;

/** A model-derived user type or userset filter. */
export const userFilter = t.intersection([t.type({ type: nonempty }), t.partial({ relation: nonempty })]);
const queryOptions = t.partial({ tuples: t.array(tuple), context: conditionContext, consistent: t.boolean });
export const checkInput = t.intersection([queryOptions,
  t.type({ operation: t.literal("check"), user: nonempty, object: nonempty, relation: nonempty }),
]);
export type CheckInput = t.TypeOf<typeof checkInput>;

/** Decoded input shared by live queries and regression assertions. */
export const query = t.union([
  checkInput,
  t.intersection([queryOptions, t.type({ operation: t.literal("list-objects"), user: nonempty, type: nonempty, relation: nonempty })]),
  t.intersection([queryOptions, t.type({ operation: t.literal("list-users"), object: nonempty, filter: userFilter, relation: nonempty })]),
]);
export type Query = t.TypeOf<typeof query>;

/** Normal and wildcard users are encoded differently in ListUsers. */
const subjectObject = t.type({ type: nonempty, id: nonempty });
export const checkResponse = t.type({ allowed: t.boolean });
export const objectsResponse = t.type({ objects: t.array(t.string) });
/** ListUsers subjects carry exactly one alternative in the provider oneof. */
const userAlternative = t.refinement(t.union([
  t.type({ object: subjectObject }),
  t.type({ userset: t.intersection([subjectObject, t.type({ relation: nonempty })]) }),
  t.type({ wildcard: t.type({ type: nonempty }) }),
]), (item) => ["object", "userset", "wildcard"].filter((key) => Object.hasOwn(item, key)).length === 1);
export const usersResponse = t.type({ users: t.array(userAlternative) });

/** The recursive tree and its leaf each contain one protobuf alternative. */
const computedLeaf = t.type({ userset: nonempty });
const expansionLeaf = t.refinement(t.partial({
  users: t.type({ users: t.array(t.string) }),
  computed: computedLeaf,
  tupleToUserset: t.type({ tupleset: nonempty, computed: t.array(computedLeaf) }),
}), (leaf) => Object.keys(leaf).length === 1 && Object.keys(leaf).some((item) =>
  ["users", "computed", "tupleToUserset"].includes(item)));

/** Composite OpenFGA Expand node, recursively referencing the same wire shape. */
type ExpansionNode = { name: string; leaf?: t.TypeOf<typeof expansionLeaf>;
  union?: { nodes: ExpansionNode[] }; intersection?: { nodes: ExpansionNode[] };
  difference?: { base: ExpansionNode; subtract: ExpansionNode } };
const expansionNode: t.Type<ExpansionNode> = t.recursion("Expand node", () => t.refinement(t.intersection([
  t.type({ name: nonempty }), t.partial({ leaf: expansionLeaf,
    union: t.type({ nodes: t.array(expansionNode) }), intersection: t.type({ nodes: t.array(expansionNode) }),
    difference: t.type({ base: expansionNode, subtract: expansionNode }),
  }),
]), (node) => ["leaf", "union", "intersection", "difference"].filter((key) => Object.hasOwn(node, key)).length === 1));

/** Fully decoded provider expansion, shared by the engine adapter and evidence receipt. */
export const expansionTree = t.type({ root: expansionNode });
export const expansionResponse = t.type({ tree: expansionTree });
export const outcome = t.union([t.boolean, t.array(t.string)]);

/** One operation and the outcome authored for it. */
const assertion = t.refinement(t.type({ input: query, expected: outcome }),
  ({ input, expected }) => (input.operation === "check") === (typeof expected === "boolean"));

/** Native cases can share names, so the workspace keeps a stable internal case ID. */
const batchCase = t.intersection([t.type({ id: nonempty, name: nonempty, tuples: t.array(tuple), assertions: t.array(assertion) }),
  t.partial({ description: t.string })]);

/** Fixture ownership and installation are recorded per configured connection. */
const installation = t.intersection([t.type({ store: engineId }), t.partial({ source: target, fixture: target })]);
export const batch = t.intersection([t.type({
  id: nonempty, name: nonempty, tuples: t.array(tuple), cases: t.array(batchCase),
}), t.partial({ model: t.string, installations: t.record(t.string, installation) })]);
export type Batch = t.TypeOf<typeof batch>;

/** Complete list of safe operation failure categories. */
export const category = t.keyof({
  "invalid input": null, "missing target": null, authentication: null, connection: null,
  timeout: null, "server error": null, conflict: null, "partial publication": null,
  cancellation: null, "Batch running": null,
});
export type Category = t.TypeOf<typeof category>;

/** Error responses contain classification and generated correlation, without raw exceptions. */
export const failure = t.type({ error: category, correlationId: t.string });
export type Failure = t.TypeOf<typeof failure>;

/** Durable condition-replacement record, written before deleting the original. */
const replacement = t.type({ target, original: tuple, desired: tuple });
const conflict = t.type({ key: t.string, local: t.union([tuple, t.null]), server: t.union([tuple, t.null]) });

/** Local inputs and sync state for one connection and store. */
export const draft = t.intersection([t.type({
  dsl: t.string, validDsl: t.string, yaml: t.string, inventory: t.array(t.string),
  baseline: t.array(tuple), conflicts: t.array(conflict),
}), t.partial({
  published: engineId, publishedDsl: t.string, modelChecked: t.number, modelSelection: t.string, modelManual: t.boolean,
  tuplesChecked: t.number, replacement, tupleCompleted: t.number, tuplePending: t.number,
})]);
export type Draft = t.TypeOf<typeof draft>;

/** The named routes that can be restored by the workbench. */
export const screen = t.keyof({ model: null, instances: null, queries: null, batches: null, explore: null });
export type Screen = t.TypeOf<typeof screen>;

/** Restore saved workspaces from before the Explore route was renamed. */
const savedScreen = new t.Type<Screen>("Saved screen", screen.is, (value, context) =>
  screen.validate(value === "access-review" ? "explore" : value, context), t.identity);

/** A versioned assertion observation with elapsed engine call time. */
const reportRow = t.intersection([t.type({
  caseId: nonempty, caseIndex: t.number, name: nonempty, operation: t.string, expected: outcome,
  status: t.keyof({ pass: null, fail: null, error: null, unrun: null }),
  actual: t.union([outcome, t.null]), elapsed: t.number,
}), t.partial({ failure, assertionIndex: t.number, input: query })]);

/** Persist the source and actual fixture bound to an independently observed run. */
export const report = t.type({ batchId: nonempty, connection: t.string, source: target, fixture: target, rows: t.array(reportRow) });
export type BatchReport = t.TypeOf<typeof report>;

/** Nonnegative, exactly representable workspace revision. */
export const workspaceRevision = t.refinement(t.number, (value) => Number.isSafeInteger(value) && value >= 0);
/** Atomically stored workspace. The authored revision distinguishes edits from server checkpoints. */
export const workspace = t.intersection([t.type({
  revision: workspaceRevision,
  route: savedScreen, store: t.string, model: t.string, autoSave: t.boolean, autoPublish: t.boolean,
  drafts: t.record(t.string, draft), batches: t.array(batch),
}), t.partial({ report, authoredRevision: workspaceRevision, connection: t.string, selections: t.record(t.string, t.string) })]);
export type Workspace = t.TypeOf<typeof workspace>;

/** Receipt returned by workspace operations and connection setup. */
export const workspaceView = t.type({ state: workspace, location: t.string, endpoint: t.string, recovery: t.boolean });
export type WorkspaceView = t.TypeOf<typeof workspaceView>;

/** Decoded outcomes for API operations that mutate workspace state and may partly succeed. */
export const mutationResult = t.intersection([workspaceView, t.partial({ failure })]);

/** Publication diagnostics carry row coordinates and schema choices, never raw tuple keys or provider text. */
const tupleIssueDetail = t.intersection([t.type({ reason: t.keyof({
  yaml: null, schema: null, model: null,
  objectFormat: null, objectLength: null, objectWildcard: null, objectType: null,
  relationFormat: null, relationMissing: null, relationComputed: null,
  userFormat: null, userLength: null, userImplicit: null, userType: null, usersetMissing: null, userRestriction: null,
  conditionName: null, conditionContext: null, conditionSize: null, engine: null,
}) }), t.partial({ allowed: t.array(t.string) })]);
export type TupleIssueDetail = t.TypeOf<typeof tupleIssueDetail>;

/** Resolve issue coordinates against the saved draft, saved baseline, or existing recovery journal. */
const tupleIssue = t.intersection([tupleIssueDetail, t.partial({
  row: t.type({ source: t.keyof({ draft: null, baseline: null, journal: null }), index: workspaceRevision }),
  operation: t.keyof({ add: null, remove: null }),
})]);
export type TupleIssue = t.TypeOf<typeof tupleIssue>;
export const tupleRejection = t.intersection([failure, t.type({ tupleIssues: t.array(tupleIssue) })]);
export const tuplePublicationResult = t.intersection([mutationResult, t.partial({
  tupleProblem: t.type({ phase: t.keyof({ reread: null, write: null }), issue: tupleIssue }),
})]);

/** Names accepted by the OpenFGA CreateStore API. */
export const storeName = t.refinement(nonempty, (value) => /^[A-Za-z0-9\t\n\f\r ./^_&@-]{3,64}$/.test(value), "OpenFGA store name");
export const storeInfo = t.type({ id: engineId, name: nonempty });
export type StoreInfo = t.TypeOf<typeof storeInfo>;
export const storesResponse = t.type({ stores: t.array(storeInfo) });
export const storeDeletion = t.type({ deleted: t.literal(true) });
export const modelsResponse = t.type({ authorization_models: t.array(installedModel) });

/** Original query response, separately from later evidence and with a dispatch timestamp. */
export const queryResult = t.type({
  raw: json, elapsed: t.number, observedAt: t.number, outcome, body: json,
});

/** Engine observations and their source are retained even for an undetermined reason. */
const observedTuple = t.type({ tuple, source: t.keyof({ stored: null, contextual: null }), observedAt: t.number });
const supportingTuple = t.intersection([observedTuple, t.type({
  role: t.keyof({ grant: null, group: null, parent: null, required: null, blocking: null }),
})]);
export type SupportingTuple = t.TypeOf<typeof supportingTuple>;
const observedModelRule = t.intersection([
  t.type({ name: nonempty, expression: t.string }),
  t.partial({ type: nonempty, line: modelSourceLine }),
]);

export const evidenceResult = t.intersection([t.type({
  reason: t.string, rules: t.array(observedModelRule), tuples: t.array(observedTuple), checks: t.array(t.type({ user: t.string, relation: t.string, object: t.string, allowed: t.boolean, observedAt: t.number })),
  expansion: t.union([expansionTree, t.null]), elapsed: t.number,
}), t.partial({ failure, checkReason: t.string, supporting: t.array(supportingTuple) })]);

/** Bounded progress exposed by jobs which may be explicitly cancelled. */
export const progress = t.type({ active: t.boolean, completed: t.number, total: t.union([t.number, t.null]) });

/** Decode a boundary payload without exposing rejected provider data.
 * @param codec Runtime contract.
 * @param value Incoming payload.
 * @returns Decoded data or null for a rejected payload.
 */
export function decode<C extends t.Mixed>(codec: C, value: Parameters<C["decode"]>[0]): t.TypeOf<C> | null {
  const result = codec.decode(value);
  return isLeft(result) ? null : result.right;
}

/** Produce a canonical comparison key for complete wire data. */
export function canonical(value: Json): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Identify a tuple across condition replacements. */
export function tupleKey(value: Tuple) {
  return JSON.stringify([value.user, value.relation, value.object]);
}

/** Compare both the tuple key and optional condition, equating absent and empty context. */
export function sameTuple(first: Tuple | null, second: Tuple | null) {
  const content = (value: Tuple | null): Json => value ? [
    value.user, value.relation, value.object, value.condition?.name ?? null, value.condition?.context ?? {},
  ] : null;
  return canonical(content(first)) === canonical(content(second));
}
