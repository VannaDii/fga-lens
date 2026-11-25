"use client";

import {
  AlertTriangle,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  FileCode2,
  GitFork,
  Link2,
  Maximize2,
  Minimize2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { SourceEditor } from "./source-editor";
import { highlightModelLine } from "./workbench-source-syntax";
import { ModelGraphCanvas } from "@/components/model-graph";
import {
  defaultModel,
  findRelationByLine,
  formatSubject,
  parseAuthorizationModel,
  type GraphRelation,
  type GraphExpression,
  type ModelDiagnostic,
  type ModelGraph,
} from "@/lib/fga-model";
import { restoreModelSession } from "@/lib/model-session";
import { sampleModels, type SampleModel } from "@/lib/sample-models";

const initialParseResult = parseAuthorizationModel(defaultModel);
const modelDraftStorageKey = "fga-lens:model-draft:v1";
const lastValidModelStorageKey = "fga-lens:last-valid-model:v1";

/** Draw the local FGA Lens mark for the workbench and standalone editor. */
export function LogoMark() {
  return (
    <div className="logo-mark" aria-hidden="true">
      <div className="logo-dot logo-dot-a" />
      <div className="logo-dot logo-dot-b" />
      <div className="logo-dot logo-dot-c" />
      <div className="logo-line logo-line-a" />
      <div className="logo-line logo-line-b" />
    </div>
  );
}

function isSameModel(first: string, second: string) {
  return first.trim() === second.trim();
}

function ExampleModelPicker({
  modelText,
  onSelect,
}: {
  modelText: string;
  onSelect: (sample: SampleModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const activeSample = sampleModels.find((sample) => isSameModel(sample.model, modelText));

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="sample-picker" ref={pickerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={`sample-picker-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="sample-picker-icon"><BookOpen size={13} /></span>
        <span className="sample-picker-copy">
          <small>Example</small>
          <strong>{activeSample?.label ?? "Custom model"}</strong>
        </span>
        <ChevronDown className="sample-picker-chevron" size={13} />
      </button>

      {open && (
        <div aria-label="Official OpenFGA sample stores" className="sample-picker-menu" role="menu">
          <div className="sample-menu-heading">
            <div><span>Official examples</span><strong>Sample stores</strong></div>
            <span>{sampleModels.length} models</span>
          </div>
          <div className="sample-menu-list">
            {sampleModels.map((sample, index) => {
              const selected = activeSample?.id === sample.id;
              return (
                <button
                  aria-checked={selected}
                  className={selected ? "selected" : ""}
                  key={sample.id}
                  onClick={() => {
                    onSelect(sample);
                    setOpen(false);
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <span className="sample-menu-marker">{selected ? <Check size={12} /> : index + 1}</span>
                  <span className="sample-menu-copy">
                    <strong>{sample.label}</strong>
                    <small>{sample.description}</small>
                  </span>
                  <code>{sample.typeCount}T · {sample.relationCount}R</code>
                </button>
              );
            })}
          </div>
          <a
            href="https://github.com/openfga/sample-stores/tree/main/stores"
            rel="noreferrer"
            target="_blank"
          >
            View source on GitHub <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}

/** Render syntax highlighting and link selected rules to the editor. */
function ModelEditor({
  diagnostics,
  graph,
  modelText,
  onChange,
  onSelectRelation,
  selectedLine,
  workspace,
  readOnly,
  editor,
}: {
  diagnostics: ModelDiagnostic[];
  graph: ModelGraph;
  modelText: string;
  onChange: (model: string) => void;
  onSelectRelation: (relation: GraphRelation) => void;
  selectedLine?: number;
  workspace: boolean;
  readOnly: boolean;
  editor: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const diagnosticLines = new Set(diagnostics.map((diagnostic) => diagnostic.line));
  const isChanged = modelText !== defaultModel;

  useEffect(() => {
    if (!selectedLine || !editor.current) return;
    const textarea = editor.current;
    const height = Number.parseFloat(window.getComputedStyle(textarea).lineHeight);
    const position = (selectedLine - 1) * height;
    if (position < textarea.scrollTop || position + height >= textarea.scrollTop + textarea.clientHeight) {
      textarea.scrollTo?.({ top: Math.max(0, position - height * 2) });
    }
  }, [editor, selectedLine]);

  const selectCurrentLine = (textarea: HTMLTextAreaElement) => {
    const line = modelText.slice(0, textarea.selectionStart).split("\n").length;
    const relation = findRelationByLine(graph, line);
    if (relation) onSelectRelation(relation);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (workspace || event.key !== "Tab") return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    onChange(`${modelText.slice(0, start)}  ${modelText.slice(end)}`);
    window.requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2));
  };

  return (
    <div className="live-editor">
      <div className="code-toolbar">
        <div className="editor-file">
          <span>authorization-model.fga</span>
        </div>
        <div className="editor-actions">
          <span className={`live-state ${diagnostics.length ? "invalid" : ""}`}>
            <i /> {diagnostics.length ? `${diagnostics.length} ${diagnostics.length === 1 ? "issue" : "issues"}` : "Valid"}
          </span>
          {!readOnly && isChanged && (
            <button onClick={() => onChange(defaultModel)} title="Restore the example model">
              <RotateCcw size={11} /> Reset
            </button>
          )}
        </div>
      </div>

      {!readOnly && <div className="local-trust-note" role="note">
        <span className="local-trust-icon"><ShieldCheck size={13} /></span>
        <span>
          <strong>Local processing</strong>
          <small>{workspace ? "Publication sends the saved model to the selected store." : "Model contents are never uploaded."}</small>
        </span>
      </div>}

      <SourceEditor aria-label="OpenFGA authorization model" ref={editor} value={modelText} readOnly={readOnly}
        paintLine={highlightModelLine} selectedLine={selectedLine} diagnosticLines={diagnosticLines}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => selectCurrentLine(event.currentTarget)}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => selectCurrentLine(event.currentTarget)} />

      <div className="editor-footer">
        <span>{graph.schemaVersion} · {graph.types.length} types · {graph.relationCount} relations</span>
        <span>{diagnostics[0] ? `L${diagnostics[0].line}:${diagnostics[0].column} ${diagnostics[0].message}` : "OpenFGA language parser"}</span>
      </div>
    </div>
  );
}

function ExpressionTree({ expression, type }: { expression: GraphExpression; type: string }) {
  if (expression.kind === "union" || expression.kind === "intersection") {
    const isUnion = expression.kind === "union";
    return (
      <div className={`expression-group ${expression.kind}`}>
        <div className="expression-group-label">
          <span>{isUnion ? "Any of" : "All of"}</span>
          <code>{isUnion ? "OR" : "AND"}</code>
        </div>
        <div className="expression-children">
          {expression.children.map((child, index) => (
            <ExpressionTree expression={child} key={`${child.kind}-${index}`} type={type} />
          ))}
        </div>
      </div>
    );
  }

  if (expression.kind === "difference") {
    return (
      <div className="expression-group difference">
        <div className="expression-group-label"><span>Difference</span><code>EXCEPT</code></div>
        <div className="expression-children difference-children">
          <div className="expression-scope include"><span>Include</span><ExpressionTree expression={expression.base} type={type} /></div>
          <div className="expression-scope exclude"><span>Exclude</span><ExpressionTree expression={expression.subtract} type={type} /></div>
        </div>
      </div>
    );
  }

  if (expression.kind === "computed") {
    return (
      <div className="expression-leaf computed">
        <i /><code>{type}.{expression.relation}</code><span>computed relation</span>
      </div>
    );
  }

  if (expression.kind === "inherited") {
    return (
      <div className="expression-leaf inherited">
        <i />
        <div>
          {expression.sourceTypes.map((sourceType) => (
            <code key={sourceType}>{sourceType}.{expression.relation}</code>
          ))}
        </div>
        <span>from {expression.tupleset}</span>
      </div>
    );
  }

  return (
    <div className="expression-leaf direct">
      <i />
      <div>
        {expression.subjects.map((subject) => (
          <code key={`${subject.type}-${subject.relation}-${subject.wildcard}-${subject.condition}`}>
            {formatSubject(subject)}{subject.condition ? ` with ${subject.condition}` : ""}
          </code>
        ))}
      </div>
      <span>direct</span>
    </div>
  );
}

/** Explain a relation and link back to the corresponding DSL line. */
function RelationInspector({ relation, onClose, onSource }: {
  relation: GraphRelation; onClose: () => void; onSource?: (line: number) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyExpression = async () => {
    await navigator.clipboard.writeText(`define ${relation.name}: ${relation.expression}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <aside className="relation-inspector">
      <header>
        <div>
          <span>Selected relation</span>
          <strong>{relation.type}.{relation.name}</strong>
        </div>
        <button onClick={onClose} aria-label="Close relation details"><X size={15} /></button>
      </header>

      <div className="relation-inspector-body">
        <div className={`relation-kind ${relation.kind}`}>
          {relation.kind === "permission" ? <Braces size={13} /> : <Link2 size={13} />}
          {relation.kind}
        </div>

        <div className="inspector-expression">
          <div>
            {onSource ? <button type="button" onClick={() => onSource(relation.line)}>Source line {relation.line}</button>
              : <span>LAST VALID SOURCE · LINE {relation.line}</span>}
            <button onClick={copyExpression}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button>
          </div>
          <code><em>define {relation.name}:</em> {relation.expression}</code>
        </div>

        {relation.directSubjects.length > 0 && (
          <section className="inspector-section">
            <span>Accepts directly</span>
            <div className="subject-chips">
              {relation.directSubjects.map((subject) => (
                <code key={`${subject.type}-${subject.relation}-${subject.wildcard}-${subject.condition}`}>
                  {formatSubject(subject)}{subject.condition ? ` with ${subject.condition}` : ""}
                </code>
              ))}
            </div>
          </section>
        )}

        <section className="inspector-section">
          <span>Authorization logic</span>
          <div className="expression-tree">
            <ExpressionTree expression={relation.rewrite} type={relation.type} />
          </div>
        </section>
      </div>
    </aside>
  );
}

/** Render the existing editor and graph with either a file workspace or legacy standalone storage. */
export function FgaLens({ draft, onDraft, relationId, onRelation, actions, publishedLine }: {
  draft?: { dsl: string; validDsl: string };
  actions?: ReactNode;
  /** Highlight the definition in a read-only published revision. */
  publishedLine?: number;
  /** Save the current input and newest valid source independently. */
  onDraft?: (dsl: string, validDsl?: string) => void;
  /** Optional relation selection restored from the file workspace. */
  relationId?: string;
  /** Persist relation selection independently of the DSL editor. */
  onRelation?: (relationId: string) => void;
} = {}) {
  const readOnly = publishedLine !== undefined;
  const [modelText, setModelText] = useState(draft?.dsl ?? defaultModel);
  const [parsed, setParsed] = useState(() => draft ? parseAuthorizationModel(draft.dsl) : initialParseResult);
  const [lastValidGraph, setLastValidGraph] = useState(() => draft
    ? restoreModelSession(draft.dsl, draft.validDsl).lastValidGraph : initialParseResult.graph!);
  const [lastValidModelText, setLastValidModelText] = useState(draft?.validDsl ?? defaultModel);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(relationId || null);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [graphSession, setGraphSession] = useState(0);
  const [draftStorageReady, setDraftStorageReady] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const graphTrigger = useRef<HTMLElement | SVGElement>(null);
  const expandedControl = useRef<HTMLButtonElement>(null);
  const selection = useRef(selectedRelationId);

  const graph = parsed.graph ?? lastValidGraph;
  const selectedRelation = graph.types
    .flatMap((type) => type.relations)
    .find((relation) => relation.id === selectedRelationId) ?? null;
  /** Keep relation selection stable across graph clicks and duplicate selection events. */
  const changeRelation = useCallback((id: string | null) => {
    if (selection.current === id) return;
    selection.current = id;
    setSelectedRelationId(id);
    onRelation?.(id ?? "");
  }, [onRelation]);

  /** Open details from the graph or editor and preserve the initiating focus. */
  const selectRelation = useCallback((relation: GraphRelation) => {
    const focused = document.activeElement;
    if (selection.current === relation.id) return;
    if (focused instanceof HTMLElement || focused instanceof SVGElement) graphTrigger.current = focused;
    changeRelation(relation.id);
  }, [changeRelation]);

  /** Dismiss the inspector and return keyboard focus to its trigger. */
  const closeRelation = useCallback(() => {
    changeRelation(null);
    window.requestAnimationFrame(() => graphTrigger.current?.focus());
  }, [changeRelation]);

  /** Focus the editor at a selected source line. */
  const openSource = (line: number) => {
    const rows = modelText.split("\n");
    if (!editor.current || rows[line - 1] === undefined) return;
    const start = rows.slice(0, line - 1).reduce((offset, row) => offset + row.length + 1, 0);
    setGraphExpanded(false);
    window.requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(start, start + rows[line - 1].length);
    });
  };
  const updateModel = useCallback((nextModel: string) => {
    const nextResult = parseAuthorizationModel(nextModel);
    setModelText(nextModel);
    setParsed(nextResult);
    onDraft?.(nextModel, nextResult.graph ? nextModel : undefined);
    if (nextResult.graph) {
      setLastValidGraph(nextResult.graph);
      setLastValidModelText(nextModel);
    }
  }, [onDraft]);
  const loadSample = useCallback((sample: SampleModel) => {
    changeRelation(null);
    setGraphSession((current) => current + 1);
    updateModel(sample.model);
  }, [changeRelation, updateModel]);

  useEffect(() => {
    if (draft !== undefined) return;
    let savedModel: string | null = null;
    let savedLastValidModel: string | null = null;
    try {
      savedModel = window.localStorage.getItem(modelDraftStorageKey);
      savedLastValidModel = window.localStorage.getItem(lastValidModelStorageKey);
    } catch {
      // The editor still works when storage is blocked or unavailable.
    }

    let active = true;
    window.queueMicrotask(() => {
      if (!active) return;
      const restored = restoreModelSession(savedModel, savedLastValidModel);
      setModelText(restored.modelText);
      setParsed(restored.parsed);
      setLastValidGraph(restored.lastValidGraph);
      setLastValidModelText(restored.lastValidModelText);
      setDraftStorageReady(true);
    });
    return () => { active = false; };
  }, [draft]);

  useEffect(() => {
    if (!draftStorageReady) return;
    try {
      window.localStorage.setItem(modelDraftStorageKey, modelText);
      window.localStorage.setItem(lastValidModelStorageKey, lastValidModelText);
    } catch {
      // Ignore quota and privacy-mode failures rather than interrupting editing.
    }
  }, [draftStorageReady, lastValidModelText, modelText]);

  useEffect(() => {
    const closeExpandedGraph = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (graphExpanded) {
        setGraphExpanded(false);
        expandedControl.current?.focus();
      } else if (selectedRelationId) closeRelation();
    };
    window.addEventListener("keydown", closeExpandedGraph);
    return () => window.removeEventListener("keydown", closeExpandedGraph);
  }, [closeRelation, graphExpanded, selectedRelationId]);

  return (
    <div className="studio-shell">
      {!draft && <header className="studio-header">
        <div className="brand-lockup"><LogoMark /><strong>FGA Lens</strong></div>
        <div className="document-path" aria-label="Current model">
          <span>model</span><b>/</b><strong>authorization-model.fga</strong>
        </div>
        <div className="header-actions">
          <span className={`parser-status ${parsed.diagnostics.length ? "invalid" : ""}`}>
            {parsed.diagnostics.length ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
            {parsed.diagnostics.length ? "Model has issues" : "Model valid"}
          </span>
          <a
            aria-label="View FGA Lens source on GitHub"
            href="https://github.com/Siddhant-K-code/fga-lens"
            target="_blank"
            rel="noreferrer"
          >
            <GitFork size={13} /> GitHub
          </a>
          <a href="https://openfga.dev/docs/configuration-language" target="_blank" rel="noreferrer">
            <FileCode2 size={13} /> DSL reference
          </a>
        </div>
      </header>}

      <div className={`studio-workspace ${graphExpanded ? "graph-expanded" : ""}`}>
        <aside className="model-pane">
          <header className="pane-heading">
            <h1>{readOnly ? "Published authorization model" : "Authorization model"}</h1>
            {!readOnly && <ExampleModelPicker modelText={modelText} onSelect={loadSample} />}
            {actions}
          </header>
          <ModelEditor
            diagnostics={parsed.diagnostics}
            editor={editor}
            workspace={Boolean(draft)}
            readOnly={readOnly}
            graph={graph}
            modelText={modelText}
            onChange={updateModel}
            onSelectRelation={selectRelation}
            selectedLine={readOnly ? selectedRelation?.line ?? publishedLine : parsed.diagnostics[0]?.line ?? selectedRelation?.line}
          />
        </aside>

        <main className="graph-pane">
          <div className="graph-toolbar">
            <div>
              <span className="graph-title-icon"><GitFork size={15} /></span>
              <h2>Model graph</h2>
            </div>
            <div className="graph-stats">
              <span><strong>{graph.types.length}</strong> types</span>
              <span><strong>{graph.relationCount}</strong> relations</span>
              <span><strong>{graph.dependencies.length}</strong> edges</span>
            </div>
            <div className="graph-toolbar-actions">
              <div className="graph-legend" aria-label="Graph edge legend">
                <span><i className="direct" /> direct</span>
                <span><i className="computed" /> computed</span>
                <span><i className="inherited" /> inherited</span>
              </div>
              <button
                aria-label={graphExpanded ? "Exit expanded graph" : "Expand graph"}
                aria-pressed={graphExpanded}
                className="expand-graph-button"
                ref={expandedControl}
                onClick={() => setGraphExpanded((current) => !current)}
                title={graphExpanded ? "Exit expanded view (Esc)" : "Give the graph the full workspace"}
              >
                {graphExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                <span>{graphExpanded ? "Exit" : "Expand"}</span>
              </button>
            </div>
          </div>

          <div className={`graph-canvas ${selectedRelation ? "has-inspector" : ""}`}>
            <ModelGraphCanvas
              graph={graph}
              key={graphSession}
              onClearSelection={() => changeRelation(null)}
              onSelect={selectRelation}
              selectedRelationId={selectedRelationId}
              viewKey={`${graphExpanded ? "expanded" : "split"}:${selectedRelationId ?? "all"}`}
            />
            {parsed.diagnostics.length > 0 && (
              <div className="model-error-toast">
                <AlertTriangle size={15} />
                <div><strong>Showing the last valid graph</strong><span>L{parsed.diagnostics[0].line}:{parsed.diagnostics[0].column} · {parsed.diagnostics[0].message}</span></div>
              </div>
            )}
            {selectedRelation && <RelationInspector relation={selectedRelation} onClose={closeRelation} onSource={parsed.graph ? openSource : undefined} />}
          </div>
        </main>
      </div>
    </div>
  );
}
