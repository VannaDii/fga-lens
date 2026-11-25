"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as t from "io-ts";
import { ChevronDown, X } from "lucide-react";

import { decode, failure, progress, tupleRejection, type Failure, type InstalledModel, type TupleIssue } from "@/lib/workbench-contract";

const address = "/api/workbench";

/** Use the workbench's shared appearance with native disclosure behavior. */
export function Disclosure({ title, meta, preview, className, open, onOpenChange, children }: {
  title: string; meta?: ReactNode; preview?: ReactNode; className?: string; open?: boolean; children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return <details className={className ? "wb-disclosure " + className : "wb-disclosure"} open={open}
    onToggle={onOpenChange && ((event) => {
      if (event.target === event.currentTarget && event.currentTarget.open !== open) onOpenChange(event.currentTarget.open);
    })}>
    <summary>
      <span>{title}</span>
      {meta && <span className="wb-disclosure-meta">{meta}</span>}
      <ChevronDown className="wb-disclosure-chevron" size={16} aria-hidden />
      {preview}
    </summary>
    <div className="wb-disclosure-body">{children}</div>
  </details>;
}

/** A decoded rejection for an attempted tuple publication, with safe row coordinates. */
export class TuplePublishRejection extends Error {
  constructor(readonly issues: TupleIssue[], diagnostic: Failure) {
    super(failureText(diagnostic));
  }
}

/** Format only the decoded safe reason and generated correlation ID. */
export function failureText(error: Failure) {
  return error.error + " · " + error.correlationId;
}

/** Decode each application response before using any of its data. */
export async function invoke<A>(codec: t.Type<A>, command?: object, signal?: AbortSignal): Promise<A> {
  let response: Response;
  try {
    response = await fetch(address, command ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command), signal,
    } : { signal });
  } catch {
    throw new Error(signal?.aborted ? "cancellation" : "connection");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const rejected = decode(tupleRejection, payload);
    if (rejected) throw new TuplePublishRejection(rejected.tupleIssues, rejected);
    const error = decode(failure, payload);
    throw new Error(error ? failureText(error) : "server error");
  }
  const decoded = decode(codec, payload);
  if (decoded === null) throw new Error("server error");
  return decoded;
}

/** Poll the progress of one active operation and send cancellation to the server. */
export function JobStatus({ id, label, unit }: { id: string; label: string; unit: string }) {
  const [status, setStatus] = useState<t.TypeOf<typeof progress> | null>(null);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      void invoke(progress, { action: "progress", job: id }, controller.signal).then(setStatus).catch(() => undefined);
    }, 350);
    return () => { clearInterval(timer); controller.abort(); };
  }, [id]);

  return <div className="wb-actions">
    <span role="status">{cancelling ? "Cancelling…" : label}
      {status?.active ? " · " + status.completed + (status.total === null ? "" : "/" + status.total) + " " + unit : ""}</span>
    <button type="button" disabled={cancelling} onClick={() => {
      void invoke(t.type({ cancelled: t.boolean }), { action: "cancel", job: id })
        .then(({ cancelled }) => setCancelling(cancelled)).catch(() => undefined);
    }}>Cancel</button>
  </div>;
}

/** A native dialog provides focus trapping, Escape dismissal and trigger focus return. */
export function Dialog({ title, children, close, iconClose }: { title: string; children: ReactNode; close: () => void; iconClose?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      const focused = document.activeElement;
      trigger.current = focused instanceof HTMLElement ? focused : null;
      element.showModal();
    }
    return () => {
      queueMicrotask(() => {
        if (element && !element.isConnected && trigger.current?.isConnected) trigger.current.focus();
      });
    };
  }, []);
  return <dialog ref={dialog} aria-label={title} onClose={close}>
    <header className="wb-actions"><h2>{title}</h2><button type="button" aria-label="Close" className={iconClose ? "wb-icon-button" : undefined}
      onClick={() => dialog.current?.close()}>{iconClose ? <X size={18} aria-hidden /> : "Close"}</button></header>
    {children}
  </dialog>;
}

/** Label installed revisions from oldest to newest within each store. Preserve the exact server IDs. */
export function revisionOptions(models: InstalledModel[]) {
  return models.map((model, index) => ({ value: model.id, label: "Version " + (models.length - index) }));
}

/** A labelled native selector with optional display names and a full-value tooltip. */
export function Select({ label, value, options, change, title, required }: {
  label: string; value: string; options: Array<string | { value: string; label: string }>; change: (value: string) => void;
  title?: string; required?: boolean;
}) {
  return <label>{required ? <span>{label}<span aria-hidden="true" className="wb-required-mark"> *</span></span> : label}
    <select title={title} value={value} required={required} aria-invalid={required && !value ? true : undefined}
      onChange={(event) => change(event.target.value)}>
    <option value="">Select {label.toLowerCase()}</option>
    {options.map((option) => typeof option === "string"
      ? <option key={option}>{option}</option>
      : <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

/** Download authored data in the requested format. */
export function download(name: string, content: string) {
  const href = URL.createObjectURL(new Blob([content], { type: "application/yaml" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
