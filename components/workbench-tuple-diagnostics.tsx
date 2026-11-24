import { useMemo } from "react";

import type { Draft, TupleIssue } from "@/lib/workbench-contract";
import { inspectTupleDraft, tupleDraftIssue, tupleSourceLookup, type TupleSourceField } from "@/lib/workbench-drafts";

/** Keep source coordinates bound to the actual saved draft and model used by Publish. */
export type TuplePublishFeedback = {
  draft: Draft;
  revision: string;
  phase: "preflight" | "reread" | "write";
  issues: TupleIssue[];
};

/** Display stable, actionable reasons without borrowing upstream exception text. */
const guidance: Record<TupleIssue["reason"], { field?: TupleSourceField; cause: string; fix: string; choices?: string }> = {
  yaml: { cause: "Tuple YAML could not be read.", fix: "Correct the YAML at the indicated location before publishing." },
  schema: { cause: "The selected revision has an unsupported model schema.", fix: "Select or publish a revision using schema 1.1 or 1.2." },
  model: { cause: "OpenFGA rejected the model lookup during validation.", fix: "Check that the intended model revision is installed and selected." },
  objectFormat: { field: "object", cause: "The object key is malformed.", fix: "Enter a type and ID separated by one colon, such as document:example." },
  objectLength: { field: "object", cause: "The object key is longer than 256 characters.", fix: "Use a shorter object ID." },
  objectWildcard: { field: "object", cause: "An object cannot be a wildcard.", fix: "Choose one concrete object ID." },
  objectType: { field: "object", cause: "The object type is not defined in this revision.", fix: "Choose a defined object type or publish and select the intended model revision.", choices: "Defined types" },
  relationFormat: { field: "relation", cause: "The relation key is malformed.", fix: "Use a relation of at most 50 characters without spaces, colons, # or @." },
  relationMissing: { field: "relation", cause: "This relation is not defined for the object type in this revision.", fix: "Choose a direct relation from the model or publish and select the intended revision.", choices: "Direct relations on this type" },
  relationComputed: { field: "relation", cause: "This relation is computed and does not accept direct tuples.", fix: "Choose a direct relation from the model that contributes to it.", choices: "Direct relations on this type" },
  userFormat: { field: "user", cause: "The subject key is malformed.", fix: "Enter type:id, type:id#relation or an allowed typed wildcard such as user:*." },
  userLength: { field: "user", cause: "The subject key exceeds 512 UTF-8 bytes.", fix: "Use a shorter subject ID." },
  userImplicit: { field: "user", cause: "This userset would assign the relation to itself.", fix: "Choose a different subject or a userset on another object or relation." },
  userType: { field: "user", cause: "The subject type is not defined in this revision.", fix: "Choose a defined subject type or publish and select the intended revision.", choices: "Defined types" },
  usersetMissing: { field: "user", cause: "The userset relation after # is not defined on this subject type.", fix: "Choose a defined userset relation allowed by the object relation, or select the intended model revision.", choices: "Defined relations on the subject type" },
  userRestriction: { field: "user", cause: "This relation does not allow the given subject type, userset, or wildcard.", fix: "Choose an allowed subject or publish and select a model revision that permits this grant.", choices: "Allowed subjects" },
  conditionName: { field: "condition.name", cause: "This subject and relation require a different condition or an unconditioned tuple.", fix: "Use a condition allowed by the relation, or remove it if the model permits an unconditioned tuple.", choices: "Allowed conditions for this subject" },
  conditionContext: { field: "condition.context", cause: "The context contains parameters this condition does not declare.", fix: "Remove the extra parameter or choose the correct condition from the model.", choices: "Declared parameters" },
  conditionSize: { field: "condition.context", cause: "The serialized condition context exceeds OpenFGA's 32 KiB limit for tuple writes.", fix: "Shorten context values or remove optional parameters, then publish again." },
  engine: { cause: "OpenFGA rejected this input without a more specific workbench diagnosis.", fix: "Check the tuple key, allowed subjects, and condition context against the selected revision. Select or publish the intended model if necessary." },
};

/** Link an existing YAML parser location to text in exactly the rejected source. */
function yamlErrorRange(yaml: string, line: number, column: number) {
  const lines = yaml.split("\n");
  const offset = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  const end = Math.min(yaml.length, offset + (lines[line - 1]?.length ?? 0));
  return { start: Math.min(end, offset + column - 1), end, line, column };
}

/** Show captured reasons with exact rows and source links while the original buffer and target still match. */
export function TuplePublishDiagnostics({ feedback, jump }: {
  feedback: TuplePublishFeedback;
  jump?: (start: number, end: number) => void;
}) {
  const { draft, issues, phase, revision } = feedback;
  const showSource = Boolean(jump);
  const { tuples, issue: yamlIssue } = useMemo(() => showSource ? inspectTupleDraft(draft.yaml) : { tuples: null, issue: null },
    [draft.yaml, showSource]);
  const locate = useMemo(() => tuples ? tupleSourceLookup(draft.yaml) : undefined, [draft.yaml, tuples]);
  const headline = phase === "preflight" ? "Publish blocked · No tuple writes were made in this attempt."
    : phase === "reread" ? "Publish stopped while re-reading a tuple."
      : "Publish stopped while sending a tuple change.";
  return <section className="wb-tuple-diagnostics" aria-label="Tuple publish diagnostics">
    <p role="status"><strong>{headline}</strong> Model revision <code>{revision}</code>.</p>
    {jump ? <ul>{issues.map((item, index) => {
      const { field, cause, fix, choices } = guidance[item.reason];
      const row = item.row;
      const value = row?.source === "draft" ? tuples?.[row.index]
        : row?.source === "baseline" ? draft.baseline[row.index]
          : row?.source === "journal" ? row.index === 0 ? draft.replacement?.original : draft.replacement?.desired : undefined;
      const range = row?.source === "draft" ? locate?.(row.index, field)
        : item.reason === "yaml" && yamlIssue ? yamlErrorRange(draft.yaml, yamlIssue.line, yamlIssue.column) : null;
      return <li key={index}>
        {value && <div className="wb-tuple-diagnostic-key"><code>{value.user}</code> · <code>{value.relation}</code> · <code>{value.object}</code></div>}
        <p>{field && <strong>{field} · </strong>}{item.operation && <>{item.operation === "add" ? "Write" : "Remove"} · </>}
          {item.reason === "yaml" && yamlIssue ? tupleDraftIssue(yamlIssue) : cause} {fix}</p>
        {choices && item.allowed?.length ? <p>{choices} · {item.allowed.map((value, choice) =>
          <code key={value}>{choice > 0 ? ", " : ""}{value}</code>)}</p> : null}
        {range ? <button type="button" onClick={() => jump(range.start, range.end)}>
          Source line {range.line}, column {range.column}{field ? " · " + field : ""}
        </button> : row?.source === "baseline" ? <p>Stored baseline tuple · No line in the current YAML for this removal.</p>
          : row?.source === "journal" ? <p>Captured recovery tuple · Review the original revision before resuming.</p> : null}
      </li>;
    })}</ul> : <>
      <p>The draft or target changed. These reasons apply to the captured attempt.</p>
      <ul>{[...new Set(issues.map(({ reason }) => reason))].map((reason) =>
        <li key={reason}><p>{guidance[reason].cause} {guidance[reason].fix}</p></li>)}</ul>
    </>}
  </section>;
}
