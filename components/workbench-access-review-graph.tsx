"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";

import type { ReviewResource, ReviewScope } from "@/lib/workbench-access-review-contract";
import { reviewPair } from "@/lib/workbench-access-review-contract";

export type ReviewTone = "allowed" | "denied" | "matches" | "muted";
export type AccessReviewGraphHandle = { recenter: () => void };
type ReviewNode = Node<{ content: ReactNode; tone?: ReviewTone; selected: boolean }, "review">;

function ReviewCard({ data }: NodeProps<ReviewNode>) {
  return <div className="review-graph-card" data-muted={data.tone === "muted" || data.tone === "denied" || undefined}
    data-allowed={data.tone === "allowed" || undefined} data-matches={data.tone === "matches" || undefined}
    data-denied={data.tone === "denied" || undefined}
    data-selected={data.selected || undefined}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    {data.content}
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>;
}

const nodeTypes = { review: ReviewCard };
const cardWidth = 248;
const cardHeight = ({ relations }: ReviewResource) => 82 + relations.length * 49;
// Use the known dimensions even for cards whose content just changed.
const fitOptions = { padding: 0.13, includeHiddenNodes: true };

/** Give controlled cards stable box and connector geometry while live decisions change their contents. */
function cardHandles(height: number): ReviewNode["handles"] {
  const x = (cardWidth - 1) / 2;
  return [
    { id: null, type: "target", position: Position.Top, x, y: 0 },
    { id: null, type: "source", position: Position.Bottom, x, y: height - 1 },
  ];
}

function positions(root: string, resources: ReviewResource[]) {
  const children = Map.groupBy(resources, ({ parent }) => parent);
  const result = new Map<string, { x: number; y: number }>();
  const levels = Map.groupBy(resources, ({ depth }) => depth);
  let y = 0;
  for (const level of levels.values()) {
    for (const resource of level) result.set(resource.object, { x: 0, y });
    y += Math.max(...level.map(cardHeight)) + 58;
  }
  let lane = 0;
  const walk = [root];
  const traversed: string[] = [];
  while (walk.length) {
    const object = walk.pop()!;
    traversed.push(object);
    const descendants = children.get(object);
    if (descendants?.length) {
      walk.push(...descendants.toReversed().map((item) => item.object));
    } else {
      const point = result.get(object);
      if (point) point.x = lane++ * (cardWidth + 40);
    }
  }
  for (const object of traversed.reverse()) {
    const descendants = children.get(object);
    if (!descendants?.length) continue;
    const coordinates = descendants.map(({ object }) => result.get(object)!.x);
    result.get(object)!.x = (Math.min(...coordinates) + Math.max(...coordinates)) / 2;
  }
  return result;
}

/** Lay out the full hierarchy independently of access decisions. */
export function AccessReviewGraph({ scope, visible, selection, cardTones, branchTones, highlighted, render, select, viewportChanged, ref }: {
  scope: ReviewScope;
  visible: ReviewResource[];
  selection: { object: string; focusChart: boolean } | undefined;
  cardTones: Map<string, ReviewTone | undefined>;
  branchTones: Map<string, ReviewTone | undefined>;
  highlighted: Set<string>;
  render: (resource: ReviewResource) => ReactNode;
  select: (object: string) => void;
  viewportChanged: () => void;
  ref: Ref<AccessReviewGraphHandle>;
}) {
  const layout = useMemo(() => positions(scope.root, visible), [scope.root, visible]);
  const flow = useRef<ReactFlowInstance<ReviewNode, Edge>>(null);
  useImperativeHandle(ref, () => ({ recenter: () => { void flow.current?.fitView(fitOptions); } }), []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void flow.current?.fitView(fitOptions); });
    return () => cancelAnimationFrame(frame);
  }, [layout]);
  useEffect(() => {
    if (!selection?.focusChart) return;
    const frame = requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      void flow.current?.fitView({ ...fitOptions, nodes: [{ id: selection.object }], maxZoom: 1,
        duration: reduceMotion ? 0 : 320, interpolate: "linear" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection]);
  const nodes: ReviewNode[] = visible.map((resource) => {
    const size = { width: cardWidth, height: cardHeight(resource) };
    return {
      id: resource.object, type: "review", position: layout.get(resource.object)!,
      data: { content: render(resource), tone: cardTones.get(resource.object),
        selected: selection?.object === resource.object },
      // Preserve the fixed dimensions when a live result replaces the node data.
      ...size, measured: size, handles: cardHandles(size.height), draggable: false, selectable: false,
    };
  });
  const parents = useMemo(() => new Map(scope.resources.map(({ object, parent }) => [object, parent])), [scope]);
  const links = useMemo(() => Map.groupBy(scope.edges.filter(({ parent, child }) =>
    parent !== child && layout.has(parent) && layout.has(child)), ({ parent, child }) => reviewPair(parent, child)), [scope.edges, layout]);
  const edges: Edge[] = [...links].map(([id, group]) => {
    const { parent, child } = group[0];
    const onPath = group.some((edge) => highlighted.has(JSON.stringify([edge.subject, edge.relation, edge.object])));
    const primary = parents.get(child) === parent;
    const tone = branchTones.get(child);
    const color = tone === "allowed" ? "var(--green)" : tone === "denied" ? "var(--red)"
      : onPath || tone === "matches" ? "var(--blue)" : "var(--subtle)";
    const relations = [...new Set(group.map(({ relation }) => relation))].sort().join(" · ");
    const verdict = tone === "allowed" ? "Allowed access in branch" : tone === "denied" ? "Denied access in branch" : undefined;
    return { id, source: parent, target: child, type: "smoothstep",
      ariaLabel: [relations, parent + " to " + child, verdict].filter(Boolean).join(" · "),
      label: relations + (tone === "allowed" ? " · ✓" : tone === "denied" ? " · ×" : ""),
      labelStyle: { fill: "var(--ink)", fontSize: 12 },
      labelBgStyle: { fill: "var(--paper)" },
      markerEnd: { type: MarkerType.ArrowClosed, color }, style: {
        stroke: color, strokeWidth: onPath ? 3 : 1.4, ...(primary ? {} : { strokeDasharray: "4 4" }),
      }, zIndex: onPath ? 1 : 0,
    };
  });

  return <div className="review-graph">
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onInit={(instance) => { flow.current = instance; }} fitView fitViewOptions={fitOptions}
      onNodeClick={(event, node) => {
        if (event.target instanceof Element && !event.target.closest("button")) select(node.id);
      }}
      onMove={viewportChanged}
      nodesConnectable={false} nodesDraggable={false} nodesFocusable={false} elementsSelectable={false} minZoom={0.02} maxZoom={1.9}
      proOptions={{ hideAttribution: false }}>
      <Background color="var(--line-strong)" gap={20} />
      <Controls showInteractive={false} fitViewOptions={fitOptions} />
    </ReactFlow>
  </div>;
}
