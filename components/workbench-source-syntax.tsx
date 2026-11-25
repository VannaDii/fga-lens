import { Fragment, type ReactNode } from "react";
import { CST, Lexer } from "yaml";

const punctuation = new Set(["seq-item-ind", "map-value-ind", "flow-map-start", "flow-map-end", "flow-seq-start", "flow-seq-end", "comma"]);
const jsonLiteral = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/** Paint FGA definitions consistently in the model editor and published source. */
export function highlightModelLine(line: string) {
  return line
    .split(/(\b(?:model|schema|type|relations|define|or|and|but|not|from|condition|with)\b|[\[\](),:#*])/g)
    .map((token, index) => {
      const keyword = /^(model|schema|type|relations|define|or|and|but|not|from|condition|with)$/.test(token);
      const punctuation = /^[\[\](),:#*]$/.test(token);
      return <span className={keyword ? "syntax-keyword" : punctuation ? "syntax-punctuation" : undefined}
        key={index}>{token}</span>;
    });
}

/** Use the existing YAML lexer for both formats so strings, userset IDs and comments stay distinct. */
export function highlightStructuredSource(source: string, format: "yaml" | "json") {
  const tokens: { text: string; type: ReturnType<typeof CST.tokenType> }[] = [];
  let plainScalar = false;
  for (const text of new Lexer().lex(source)) {
    if (plainScalar) tokens.push({ text, type: null });
    else if (text !== CST.SCALAR && text !== CST.DOCUMENT && text !== CST.FLOW_END) tokens.push({ text, type: CST.tokenType(text) });
    plainScalar = !plainScalar && text === CST.SCALAR;
  }
  if (tokens.map(({ text }) => text).join("") !== source) return [];

  let row: ReactNode[] = [];
  const rows = [row];
  tokens.forEach(({ text, type }, index) => {
    const quoted = type === "double-quoted-scalar" || type === "single-quoted-scalar";
    let kind: string | undefined;
    if (type === null || quoted) {
      let next = index + 1;
      while (tokens[next]?.type === "space" || tokens[next]?.type === "newline") next += 1;
      if (tokens[next]?.type === "map-value-ind") kind = "keyword";
      else if (quoted) kind = "string";
      else if (format === "json" && jsonLiteral.test(text)) kind = "literal";
    } else if (type === "comment") kind = "comment";
    else if (punctuation.has(type)) kind = "punctuation";
    text.split("\n").forEach((part, line) => {
      if (line) rows.push(row = []);
      if (part) row.push(kind ? <span className={"syntax-" + kind} key={index}>{part}</span> : part);
    });
  });
  return rows;
}

/** Highlight a captured JSON value while preserving the exact formatted text for copying. */
export function JsonBlock({ value }: { value: unknown }) {
  const source = JSON.stringify(value, null, 2);
  const lines = highlightStructuredSource(source, "json");
  return <pre className="wb-json-block"><code>{lines.length ? lines.map((line, index) =>
    <Fragment key={index}>{index > 0 && "\n"}{line}</Fragment>) : source}</code></pre>;
}
