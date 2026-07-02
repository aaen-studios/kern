import type { ReactNode } from "react";

/*
  Zero-dependency markdown renderer (§9.3). GitHub release bodies and our
  authored docs only use a tiny subset. Handles:
    - triple-backtick fenced code blocks ```lang ... ```
    - ## / ### headings  (and # as h1)
    - unordered lists: lines starting with - or *
    - ordered lists: lines starting with N.
    - blockquotes: > note / > warn / > danger (callouts)
    - paragraphs
  Inline: `code`, **bold**, _italic_, [text](url).
  No react-markdown dependency — keeps the bundle lean and Turbopack happy.
*/

type InlineToken =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; v: string }
  | { t: "italic"; v: string }
  | { t: "link"; v: string; href: string };

// parse a single line into inline tokens
function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buf = "";

  const pushText = () => {
    if (buf) {
      tokens.push({ t: "text", v: buf });
      buf = "";
    }
  };

  while (i < line.length) {
    const rest = line.slice(i);

    // `code`
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      pushText();
      tokens.push({ t: "code", v: code[1] });
      i += code[0].length;
      continue;
    }
    // **bold**
    const bold = rest.match(/^\*\*([^*]+)\*\*/);
    if (bold) {
      pushText();
      tokens.push({ t: "bold", v: bold[1] });
      i += bold[0].length;
      continue;
    }
    // _italic_
    const italic = rest.match(/^_([^_]+)_/);
    if (italic) {
      pushText();
      tokens.push({ t: "italic", v: italic[1] });
      i += italic[0].length;
      continue;
    }
    // [text](url)
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (link) {
      pushText();
      tokens.push({ t: "link", v: link[1], href: link[2] });
      i += link[0].length;
      continue;
    }

    buf += line[i];
    i++;
  }
  pushText();
  return tokens;
}

function renderInline(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((tk, idx) => {
    switch (tk.t) {
      case "code":
        return (
          <code
            key={idx}
            className="rounded-sm bg-bg-surface px-1.5 py-0.5 font-mono text-[12px] text-signal-high"
          >
            {tk.v}
          </code>
        );
      case "bold":
        return (
          <strong key={idx} className="font-semibold text-zinc-100">
            {tk.v}
          </strong>
        );
      case "italic":
        return (
          <em key={idx} className="italic text-zinc-200">
            {tk.v}
          </em>
        );
      case "link":
        return (
          <a
            key={idx}
            href={tk.href}
            className="text-signal-high underline decoration-signal-high/40 underline-offset-2 hover:decoration-signal-high"
            {...(/^https?:\/\//.test(tk.href)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {tk.v}
          </a>
        );
      default:
        return <span key={idx}>{tk.v}</span>;
    }
  });
}

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; inline: InlineToken[] }
  | { type: "ul"; items: InlineToken[][] }
  | { type: "ol"; items: InlineToken[][] }
  | { type: "callout"; kind: "note" | "warn" | "danger"; items: InlineToken[][] }
  | { type: "quote"; items: InlineToken[][] }
  | { type: "para"; inline: InlineToken[] };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({
        type: "heading",
        level: h[1].length,
        inline: parseInline(h[2].trim()),
      });
      i++;
      continue;
    }

    // blockquote (callout or plain)
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const first = quoteLines[0] || "";
      const callout = first.match(/^\*\*(note|warn|danger)\*\*\s*(.*)$/i);
      if (callout) {
        const kind = callout[1].toLowerCase() as "note" | "warn" | "danger";
        const items = [callout[2], ...quoteLines.slice(1)]
          .filter((l) => l.trim().length > 0)
          .map((l) => parseInline(l.replace(/^[-*]\s+/, "")));
        blocks.push({ type: "callout", kind, items });
      } else {
        const items = quoteLines
          .filter((l) => l.trim().length > 0)
          .map((l) => parseInline(l.replace(/^[-*]\s+/, "")));
        blocks.push({ type: "quote", items });
      }
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: InlineToken[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*]\s+/, "")));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineToken[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph (gather consecutive non-empty, non-special lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", inline: parseInline(paraLines.join(" ")) });
  }

  return blocks;
}

const calloutStyles = {
  note: "ring-signal-low/30 bg-signal-low/5 text-zinc-300",
  warn: "ring-warn-vector/40 bg-warn-vector/5 text-zinc-200",
  danger: "ring-fault-vector/40 bg-fault-vector/5 text-zinc-200",
} as const;
const calloutLabel = {
  note: "note",
  warn: "warn",
  danger: "danger",
} as const;

export function Markdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);

  return (
    <div className="space-y-4 font-mono text-[13px] leading-relaxed text-zinc-300">
      {blocks.map((b, bi) => {
        switch (b.type) {
          case "code":
            return (
              <pre
                key={bi}
                className="overflow-x-auto bg-bg-core p-4 font-mono text-[12px] leading-relaxed text-zinc-200"
                style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
              >
                {b.lang && (
                  <div className="mb-2 font-mono text-[10px] lowercase text-signal-low">
                    {b.lang}
                  </div>
                )}
                <code>{b.content}</code>
              </pre>
            );
          case "heading": {
            const cls =
              b.level <= 1
                ? "mt-6 text-2xl text-zinc-100"
                : b.level === 2
                  ? "mt-6 text-xl text-zinc-100"
                  : b.level === 3
                    ? "mt-5 text-lg text-zinc-100"
                    : "mt-4 text-base text-zinc-200";
            const level = Math.min(b.level, 4) as 1 | 2 | 3 | 4;
            const inner = renderInline(b.inline);
            const heading =
              level === 1 ? (
                <h1>{inner}</h1>
              ) : level === 2 ? (
                <h2>{inner}</h2>
              ) : level === 3 ? (
                <h3>{inner}</h3>
              ) : (
                <h4>{inner}</h4>
              );
            return (
              <div key={bi} className={`font-mono lowercase ${cls}`}>
                {heading}
              </div>
            );
          }
          case "ul":
            return (
              <ul key={bi} className="space-y-1.5 pl-1">
                {b.items.map((it, ii) => (
                  <li key={ii} className="flex gap-2">
                    <span className="mt-0.5 text-signal-high" aria-hidden="true">
                      ·
                    </span>
                    <span>{renderInline(it)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={bi} className="space-y-1.5 pl-1">
                {b.items.map((it, ii) => (
                  <li key={ii} className="flex gap-2">
                    <span className="mt-0.5 text-signal-low">{ii + 1}.</span>
                    <span>{renderInline(it)}</span>
                  </li>
                ))}
              </ol>
            );
          case "callout":
            return (
              <div
                key={bi}
                className={`rounded-sm p-4 ring-1 ${calloutStyles[b.kind]}`}
              >
                <p className="mb-2 font-mono text-[11px] lowercase opacity-80">
                  {"// "}{calloutLabel[b.kind]}
                </p>
                <div className="space-y-1.5">
                  {b.items.map((it, ii) => (
                    <p key={ii}>{renderInline(it)}</p>
                  ))}
                </div>
              </div>
            );
          case "quote":
            return (
              <blockquote
                key={bi}
                className="border-l-2 border-grid-bounds pl-4 text-signal-low"
              >
                {b.items.map((it, ii) => (
                  <p key={ii}>{renderInline(it)}</p>
                ))}
              </blockquote>
            );
          case "para":
            return <p key={bi}>{renderInline(b.inline)}</p>;
          default:
            return null;
        }
      })}
    </div>
  );
}
