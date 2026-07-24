import type { ComponentChild } from "preact";

/**
 * Minimal, safe markdown renderer for chat messages.
 * Builds Preact VNodes directly (never innerHTML), so message text is always escaped.
 * Supports: headings, bold/italic, inline code, fenced code blocks,
 * pipe tables, unordered/ordered lists, horizontal rules, links, paragraphs.
 */

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(([^)\s]+)\))/g;

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ kind: "text", text: text.slice(lastIndex, index) });
    const raw = match[0];
    if (raw.startsWith("**")) tokens.push({ kind: "bold", text: raw.slice(2, -2) });
    else if (raw.startsWith("*")) tokens.push({ kind: "italic", text: raw.slice(1, -1) });
    else if (raw.startsWith("`")) tokens.push({ kind: "code", text: raw.slice(1, -1) });
    else if (raw.startsWith("[")) {
      const label = raw.slice(1, raw.indexOf("]("));
      const href = match[2] ?? "";
      if (isSafeHref(href)) tokens.push({ kind: "link", text: label, href });
      else tokens.push({ kind: "text", text: raw });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", text: text.slice(lastIndex) });
  return tokens;
}

function renderInline(text: string, keyPrefix: string): ComponentChild[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyPrefix}:${index}`;
    switch (token.kind) {
      case "bold": return <strong key={key}>{token.text}</strong>;
      case "italic": return <em key={key}>{token.text}</em>;
      case "code": return <code key={key}>{token.text}</code>;
      case "link": return <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">{token.text}</a>;
      default: return token.text;
    }
  });
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;
const LIST_ITEM_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.indexOf("|") > 0);
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Fenced code block
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // skip closing fence
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: codeLines.join("\n") });
      continue;
    }

    // Blank line separates blocks
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    // Heading
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: (heading[2] ?? "").trim() });
      index += 1;
      continue;
    }

    // Horizontal rule (--- alone on a line)
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    // List items (consecutive)
    const listItem = LIST_ITEM_PATTERN.exec(line);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[2] ?? "");
      const items: string[] = [];
      while (index < lines.length) {
        const item = LIST_ITEM_PATTERN.exec(lines[index] ?? "");
        if (!item) break;
        if (/^\d/.test(item[2] ?? "") !== ordered) break;
        items.push((item[3] ?? "").trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Table: header row + separator row
    if (looksLikeTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").trim() !== "" && looksLikeTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // Plain text line
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function renderBlock(block: Block, key: string): ComponentChild {
  switch (block.kind) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5";
      return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text, key)}</p>;
    case "code":
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => <li key={`${key}:${itemIndex}`}>{renderInline(item, `${key}:${itemIndex}`)}</li>);
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <div key={key} class="md-table-wrap">
          <table>
            <thead>
              <tr>{block.header.map((cell, cellIndex) => <th key={`${key}:h${cellIndex}`}>{renderInline(cell, `${key}:h${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}:r${rowIndex}`}>
                  {block.header.map((_, cellIndex) => (
                    <td key={`${key}:r${rowIndex}c${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `${key}:r${rowIndex}c${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
    default:
      return null;
  }
}

export function MarkdownBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const trimmed = text.trim();
  if (!trimmed) return <div class="md-body">{streaming ? "…" : ""}</div>;
  const blocks = parseBlocks(trimmed);
  return (
    <div class={`md-body ${streaming ? "is-streaming" : ""}`}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
      {streaming && <span class="md-caret" aria-hidden="true">▍</span>}
    </div>
  );
}
