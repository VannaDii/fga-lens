import type { TypeOf } from "io-ts";

import { parseAuthorizationModel } from "./fga-model";
import { evidenceResult, type CheckInput, type Query, type Target } from "./workbench-contract";
import { tupleIndex } from "./workbench-drafts";
import { diagnose, OperationFailure } from "./workbench-errors";
import { modelDsl, tupleFitsModel } from "./workbench-models";
import { expand, readModel, readTuples, runQuery } from "./workbench-server";

type Evidence = TypeOf<typeof evidenceResult>;
type ObservedTuple = Evidence["tuples"][number];
type Proof = { decision: boolean | null; chain: ObservedTuple[]; reason?: string; conditioned?: ObservedTuple };
const uncertain: Proof = { decision: null, chain: [] };
const absent: Proof = { decision: false, chain: [] };

/** Collect evidence independently of the original query, with at most 32 calls or five seconds. */
export async function explain(
  target: Target, input: Query, observed: boolean | string[], signal: AbortSignal, advance: () => void, selected?: string,
) {
  const started = performance.now();
  const timeout = AbortSignal.timeout(5_000);
  const bounded = AbortSignal.any([timeout, signal]);
  const result: Evidence = { reason: "Reason undetermined", rules: [], tuples: [], checks: [], expansion: null, elapsed: 0 };
  const confirmed = new Map<string, ObservedTuple>();
  let remaining = 32;

  /** Every request, including continued tuple pages, consumes the same budget. */
  function consume() {
    if (bounded.aborted || remaining <= 0) throw new OperationFailure("cancellation");
    remaining -= 1;
    advance();
  }

  /** Observe a Check with the captured context and overlay and label the time of the observation. */
  async function followup(check: CheckInput) {
    consume();
    const actual = await runQuery(target, check, bounded);
    if (typeof actual.outcome !== "boolean") throw new OperationFailure("server error");
    result.checks.push({ user: check.user, relation: check.relation, object: check.object,
      allowed: actual.outcome, observedAt: actual.observedAt });
    return actual.outcome;
  }

  try {
    const selectedCheck = input.operation !== "check";
    let checkInput: CheckInput;
    let verdict: boolean | string[] = observed;
    if (input.operation === "check") {
      checkInput = input;
    } else {
      if (!selected) return { ...result, elapsed: performance.now() - started };
      checkInput = { ...input, operation: "check", user: input.operation === "list-objects" ? input.user : selected,
        object: input.operation === "list-users" ? input.object : selected };
      verdict = await followup(checkInput);
    }
    const { user: subject } = checkInput;
    consume();
    const model = await readModel(target, bounded);
    const graph = parseAuthorizationModel(modelDsl(model)).graph;
    const overlay = tupleIndex(checkInput.tuples ?? []);
    type Rewrite = NonNullable<(typeof model.type_definitions)[number]["relations"]>[string];
    const rules = new Set<string>();

    /** Read each visited relation, applying contextual replacement at the tuple identity. */
    async function tuplesFor(object: string, relation: string) {
      const records = await readTuples(target.store, bounded, { object, relation }, consume);
      const stored = tupleIndex(records);
      for (const [key, tuple] of overlay) {
        if (tuple.object === object && tuple.relation === relation) stored.set(key, tuple);
      }
      const observedAt = Date.now();
      return [...stored.entries()].filter(([, tuple]) => tupleFitsModel(tuple, model)).map(([key, tuple]) => ({
        tuple, source: overlay.has(key) ? "contextual" as const : "stored" as const, observedAt,
      }));
    }

    /** Preserve confirmed facts even if a later provider request fails or contradicts them. */
    function keep(entry: ObservedTuple) {
      confirmed.set(JSON.stringify(entry.tuple), entry);
      return entry;
    }

    /** Visit a named relation in the installed model and collect its applicable DSL. */
    async function relationProof(object: string, relation: string, visited: Set<string>): Promise<Proof> {
      const token = JSON.stringify([object, relation]);
      if (visited.has(token)) return uncertain;
      const definition = model.type_definitions.find((entry) => entry.type === object.split(":")[0]);
      const rewrite = definition?.relations?.[relation];
      if (!rewrite) return uncertain;
      const source = graph?.types.find((entry) => entry.name === definition.type)?.relations
        .find((entry) => entry.name === relation);
      if (source) rules.add("type " + source.type + " · define " + source.name + ": " + source.expression);
      result.rules = [...rules];
      const proof = await walk(rewrite, object, relation, new Set([...visited, token]));
      if (!proof.conditioned) return proof;
      const condition = proof.conditioned.tuple.condition?.name;
      const description = condition ? model.conditions?.[condition] : undefined;
      if (!condition || !description) return uncertain;
      rules.add("condition " + condition + " { " + description.expression + " }");
      result.rules = [...rules];
      const decision = await followup({ ...checkInput, object, relation });
      return { decision, chain: proof.chain, reason: decision
        ? "Direct grant satisfies condition " + condition : "Matching grant fails condition " + condition };
    }

    /** Evaluate the direct candidates using engine Checks for an isolated conditioned grant. */
    async function direct(object: string, relation: string, visited: Set<string>): Promise<Proof> {
      const entries = await tuplesFor(object, relation);
      const candidates: ObservedTuple[] = [];
      let incomplete = false;
      for (const entry of entries) {
        const { user, condition } = entry.tuple;
        if (user === subject || user === subject.split(":")[0] + ":*") {
          keep(entry);
          if (!condition) return { decision: true, chain: [entry], reason: "Direct grant" };
          candidates.push(entry);
        } else if (user.includes("#")) {
          if (condition) { incomplete = true; continue; }
          const [memberObject, memberRelation] = user.split("#");
          const member = await relationProof(memberObject, memberRelation, visited);
          if (member.decision === true) {
            return { decision: true, chain: [keep(entry), ...member.chain], reason: "Inherited grant" };
          }
          incomplete ||= member.decision === null;
        }
      }
      if (incomplete || candidates.length > 1) return uncertain;
      const candidate = candidates[0];
      return candidate ? { decision: null, chain: [candidate], conditioned: candidate } : absent;
    }

    /** Resolve a single supported inheritance chain, with uncertainty for cycles and unverified links. */
    async function inherit(rule: NonNullable<Rewrite["tupleToUserset"]>, object: string, visited: Set<string>): Promise<Proof> {
      const links = await tuplesFor(object, rule.tupleset.relation);
      let incomplete = false;
      for (const link of links) {
        keep(link);
        if (link.tuple.condition) { incomplete = true; continue; }
        const child = await relationProof(link.tuple.user, rule.computedUserset.relation, visited);
        if (child.decision === true) return { decision: true, chain: [link, ...child.chain], reason: "Inherited grant" };
        incomplete ||= child.decision === null;
      }
      return incomplete ? uncertain : absent;
    }

    /** Combine direct, computed, inherited, intersection and difference evidence conservatively. */
    async function walk(rule: Rewrite, object: string, relation: string, visited: Set<string>): Promise<Proof> {
      if (rule.computedUserset) return relationProof(object, rule.computedUserset.relation, visited);
      if (rule.this) return direct(object, relation, visited);
      if (rule.tupleToUserset) return inherit(rule.tupleToUserset, object, visited);
      if (rule.difference) {
        const grant = await walk(rule.difference.base, object, relation, visited);
        const block = await walk(rule.difference.subtract, object, relation, visited);
        const chain = [...grant.chain, ...block.chain];
        if (grant.decision === false) return { decision: false, chain,
          reason: grant.reason ?? (block.decision ? "No qualifying grant. A matching block is also present." : "No qualifying grant") };
        if (grant.decision === true && block.decision === true) {
          return { decision: false, chain, reason: "Grant excluded by a matching block" };
        }
        if (block.decision === false) return grant;
        return { ...uncertain, chain };
      }
      const union = Boolean(rule.union);
      const group = rule.union ?? rule.intersection;
      if (!group) return uncertain;
      const proofs: Proof[] = [];
      for (const child of group.child) {
        const proof = await walk(child, object, relation, visited);
        if (proof.decision === union) return proof;
        proofs.push(proof);
      }
      const unresolved = proofs.filter((proof) => proof.decision === null);
      if (union && unresolved.length === 1 && unresolved[0].conditioned) return unresolved[0];
      return { decision: unresolved.length ? null : !union, chain: proofs.flatMap((proof) => proof.chain) };
    }

    const proof = await relationProof(checkInput.object, checkInput.relation, new Set());
    result.tuples = proof.chain;
    let reason = proof.decision === verdict
      ? proof.reason ?? (verdict ? "Grant supported by the displayed tuple chain" : "No qualifying grant")
      : "Reason undetermined";
    const root = model.type_definitions.find((entry) => entry.type === checkInput.object.split(":")[0])?.relations?.[checkInput.relation];
    const grant = root?.difference?.base?.computedUserset?.relation;
    const exclusion = root?.difference?.subtract?.computedUserset?.relation;
    if (grant && exclusion) {
      const eligible = await followup({ ...checkInput, relation: grant });
      const blocked = await followup({ ...checkInput, relation: exclusion });
      if ((eligible && !blocked) !== verdict || (reason.startsWith("Grant excluded") && (!eligible || !blocked))
        || (reason.startsWith("No qualifying grant") && eligible)) reason = "Reason undetermined";
    }
    consume();
    result.expansion = await expand(target, checkInput.object, checkInput.relation, bounded, checkInput.tuples ?? []);
    if (selectedCheck) result.checkReason = reason;
    else result.reason = reason;
  } catch (error) {
    result.reason = "Reason undetermined";
    result.tuples = [...confirmed.values()];
    if (!timeout.aborted && remaining > 0) {
      result.failure = diagnose(error instanceof OperationFailure ? error : null, started);
    }
  }
  return { ...result, elapsed: performance.now() - started };
}
