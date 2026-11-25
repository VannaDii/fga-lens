"use client";

import { useState, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";

type SourceProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onScroll"> & {
  value: string;
  ref: Ref<HTMLTextAreaElement>;
  paintLine: (line: string) => ReactNode;
  selectedLine?: number;
  diagnosticLines?: ReadonlySet<number>;
};

/** Keep highlighted text and line numbers aligned with a native editable textarea. */
export function SourceEditor({ value, ref, paintLine, selectedLine, diagnosticLines, ...input }: SourceProps) {
  const [scroll, setScroll] = useState({ left: 0, top: 0 });

  return <div className="editor-surface">
    <pre className="editor-highlight" aria-hidden="true"
      style={{ transform: "translate(" + -scroll.left + "px, " + -scroll.top + "px)" }}>
      {value.split("\n").map((line, index) => {
        const number = index + 1;
        return <span key={number}
          className={["editor-row", selectedLine === number && "highlighted", diagnosticLines?.has(number) && "diagnostic"]
            .filter(Boolean).join(" ")}>
          <span className="editor-line-number">{number}</span>
          <code>{paintLine(line || " ")}</code>
        </span>;
      })}
    </pre>
    <textarea {...input} ref={ref} value={value} autoCapitalize="off" autoCorrect="off" spellCheck={false} wrap="off"
      onScroll={(event) => setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })} />
  </div>;
}
