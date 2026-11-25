"use client";

import { useEffect, useState } from "react";

import { installedModel, type Target } from "@/lib/workbench-contract";
import { modelDsl } from "@/lib/workbench-models";
import { FgaLens } from "./fga-lens";
import { invoke } from "./workbench-ui";

/** Read the store and revision captured by the query result. */
export function WorkbenchModelSource({ target: { store, revision }, line }: { target: Target; line: number }) {
  const [source, setSource] = useState<{ dsl: string } | { error: string }>();

  useEffect(() => {
    const request = new AbortController();
    void invoke(installedModel, { action: "read-model", target: { store, revision } }, request.signal)
      .then((model) => {
        if (request.signal.aborted) return;
        const dsl = modelDsl(model);
        setSource(line <= dsl.split("\n").length ? { dsl } : { error: `Line ${line} is outside this revision.` });
      })
      .catch((error: Error) => {
        if (!request.signal.aborted) setSource({ error: error.message });
      });
    return () => request.abort();
  }, [store, revision, line]);

  return <>
    <div className="wb-actions wb-editor-feedback">
      <span>Store ID <code>{store}</code></span>
      <span>Model revision ID <code>{revision}</code></span>
      <span>Read-only · Line {line}</span>
    </div>
    {!source ? <p className="wb-notice" role="status">Loading published model…</p>
      : "error" in source ? <p className="wb-notice" role="alert">Could not open model source · {source.error}</p>
        : <FgaLens draft={{ dsl: source.dsl, validDsl: source.dsl }} publishedLine={line} />}
  </>;
}
