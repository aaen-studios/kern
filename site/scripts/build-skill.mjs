#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
  Generates skills/kern/references/*.md from content/docs/*.md so the agent
  skill (@aaen-studios/kern) never drifts from the published docs.

  - strips frontmatter (the body already opens with a # title)
  - rewrites /docs/<slug> links to sibling reference files
  - fails on dangling doc links
  - --check: report drift instead of writing (used by prepublishOnly / CI)
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(root, "content", "docs");
const OUT_DIR = path.join(root, "skills", "kern", "references");
const CHECK = process.argv.includes("--check");

function stripFrontmatter(raw) {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

const SLUGS = new Set(
  fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, "")),
);

const LINK_RE = /\]\(\/docs\/([a-z0-9-]+)(#[^)]*)?\)/g;

function build() {
  const out = new Map();
  const dangling = [];

  for (const slug of [...SLUGS].sort()) {
    const raw = fs.readFileSync(path.join(DOCS_DIR, `${slug}.md`), "utf8");
    let body = stripFrontmatter(raw).replace(/\r\n/g, "\n").trimStart();

    body = body.replace(LINK_RE, (_m, target, anchor = "") => {
      if (!SLUGS.has(target)) dangling.push(`${slug} -> /docs/${target}`);
      return `](./${target}.md${anchor})`;
    });

    const header =
      `<!-- generated from content/docs/${slug}.md - edit the source in kern-web, then run: npm run skill:build -->\n\n`;
    out.set(`${slug}.md`, header + body.trimEnd() + "\n");
  }

  if (dangling.length) {
    console.error("dangling /docs links:\n  " + dangling.join("\n  "));
    process.exit(1);
  }
  return out;
}

function main() {
  const expected = build();

  if (CHECK) {
    const actual = fs.existsSync(OUT_DIR)
      ? fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".md"))
      : [];
    const problems = [];
    for (const [name, content] of expected) {
      const file = path.join(OUT_DIR, name);
      if (!fs.existsSync(file)) problems.push(`missing: ${name}`);
      else if (fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== content)
        problems.push(`stale:   ${name}`);
    }
    for (const name of actual) {
      if (!expected.has(name)) problems.push(`orphan:  ${name}`);
    }
    if (problems.length) {
      console.error(
        `skill references are out of date:\n  ${problems.join("\n  ")}\nrun: npm run skill:build`,
      );
      process.exit(1);
    }
    console.log(`skill references up to date (${expected.size} files)`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith(".md") && !expected.has(name)) {
      fs.unlinkSync(path.join(OUT_DIR, name));
    }
  }
  for (const [name, content] of expected) {
    const file = path.join(OUT_DIR, name);
    const current = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
      : null;
    if (current !== content) fs.writeFileSync(file, content);
  }
  console.log(`wrote ${expected.size} references to skills/kern/references`);
}

main();
