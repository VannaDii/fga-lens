import { transformer, validator } from "@openfga/syntax-transformer";

import {
  canonical, decode, json, modelContent, type ConditionContext, type Json, type ModelContent, type Parameter,
  type Tuple, type TupleIssueDetail,
} from "./workbench-contract";

/** Parse the complete model. The graph uses its own display projection of this data.
 * @param source OpenFGA DSL.
 * @returns Validated model, or null when its wire shape cannot be decoded.
 * @throws The syntax transformer's diagnostic on invalid DSL.
 */
export function parseModelContent(source: string) {
  validator.validateDSL(source);
  return decode(modelContent, transformer.transformDSLToJSONObject(source));
}

/** Keep CEL tokens separate while ignoring formatting outside quoted literals. */
function expressionKey(expression: string) {
  const lexemes = /(?:[bB][rR]?|[rR][bB]?)?(?:"""[\s\S]*?"""|\x27\x27\x27[\s\S]*?\x27\x27\x27|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\/[^\n]*|(?:0[xX][\dA-Fa-f]+[uU]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+[uU]?)|[\w]+|==|!=|<=|>=|&&|\|\||[^\s]/g;
  return [...expression.matchAll(lexemes)].map(([token]) => token).filter((token) => !token.startsWith("//"));
}

/** Remove empty protobuf containers while retaining meaningful model fields. */
function omitEmpty(value: Json): Json {
  if (Array.isArray(value)) return value.map(omitEmpty);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const normalized = omitEmpty(entry);
    const emptyString = normalized === "" && ["condition", "file", "module", "object", "relation"].includes(key);
    const empty = normalized === null || emptyString || (typeof normalized === "object" && Object.keys(normalized).length === 0);
    const significant = key === "this" || key === "wildcard";
    return empty && !significant ? [] : [[key, normalized]];
  }));
}

/** Compare complete publishable content while ignoring transport defaults, IDs and DSL formatting. */
export function modelFingerprint(content: ModelContent) {
  const { id: ignored, ...data } = { id: "", ...content };
  void ignored;
  const conditionValues = Object.entries(content.conditions ?? {}).map(([key, condition]) => [
    key, { ...condition, expression: expressionKey(condition.expression) },
  ]);
  const decoded = decode(json, JSON.parse(JSON.stringify({ ...data, conditions: Object.fromEntries(conditionValues) })));
  return canonical(omitEmpty(decoded));
}

/** Render applicable installed rules in DSL for evidence. */
export function modelDsl(content: ModelContent) {
  return transformer.transformJSONStringToDSL(JSON.stringify(content));
}

/** Resolve condition parameters advertised by an installed model. */
export function parameters(content: ModelContent) {
  const values = new Map<string, Parameter[]>();
  for (const condition of Object.values(content.conditions ?? {})) {
    for (const [name, parameter] of Object.entries(condition.parameters ?? {})) {
      values.set(name, [...(values.get(name) ?? []), parameter]);
    }
  }
  return values;
}

/** Validate typed JSON condition values against the declared OpenFGA type. */
function conditionValue(value: Json, parameter: Parameter): boolean {
  const element = parameter.generic_types?.[0];
  switch (parameter.type_name) {
    case "TYPE_NAME_ANY": return true;
    case "TYPE_NAME_BOOL": return typeof value === "boolean";
    case "TYPE_NAME_STRING": return typeof value === "string";
    case "TYPE_NAME_INT": return typeof value === "number" ? Number.isSafeInteger(value)
      : typeof value === "string" && /^-?\d+$/.test(value);
    case "TYPE_NAME_UINT": return typeof value === "number" ? Number.isSafeInteger(value) && value >= 0
      : typeof value === "string" && /^\d+$/.test(value);
    case "TYPE_NAME_DOUBLE": return typeof value === "number";
    case "TYPE_NAME_TIMESTAMP": return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      && Number.isFinite(Date.parse(value));
    case "TYPE_NAME_DURATION": return typeof value === "string" && /^-?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value);
    case "TYPE_NAME_IPADDRESS": return typeof value === "string" && (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
      ? value.split(".").every((part) => Number(part) <= 255)
      : /^[a-fA-F0-9:.]+:.+$/.test(value));
    case "TYPE_NAME_LIST": return Array.isArray(value) && Boolean(element && value.every((entry) => conditionValue(entry, element)));
    case "TYPE_NAME_MAP": return value !== null && typeof value === "object" && !Array.isArray(value)
      && Boolean(element && Object.values(value).every((entry) => conditionValue(entry, element)));
    default: return false;
  }
}

/** Return an unsupported or mismatched key without changing the supplied context. */
export function invalidContext(context: ConditionContext, declared: Map<string, Parameter[]>) {
  return Object.entries(context).find(([name, value]) =>
    !declared.get(name)?.some((parameter) => conditionValue(value, parameter)))?.[0];
}

