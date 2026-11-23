import { randomUUID } from "node:crypto";
import type { Category, Failure, TupleIssue } from "./workbench-contract";

/** Safe application failure classified at the operation boundary. */
export class OperationFailure extends Error {
  constructor(readonly category: Category) {
    super(category);
  }
}

/** A rejected tuple plan has made no upstream writes and can safely return structured source hints. */
export class TuplePlanRejection extends OperationFailure {
  constructor(readonly issues: TupleIssue[]) {
    super("invalid input");
  }
}

/** Emit the fixed event and its approved diagnostic fields. */
export function diagnose(error: OperationFailure | null, started: number): Failure {
  const category = error?.category ?? "server error";
  const correlationId = randomUUID();
  console.error("Workbench operation failed", { category, correlationId, duration: performance.now() - started });
  return { error: category, correlationId };
}
