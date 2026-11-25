"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  reviewChecks, reviewPair, type ReviewItem, type ReviewOutcome, type ReviewResource, type ReviewScope,
} from "@/lib/workbench-access-review-contract";
import { canonical, type ConditionContext, type Target } from "@/lib/workbench-contract";

import { invoke } from "./workbench-ui";

type Row = ReviewOutcome | { unavailable: true };
type Run = {
  key: string;
  rows: Map<string, Row>;
  phase: "running" | "complete" | "cancelled" | "timeout" | "unavailable";
  observedAt?: number;
  diagnostic?: string;
};

function casesFor(scope?: ReviewScope) {
  return scope?.resources.flatMap(({ object, relations }) =>
    relations.map((relation) => ({ object, relation }))) ?? [];
}

function isSharedFailure(error: string) {
  return /^(?:authentication|connection|missing target|invalid input)(?: ·|$)/.test(error);
}

/** Queue whole captured checks, with two bounded requests and no retries. */
export function useReviewEvaluation(
  scope: ReviewScope | undefined, target: Target, subject: string, context: ConditionContext, enabled: boolean, visible: ReviewResource[], selection: number,
) {
  const { store, revision } = target;
  const cases = useMemo(() => casesFor(scope), [scope]);
  const key = scope && subject ? JSON.stringify([scope.root, scope.observedAt, subject, selection, canonical(context)]) : "";
  const [value, setValue] = useState<Run>();
  const cancel = useRef<() => void>(null);
  const shown = useRef(new Set<string>());
  useEffect(() => { shown.current = new Set(visible.map(({ object }) => object)); }, [visible]);

  useEffect(() => {
    if (!enabled || !key || !cases.length) return;
    const controller = new AbortController();
    const jobs = new Set(cases.map((entry, index) => ({ ...entry, id: "check-" + index })));
    const rows = new Map<string, Row>();
    let diagnostic: string | undefined;
    let observedAt: number | undefined;
    let sharedFailure = false;

    function publish(phase: Run["phase"]) {
      setValue({ key, rows: new Map(rows), phase, diagnostic, observedAt });
    }

    function finish(phase: "cancelled" | "timeout" | "unavailable") {
      controller.abort();
      clearTimeout(timer);
      publish(phase);
    }

    async function worker() {
      while (jobs.size && !controller.signal.aborted && !sharedFailure) {
        const pending = [...jobs];
        const batch: ReviewItem[] = [
          ...pending.filter(({ object }) => shown.current.has(object)),
          ...pending.filter(({ object }) => !shown.current.has(object)),
        ].slice(0, 25);
        for (const entry of batch) jobs.delete(entry);
        try {
          const reply = await invoke(reviewChecks, {
            action: "access-review-check", target: { store, revision }, subject, context, checks: batch,
          }, controller.signal);
          if (controller.signal.aborted) return;
          observedAt = Math.max(observedAt ?? 0, reply.observedAt);
          const results = new Map(reply.results.map((row) => [row.id, row]));
          for (const item of batch) rows.set(reviewPair(item.object, item.relation),
            results.get(item.id) ?? { unavailable: true });
        } catch (error) {
          if (controller.signal.aborted) return;
          diagnostic = error instanceof Error ? error.message : "server error";
          for (const item of batch) rows.set(reviewPair(item.object, item.relation), { unavailable: true });
          sharedFailure = isSharedFailure(diagnostic);
          if (sharedFailure) {
            finish("unavailable");
            return;
          }
        }
        publish("running");
      }
    }

    const timer = setTimeout(() => finish("timeout"), 30_000);
    cancel.current = () => finish("cancelled");
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      publish("running");
      void Promise.all([worker(), worker()]).then(() => {
        if (controller.signal.aborted) return;
        clearTimeout(timer);
        cancel.current = null;
        publish("complete");
      });
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      cancel.current = null;
    };
  }, [cases, context, enabled, key, revision, store, subject]);

  return { run: key && value?.key === key ? value : undefined, total: cases.length, key,
    cancel: () => cancel.current?.() };
}

export type { Row };
