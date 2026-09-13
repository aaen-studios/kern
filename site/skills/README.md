# @aaen-studios/kern

the kern documentation, packaged as an [agent skill](https://skills.sh) so coding agents (claude code, opencode, cursor, codex, …) can build kern plugins and script `kern-cli` without scraping the site.

## install

with the skills cli — recommended:

```bash
npx skills add ellipog/kern-web
```

or as an npm package (pinned / offline):

```bash
npm i -D @aaen-studios/kern
# skill lives at node_modules/@aaen-studios/kern/kern/SKILL.md
```

point your agent at that directory (or copy it into `.claude/skills/kern`, `.agents/skills/kern`, …) if it doesn't discover it automatically.

## contents

| file | what it is |
|---|---|
| `kern/SKILL.md` | router — when to use the skill and which reference to read |
| `kern/references/` | the published docs from [kern.aaenz.no/docs](https://kern.aaenz.no/docs) |

`references/` is generated from the site's markdown (`content/docs/`) by `scripts/build-skill.mjs` in the [kern-web](https://github.com/ellipog/kern-web) repo — don't edit it here; fix the source and republish.

## links

- docs: <https://kern.aaenz.no/docs>
- site for agents: <https://kern.aaenz.no/llms.txt>
- kern app: <https://github.com/aaen-studios/kern>
