"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { storeName, type StoreInfo } from "@/lib/workbench-contract";

/** Manage the stores on the configured endpoint from the Settings dialog. */
export function StoreSettings({ stores, selected, connected, refresh, create, remove }: {
  stores: StoreInfo[];
  selected: string;
  connected: boolean;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState("");
  const [problem, setProblem] = useState("");

  async function run(operation: string, action: () => Promise<void>, recovery: string) {
    setProblem("");
    setPending(operation);
    try {
      await action();
    } catch (error) {
      setProblem(operation + " · " + (error instanceof Error ? error.message : "server error") + recovery);
    } finally {
      setPending("");
    }
  }

  return <div className="wb-settings wb-store-settings">
    <form className="wb-actions wb-form-actions" onSubmit={(event) => {
      event.preventDefault();
      const entered = name.trim();
      if (!storeName.is(entered)) {
        setNameInvalid(true);
        setProblem("");
        return;
      }
      void run("Create " + entered, async () => {
        await create(entered);
        setName("");
      }, ". Refresh stores to verify the result before retrying.");
    }}>
      <label>Store name<input value={name} disabled={Boolean(pending)} aria-invalid={nameInvalid || undefined}
        aria-describedby={nameInvalid ? "wb-store-name-error" : undefined} onChange={(event) => {
          const next = event.target.value;
          setName(next);
          if (nameInvalid && storeName.is(next.trim())) setNameInvalid(false);
        }} /></label>
      <button type="submit" disabled={Boolean(pending)}>Create store</button>
      {nameInvalid && <p id="wb-store-name-error" className="wb-store-problem" role="alert">
        Enter a store name with 3–64 characters. Use letters, numbers, spaces or . - / ^ _ & @.
      </p>}
    </form>
    <div className="wb-store-heading">
      <h3>OpenFGA stores</h3>
      <button type="button" className="wb-icon-button wb-icon-button-quiet" aria-label="Refresh stores" title="Refresh stores" disabled={Boolean(pending)}
        onClick={() => void run("Refresh stores", refresh, ". Check the connection in General.")}>
        <RefreshCw size={16} aria-hidden />
      </button>
    </div>
    {pending && <p role="status">{pending}…</p>}
    {problem && <p className="wb-store-problem" role="alert">{problem}</p>}
    {stores.length ? <ul className="wb-store-list">
      {stores.map(({ id, name }) => <li key={id}>
        <div className="wb-store-row">
          <div className="wb-store-identity"><strong>{name}</strong><code>{id}</code>
            {selected === id && <small>Selected</small>}</div>
          <button type="button" aria-label={"Delete " + name} disabled={Boolean(pending)} onClick={() => {
            setConfirmation(id);
            setProblem("");
          }}>Delete</button>
        </div>
        {confirmation === id && <div className="wb-store-confirm">
          <p>Delete <strong>{name}</strong> from OpenFGA? Local drafts stay in the workspace.</p>
          <div className="wb-actions">
            <button type="button" disabled={Boolean(pending)} onClick={() => { setConfirmation(""); setProblem(""); }}>Cancel</button>
            <button type="button" className="wb-store-delete" disabled={Boolean(pending)} onClick={() => {
              void run("Delete " + name, async () => {
                await remove(id);
                setConfirmation("");
              }, ". Refresh stores to verify the result before retrying.");
            }}>Delete store</button>
          </div>
        </div>}
      </li>)}
    </ul> : <p>{connected ? "No stores on this server." : "Connect to OpenFGA to list stores."}</p>}
  </div>;
}
