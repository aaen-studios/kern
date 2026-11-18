---
title: ai agents
group: Using kern
slug: ai-agents
order: 19
description: install kern's docs as an agent skill so coding agents write plugins instead of guessing.
---

# ai agents

these docs are packaged as an **agent skill** — a folder of markdown an AI coding agent loads when the task touches kern. instead of scraping the site, your agent gets the manifest reference, lifecycle rules, kern-cli surface, and automation api as local files.

the skill lives in [skills/kern](https://github.com/ellipog/kern-web/tree/main/skills/kern) and its `references/` directory is generated from these same docs, so the two can't drift.

## install

with the skills cli (claude code, opencode, cursor, and ~70 more agents):

```bash
npx skills add ellipog/kern-web
```

or as an npm package (pinned, offline):

```bash
npm i -D @aaen-studios/kern
# the skill is at node_modules/@aaen-studios/kern/kern
```

or copy it into whichever directory your agent scans:

```bash
git clone --depth 1 https://github.com/ellipog/kern-web
cp -r kern-web/skills/kern .claude/skills/kern   # or .agents/skills/kern, .cursor/skills/kern, …
```

## paste this into your agent

don't want to install anything yourself? paste a one-liner and let the agent do it:

```text
install the kern agent skill by running: npx skills add ellipog/kern-web — then use that skill to help me build a .kern plugin.
```

## no install at all

agents that can fetch a url don't need the skill installed:

- [llms.txt](https://kern.aaenz.no/llms.txt) — an index of every doc for ai tooling
- [llms-full.txt](https://kern.aaenz.no/llms-full.txt) — the whole documentation in one response
- `/raw/docs/<slug>` — the author-written markdown, frontmatter included, e.g. `/raw/docs/manifest-reference`

## what the agent gets

- a `SKILL.md` router explaining when kern applies and which reference to read
- `references/manifest-reference` — the `.kern` package and `manifest.json` schema
- `references/lifecycle`, `references/config-schema`, `references/scaffold`, `references/plugin-ui` — plugin authoring
- `references/cli` and `references/automation-api` — controlling a running app
- plus every other page in these docs

> **note** the skill is a documentation bundle, not a tool. installing it grants your agent no new access — it just knows what to write.

## keeping it current

the npm package is versioned separately from the app; `npx skills update kern` (or reinstalling) picks up new docs. contributing? after editing any page here, run `npm run skill:build` so the bundled references regenerate, and `npm run skill:check` will fail the build if they're stale.
