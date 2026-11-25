"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  reviewCheckObject, reviewChecks, reviewPair, type ReviewOutcome, type ReviewScope,
} from "@/lib/workbench-access-review-contract";
import { canonical, type ConditionContext, type Target } from "@/lib/workbench-contract";

import { invoke } from "./workbench-ui";

type Row = ReviewOutcome | { unavailable: true; reason?: "object-too-long" };
type BatchTiming = { count: number; sum: number; min: number; max: number };
type Run = {
  key: string;
  rows: Map<string, Row>;
  phase: "running" | "complete" | "cancelled" | "timeout" | "unavailable";
  observedAt?: number;
  diagnostic?: string;
  timing: { firstResults?: number; laterBatches?: BatchTiming; elapsed?: number };
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
  scope: ReviewScope | undefined, target: Target, subject: string, context: ConditionContext, enabled: boolean, selection: number,
) {
  const { store, revision } = target;
  const cases = useMemo(() => casesFor(scope), [scope]);
  const key = scope && subject ? JSON.stringify([scope.root, scope.observedAt, subject, selection, canonical(context)]) : "";
  const [value, setValue] = useState<Run>();
  const cancel = useRef<() => void>(null);

  useEffect(() => {
    if (!enabled || !key || !cases.length) return;
    const controller = new AbortController();
    const jobs = new Set<{ object: string; relation: string; id: string }>();
    const rows = new Map<string, Row>();
    cases.forEach((entry, index) => {
      if (reviewCheckObject.is(entry.object)) jobs.add({ ...entry, id: "check-" + index });
      else rows.set(reviewPair(entry.object, entry.relation), { unavailable: true, reason: "object-too-long" });
    });
    const hasBatches = jobs.size > 0;
    const started = performance.now();
    let firstResults: number | undefined;
    let laterBatches: BatchTiming | undefined;
    let diagnostic: string | undefined;
    let observedAt: number | undefined;
    let sharedFailure = false;

    function publish(phase: Run["phase"]) {
      const elapsed = hasBatches && phase !== "running" ? performance.now() - started : undefined;
      setValue({ key, rows: new Map(rows), phase, diagnostic, observedAt, timing: { firstResults, laterBatches, elapsed } });
    }

    function finish(phase: "cancelled" | "timeout" | "unavailable") {
      controller.abort();
      clearTimeout(timer);
      publish(phase);
    }

    async function worker() {
      while (jobs.size && !controller.signal.aborted && !sharedFailure) {
        const batch = [...jobs].slice(0, 25);
        for (const entry of batch) jobs.delete(entry);
        const sent = performance.now();
        try {
          const reply = await invoke(reviewChecks, {
            action: "access-review-check", target: { store, revision }, subject, context, checks: batch,
          }, controller.signal);
          if (controller.signal.aborted) return;
          const received = performance.now();
          const elapsed = received - sent;
          if (firstResults === undefined) firstResults = received - started;
          else laterBatches = laterBatches ? {
            count: laterBatches.count + 1,
            sum: laterBatches.sum + elapsed,
            min: Math.min(laterBatches.min, elapsed),
            max: Math.max(laterBatches.max, elapsed),
          } : { count: 1, sum: elapsed, min: elapsed, max: elapsed };
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
