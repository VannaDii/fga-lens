import { engineId, type Query, type Target } from "./workbench-contract";

/** Build the OpenFGA REST payload used by the browser disclosure and by every engine operation.
 * @param input Captured live query or saved assertion.
 * @param revision Immutable installed revision.
 * @returns Provider request body, or null for a missing revision or unsupported context size.
 */
export function queryRequest(input: Query, revision: string) {
  if (!engineId.is(revision) || (input.tuples?.length ?? 0) > 100) return null;
  const common = {
    authorization_model_id: revision, ...(input.context && Object.keys(input.context).length ? { context: input.context } : {}),
    ...(input.consistent ? { consistency: "HIGHER_CONSISTENCY" } : {}),
  };
  const contextual = input.tuples?.length ? { contextual_tuples: { tuple_keys: input.tuples } } : {};
  switch (input.operation) {
    case "check":
      return { ...common, ...contextual, tuple_key: { user: input.user, relation: input.relation, object: input.object } };
    case "list-objects":
      return { ...common, ...contextual, user: input.user, relation: input.relation, type: input.type };
    case "list-users": {
      const separator = input.object.indexOf(":");
      if (separator < 1 || separator === input.object.length - 1) return null;
      return {
        ...common, ...(input.tuples?.length ? { contextual_tuples: input.tuples } : {}),
        object: { type: input.object.slice(0, separator), id: input.object.slice(separator + 1) },
        relation: input.relation, user_filters: [input.filter],
      };
    }
  }
}


/** Resolve the OpenFGA resource shown in the request disclosure and used by the adapter. */
export function queryPath(target: Target, input: Query) {
  return "/stores/" + target.store + "/" + input.operation;
}
