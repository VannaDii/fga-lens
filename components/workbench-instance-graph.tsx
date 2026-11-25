"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { tupleKey, type Tuple } from "@/lib/workbench-contract";
import { Disclosure } from "./workbench-ui";

/** A concrete instance's direct links, with the original tuple data intact. */
type InstanceLinks = { incoming: Tuple[]; outgoing: Tuple[] };

/** Use the object portion of a userset to find its card. Keep the full subject for inspection. */
function subjectObject(tuple: Tuple) {
  return tuple.user.split("#", 1)[0];
}

/** Recognize a typed identifier that can stand for one concrete instance. */
function isConcrete(id: string) {
  const separator = id.indexOf(":");
  return separator > 0 && separator === id.lastIndexOf(":") && separator < id.length - 1
    && !id.includes("#") && !id.endsWith(":*");
}

/** Only an explicit parent tuple between two concrete objects defines a lane. */
function isParent(tuple: Tuple) {
  return tuple.relation === "parent" && tuple.user !== tuple.object && isConcrete(tuple.user) && isConcrete(tuple.object);
}

/** Index direct links in both directions and retain inventory entries with no tuples. */
export function indexInstances(records: Tuple[], inventory: string[]) {
  const instances = new Map<string, InstanceLinks>();
  /** Return the same neighborhood each time this object is encountered. */
  const entry = (id: string) => {
    const found = instances.get(id);
    if (found) return found;
    const added: InstanceLinks = { incoming: [], outgoing: [] };
    instances.set(id, added);
    return added;
  };
  for (const id of inventory) entry(id);
  for (const tuple of records) {
    entry(subjectObject(tuple)).outgoing.push(tuple);
    entry(tuple.object).incoming.push(tuple);
  }
  return instances;
}

