// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";

import { expect, it, vi } from "vitest";

import { FgaLens } from "@/components/fga-lens";

const priorModel = [
  "model",
  "  schema 1.1",
  "",
  "type user",
  "",
  "type draft_document",
  "  relations",
  "    define viewer: [user]",
].join("\n");

/** Browser layout is covered in Chrome and Safari; jsdom has no layout observer. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

it("A05 · restores invalid legacy text and renders the previous valid graph with a diagnostic", async () => {
  const invalidDraft = priorModel.replace("[user]", "[");
  window.localStorage.setItem("fga-lens:model-draft:v1", invalidDraft);
  window.localStorage.setItem("fga-lens:last-valid-model:v1", priorModel);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<FgaLens />);
    });

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="OpenFGA authorization model"]');
    expect(editor?.value).toBe(invalidDraft);
    expect(container.textContent).toContain("Showing the last valid graph");
    expect(container.querySelector('button[aria-label="Collapse draft_document"]')).not.toBeNull();
    expect(window.localStorage.getItem("fga-lens:last-valid-model:v1")).toBe(priorModel);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});
