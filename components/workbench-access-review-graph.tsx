"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";

import type { ReviewResource, ReviewScope } from "@/lib/workbench-access-review-contract";
import { reviewPair } from "@/lib/workbench-access-review-contract";

type ReviewNode = Node<{ content: ReactNode; muted: boolean }, "review">;

function ReviewCard({ data }: NodeProps<ReviewNode>) {
  return <div className="review-graph-card" data-muted={data.muted || undefined}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    {data.content}
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>;
}

const nodeTypes = { review: ReviewCard };
const cardSize = { width: 200, height: 145 };
// Use the known dimensions even for cards whose content just changed.
const fitOptions = { padding: 0.13, includeHiddenNodes: true };

/** Give controlled cards stable box and connector geometry while live decisions change their contents. */
function cardHandles(): ReviewNode["handles"] {
  const x = (cardSize.width - 1) / 2;
  return [
    { id: null, type: "target", position: Position.Top, x, y: 0 },
    { id: null, type: "source", position: Position.Bottom, x, y: cardSize.height - 1 },
  ];
}

function positions(root: string, visible: ReviewResource[]) {
  const children = Map.groupBy(visible, ({ parent }) => parent);
  const result = new Map<string, { x: number; y: number }>();
  const order = [...visible].reverse();
  const indexes = new Map(visible.map(({ object }, index) => [object, index]));
  let lane = 0;
  for (const resource of order) {
    if (!(children.get(resource.object)?.length)) result.set(resource.object, { x: 0, y: resource.depth * (cardSize.height + 43) });
  }
  const walk = [root];
  const traversed: string[] = [];
  while (walk.length) {
    const object = walk.pop()!;
    traversed.push(object);
    const descendants = children.get(object);
    if (descendants?.length) {
      walk.push(...[...descendants].sort((a, b) => indexes.get(b.object)! - indexes.get(a.object)!).map((item) => item.object));
    } else {
      const point = result.get(object);
      if (point) point.x = lane++ * (cardSize.width + 32);
    }
  }
  for (const object of traversed.reverse()) {
    const descendants = children.get(object);
    if (!descendants?.length) continue;
    const coordinates = descendants.map(({ object }) => result.get(object)!.x);
    const depth = visible[indexes.get(object)!].depth;
    result.set(object, { x: (Math.min(...coordinates) + Math.max(...coordinates)) / 2, y: depth * (cardSize.height + 43) });
  }
  return result;
}

/** Lay out the visible hierarchy independently of access decisions. */
export function AccessReviewGraph({ scope, visible, muted, highlighted, render }: {
  scope: ReviewScope;
  visible: ReviewResource[];
  muted: Set<string>;
  highlighted: Set<string>;
  render: (resource: ReviewResource) => ReactNode;
}) {
  const layout = useMemo(() => positions(scope.root, visible), [scope.root, visible]);
  const flow = useRef<ReactFlowInstance<ReviewNode, Edge>>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void flow.current?.fitView(fitOptions); });
    return () => cancelAnimationFrame(frame);
  }, [layout]);
  const nodes: ReviewNode[] = visible.map((resource) => ({
    id: resource.object, type: "review", position: layout.get(resource.object)!,
    data: { content: render(resource), muted: muted.has(resource.object) },
    ...cardSize, handles: cardHandles(), draggable: false, selectable: false,
  }));
  const parents = useMemo(() => new Map(scope.resources.map(({ object, parent }) => [object, parent])), [scope]);
  const edgeIndex = new Map<string, Edge>();
  for (const edge of scope.edges) {
    if (edge.parent === edge.child || !layout.has(edge.parent) || !layout.has(edge.child)) continue;
    const id = reviewPair(edge.parent, edge.child);
    const onPath = highlighted.has(JSON.stringify([edge.subject, edge.relation, edge.object]));
    if (edgeIndex.has(id) && !onPath) continue;
    const primary = parents.get(edge.child) === edge.parent;
    const color = onPath ? "var(--green)" : muted.has(edge.child) ? "var(--line-strong)" : "var(--subtle)";
    edgeIndex.set(id, { id, source: edge.parent, target: edge.child, type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color }, style: {
        stroke: color, strokeWidth: onPath ? 3 : 1.4, ...(primary ? {} : { strokeDasharray: "4 4" }),
      }, zIndex: onPath ? 1 : 0,
    });
  }

  return <div className="review-graph">
    <ReactFlow nodes={nodes} edges={[...edgeIndex.values()]} nodeTypes={nodeTypes}
      onInit={(instance) => { flow.current = instance; }} fitView fitViewOptions={fitOptions}
      nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} minZoom={0.15} maxZoom={1.9}
      proOptions={{ hideAttribution: false }}>
      <Background color="var(--line-strong)" gap={20} />
      <Controls showInteractive={false} fitViewOptions={fitOptions} />
    </ReactFlow>
  </div>;
}