/** Keep card and role order stable when engine page order changes. */
function ordered(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

/** Group only actual tuple rows under their common relation or owning object. */
function groupTuples(tuples: Tuple[], key: (tuple: Tuple) => string) {
  const groups = new Map<string, Tuple[]>();
  for (const tuple of tuples) {
    const name = key(tuple);
    const group = groups.get(name);
    if (group) group.push(tuple);
    else groups.set(name, [tuple]);
  }
  return groups;
}

/** Add readable word breaks without changing the identifier used for selection or inspection. */
function displayWords(value: string) {
  const words = value.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

/** Display a subject name while keeping a userset distinct from its containing object. */
function displaySubject(user: string) {
  const [object, userset] = user.split("#", 2);
  const name = displayWords(object.slice(object.indexOf(":") + 1));
  return userset === undefined ? name : `${name} #${userset}`;
}

/** Bind graph and disclosure actions to a precise tuple and its focus return control. */
type Inspect = (tuple: Tuple, trigger: HTMLButtonElement) => void;

/** Shared accessible action label distinguishes assignees, usersets and owning objects. */
function inspectLabel(tuple: Tuple) {
  return `Inspect ${tuple.relation} for ${tuple.user} on ${tuple.object}`;
}

/** Show the typed identity and each directly inspectable role holder under the owning object. */
function InstanceCard({ id, roles, assignments, focused = false, selected, focus, inspect }: {
  id: string; roles: Tuple[]; assignments: Tuple[]; focused?: boolean; selected: string;
  focus: (id: string) => void; inspect: Inspect;
}) {
  const delimiter = id.indexOf(":");
  const type = delimiter < 0 ? "Subject" : id.slice(0, delimiter);
  const name = id.slice(delimiter + 1);
  const title = <>
    <span className="wb-instance-kind">{displayWords(type)}</span>
    <strong className="wb-instance-name">{displayWords(name)}</strong>
    {assignments.length > 0 && <span className="wb-instance-assignment-names">
      {ordered(assignments.map(({ relation }) => relation)).map(displayWords).join(" · ")}
    </span>}
  </>;
  const displayedRoles = groupTuples(assignments.length ? assignments : roles, (tuple) => tuple.relation);

  return <div className="wb-instance-card" data-instance-card data-focused={focused || undefined}>
    {focused ? <div className="wb-instance-card-head" aria-current="true" title={id}>{title}</div>
      : <button type="button" className="wb-instance-card-head" title={id} aria-label={`Focus ${id}`}
        onClick={() => focus(id)}>{title}</button>}
    {[...displayedRoles].sort(([left], [right]) => left.localeCompare(right)).map(([relation, assignees]) => {
      const labels = new Map<string, number>();
      for (const { user } of assignees) {
        const label = displaySubject(user);
        labels.set(label, (labels.get(label) ?? 0) + 1);
      }
      return <div className="wb-instance-role" role="group" aria-label={relation} key={relation}>
        {(!assignments.length || displayedRoles.size > 1)
          && <span className="wb-instance-role-name" title={relation}>{displayWords(relation)}</span>}
        <div className="wb-instance-assignees">
          {assignees.toSorted((left, right) => left.user.localeCompare(right.user)).map((tuple) => {
            const label = displaySubject(tuple.user);
            return <button type="button" key={tupleKey(tuple)} aria-label={inspectLabel(tuple)} title={tuple.user}
              aria-pressed={selected === tupleKey(tuple)} onClick={(event) => inspect(tuple, event.currentTarget)}>
              {labels.get(label) === 1 ? label : tuple.user}
            </button>;
          })}
        </div>
      </div>;
    })}
  </div>;
}

/** Label the lanes independently so they retain their meaning when shown in a single column. */
function InstanceLane({ label, lane, empty, children }: {
  label: string; lane: "parent" | "focus" | "child"; empty?: string; children: ReactNode;
}) {
  const heading = useId();
  return <section className="wb-instance-lane" data-instance-lane={lane} aria-labelledby={heading}>
    <h3 id={heading}>{label}</h3>
    <div className="wb-instance-stack">{children}{empty && <p>{empty}</p>}</div>
  </section>;
}

/** Measure the displayed cards so orthogonal arrows stay attached as lanes reflow. */
function LinkedLanes({ children, assignments }: { children: ReactNode; assignments: boolean }) {
  const board = useRef<HTMLDivElement>(null);
  const arrow = useId();
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    const container = board.current;
    if (!container) return;
    const center = container.querySelector<HTMLElement>('[data-instance-lane="focus"] [data-instance-card]');
    if (!center) return;
    const parents = [...container.querySelectorAll<HTMLElement>('[data-instance-lane="parent"] [data-instance-card]')];
    const children = [...container.querySelectorAll<HTMLElement>('[data-instance-lane="child"] [data-instance-card]')];

    /** Convert the card bounds to board-local coordinates and branch in the lane gutter. */
    function measure() {
      if (!container || !center) return;
      const bounds = container.getBoundingClientRect();
      const focus = center.getBoundingClientRect();
      /** Arrows run from the concrete subject on the left to the receiving object on the right. */
      const join = (from: DOMRect, to: DOMRect) => {
        const x1 = from.right - bounds.left;
        const x2 = to.left - bounds.left - 2;
        if (x1 >= x2) return [];
        const y1 = from.top + from.height / 2 - bounds.top;
        const y2 = to.top + to.height / 2 - bounds.top;
        return [`M${x1} ${y1} H${(x1 + x2) / 2} V${y2} H${x2}`];
      };
      setPaths([...parents.flatMap((parent) => join(parent.getBoundingClientRect(), focus)),
        ...children.flatMap((child) => join(focus, child.getBoundingClientRect()))]);
    }

    const observer = new ResizeObserver(measure);
    for (const element of [container, center, ...parents, ...children]) observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  return <div className="wb-instance-board" data-assignments={assignments || undefined} ref={board}>
    {children}
    <svg className="wb-instance-wires" aria-hidden="true" focusable="false">
      <defs><marker id={arrow} viewBox="0 0 8 8" markerWidth="6" markerHeight="6" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 Z" />
      </marker></defs>
      {paths.map((path, index) => <path key={index} d={path} markerEnd={`url(#${arrow})`} />)}
    </svg>
  </div>;
}

/** Present an exact local neighborhood, or browse all filtered instances when no focus is selected. */
export function InstanceGraph({ instances, focused, matches, selected, focus, inspect }: {
  instances: ReadonlyMap<string, InstanceLinks>; focused: string; matches: (id: string) => boolean; selected: string;
  focus: (id: string) => void; inspect: Inspect;
}) {
  /** Read node-owned direct roles and keep assignment cards scoped to their focused subject. */
  const card = (id: string, assignments: Tuple[] = []) => <InstanceCard key={id} id={id}
    roles={instances.get(id)?.incoming.filter((tuple) => !isParent(tuple)) ?? []} assignments={assignments}
    focused={id === focused} selected={selected} focus={focus} inspect={inspect} />;

  const links = instances.get(focused);
  if (!links) {
    const visible = ordered(instances.keys()).filter(matches);
    return <div className="wb-instance-canvas">
      {visible.length ? <div className="wb-instance-browse">{visible.map((id) => card(id))}</div>
        : <p className="wb-instance-empty">{instances.size ? "No matching instances." : "No instances yet."}</p>}
    </div>;
  }

  const parents = ordered(links.incoming.filter(isParent).map(subjectObject));
  const children = ordered(links.outgoing.filter(isParent).map(({ object }) => object));
  const assignments = groupTuples(links.outgoing.filter((tuple) => !isParent(tuple) && tuple.object !== focused),
    (tuple) => tuple.object);
  const visibleParents = parents.filter(matches);
  const visibleChildren = children.filter(matches);
  const visibleAssignments = ordered(assignments.keys()).filter(matches);
  const assignmentCards = visibleAssignments.map((id) => card(id, assignments.get(id)));
  // A subject with assignments and no incoming links or children needs only the assignment lanes.
  const subjectView = assignments.size > 0 && links.incoming.length === 0 && children.length === 0;

  return <div className="wb-instance-canvas">
    <LinkedLanes assignments={subjectView}>
      {!subjectView && <InstanceLane lane="parent" label="Parent"
        empty={!visibleParents.length ? parents.length ? "No matching parents" : "No parent tuple" : undefined}>
        {visibleParents.map((id) => card(id))}
      </InstanceLane>}
      <InstanceLane lane="focus" label="In focus">{card(focused)}</InstanceLane>
      {subjectView
        ? <InstanceLane lane="child" label="Direct assignments" empty={!assignmentCards.length ? "No matching assignments" : undefined}>
          {assignmentCards}
        </InstanceLane>
        : <InstanceLane lane="child" label="Children"
          empty={!visibleChildren.length ? children.length ? "No matching children" : "No child tuples" : undefined}>
          {visibleChildren.map((id) => card(id))}
        </InstanceLane>}
    </LinkedLanes>
    {!subjectView && assignments.size > 0 && <InstanceLane lane="child" label="Direct assignments"
      empty={!assignmentCards.length ? "No matching assignments" : undefined}>{assignmentCards}</InstanceLane>}
  </div>;
}

/** Disclose exact tuple direction and allow every direct row to open its source inspector. */
export function DirectTuples({ records, links, inspect }: {
  records: Tuple[]; links?: InstanceLinks; inspect: Inspect;
}) {
  const direct = links ? [...links.incoming, ...links.outgoing.filter((tuple) => tuple.object !== subjectObject(tuple))] : records;
  return <Disclosure className="wb-instance-tuples" title={"Inspect direct tuples (" + direct.length + ")"}>
    {direct.length > 0 ? <table>
      <thead><tr><th scope="col">Subject</th><th scope="col">Relation</th><th scope="col">Object</th></tr></thead>
      <tbody>{direct.map((tuple) => <tr key={tupleKey(tuple)}>
        <td><code>{tuple.user}</code></td>
        <td><button type="button" aria-label={inspectLabel(tuple)}
          onClick={(event) => inspect(tuple, event.currentTarget)}>{tuple.relation}</button></td>
        <td><code>{tuple.object}</code></td>
      </tr>)}</tbody>
    </table> : <p>No direct tuples.</p>}
  </Disclosure>;
}