const tupleObjectPattern = /^([^:# \p{Cc}\p{Cs}]+):([^:# \p{Cc}\p{Cs}]+)$/u;
const tupleRelationPattern = /^[^:#@ \p{Cc}\p{Cs}]{1,50}$/u;
const untypedUserPattern = /^[^:# \p{Cc}\p{Cs}]+$/u;

/** Split an OpenFGA object with exactly one type separator. */
function tupleObject(value: string) {
  const match = tupleObjectPattern.exec(value);
  return match ? { type: match[1], id: match[2] } : null;
}

/** Decode typed subjects and usersets using the stock tuple delimiter and wildcard rules. */
function tupleSubject(value: string) {
  const [object, relation, extra] = value.split("#");
  const identity = tupleObject(object);
  if (!identity || extra !== undefined) return null;
  if (relation !== undefined && (!untypedUserPattern.test(relation) || identity.id.includes("*") || relation.includes("*"))) {
    return null;
  }
  return { ...identity, object, relation };
}

/** Explain malformed keys using the same rules that guard Read and Write.
 * @param tuple The authored or previously stored tuple.
 * @param removing Whether the captured key identifies a removal. Stock deletions permit legacy untyped users.
 */
export function tupleKeyIssues(tuple: Tuple, removing: boolean): TupleIssueDetail[] {
  const issues: TupleIssueDetail[] = [];
  const object = tupleObject(tuple.object);
  if (!object) issues.push({ reason: "objectFormat" });
  else if (!removing && object.id === "*") issues.push({ reason: "objectWildcard" });
  else if ([...tuple.object].length > 256) issues.push({ reason: "objectLength" });
  if (!tupleRelationPattern.test(tuple.relation)) issues.push({ reason: "relationFormat" });

  const subject = tupleSubject(tuple.user);
  if (new TextEncoder().encode(tuple.user).length > 512) issues.push({ reason: "userLength" });
  else if (!subject && !(removing && untypedUserPattern.test(tuple.user))) issues.push({ reason: "userFormat" });
  else if (!removing && subject?.object === tuple.object && subject.relation === tuple.relation) {
    issues.push({ reason: "userImplicit" });
  }
  return issues;
}

/** Find definite problems in one changed tuple using the exact installed model's declared fields.
 * Value conversion, condition expressions and provider-specific constraints remain with the engine.
 */
export function tupleModelIssues(tuple: Tuple, model: ModelContent): TupleIssueDetail[] {
  const issues: TupleIssueDetail[] = [];
  const object = tupleObject(tuple.object);
  const subject = tupleSubject(tuple.user);
  const definition = model.type_definitions.find((entry) => entry.type === object?.type);
  const subjectDefinition = model.type_definitions.find((entry) => entry.type === subject?.type);
  const types = model.type_definitions.map(({ type }) => type).sort();
  const references = definition?.metadata?.relations?.[tuple.relation]?.directly_related_user_types ?? [];
  const writable = Object.keys(definition?.relations ?? {}).filter((relation) =>
    definition?.metadata?.relations?.[relation]?.directly_related_user_types?.length).sort();

  if (object?.id === "*") issues.push({ reason: "objectWildcard" });
  else if (object && !definition) issues.push({ reason: "objectType", allowed: types });
  if (definition && tupleRelationPattern.test(tuple.relation)) {
    if (!Object.hasOwn(definition.relations ?? {}, tuple.relation)) issues.push({ reason: "relationMissing", allowed: writable });
    else if (!references.length) issues.push({ reason: "relationComputed", allowed: writable });
  }

  if (!subject) issues.push({ reason: "userFormat" });
  else if (!subjectDefinition) issues.push({ reason: "userType", allowed: types });
  else if (subject.relation && !Object.hasOwn(subjectDefinition.relations ?? {}, subject.relation)) {
    issues.push({ reason: "usersetMissing", allowed: Object.keys(subjectDefinition.relations ?? {}).sort() });
  } else if (references.length) {
    const facets = references.filter((reference) => reference.type === subject.type
      && (reference.relation || undefined) === subject.relation && Boolean(reference.wildcard) === (subject.id === "*"));
    if (!facets.length) {
      const allowed = references.map(({ type, relation, wildcard }) => relation ? `${type}#${relation}` : wildcard ? `${type}:*` : type);
      issues.push({ reason: "userRestriction", allowed: [...new Set(allowed)].sort() });
    } else if (!facets.some(({ condition }) => (condition || undefined) === tuple.condition?.name)) {
      issues.push({ reason: "conditionName", allowed: [...new Set(facets.flatMap(({ condition }) => condition ? [condition] : []))].sort() });
    } else if (tuple.condition && Object.hasOwn(model.conditions ?? {}, tuple.condition.name)) {
      const parameters = model.conditions?.[tuple.condition.name].parameters ?? {};
      if (Object.keys(tuple.condition.context ?? {}).some((parameter) => !Object.hasOwn(parameters, parameter))) {
        issues.push({ reason: "conditionContext", allowed: Object.keys(parameters).sort() });
      }
    }
  }
  return issues;
}

/** Match an already observed tuple to the model's direct subject facet and condition restriction.
 * Condition conversion at publication is delegated to the stock engine's tuple validator.
 */
export function tupleFitsModel(tuple: Tuple, model: ModelContent) {
  const object = tupleObject(tuple.object);
  const subject = tupleSubject(tuple.user);
  if (!object || !subject || tupleKeyIssues(tuple, false).length) return false;
  const definition = model.type_definitions.find((entry) => entry.type === object.type);
  const subjectDefinition = model.type_definitions.find((entry) => entry.type === subject.type);
  if (!definition?.relations?.[tuple.relation] || !subjectDefinition
    || (subject.relation && !subjectDefinition.relations?.[subject.relation])) return false;
  const references = definition.metadata?.relations?.[tuple.relation]?.directly_related_user_types ?? [];
  return references.some((reference) => reference.type === subject.type
    && (reference.relation || undefined) === subject.relation && Boolean(reference.wildcard) === (subject.id === "*")
    && (reference.condition || undefined) === tuple.condition?.name);
}
