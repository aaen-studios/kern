---
title: distribution
group: Plugin development
slug: distribution
order: 8
description: how to publish a plugin to the registry.
---

# distribution

the registry has two phases. both are free to use.

## phase a — curated registry (ships first)

submission is a **pull request** to the `kern-registry` github repo. a github action:

1. unzips your `.kern`,
2. parses `manifest.json`,
3. checks `id` / `version` / schema,
4. uploads the blob to r2,
5. upserts a row in the d1 catalog.

curation = maintainers review the pr. official plugins (`kern/official`, `kern/sample`) get a `verified` badge. this path needs zero auth infra and gives an instant trust signal.

## phase b — open self-publish

publishers log in with **github oauth** and upload `.kern` files directly through the browser. the worker validates + writes to r2/d1, and the plugin goes live immediately (or after review). star ratings and reviews arrive in this phase.

phase a&rsquo;s pr path stays as the "verified/official" tier.

## the kern:// deep link

the website&rsquo;s "install in kern" buttons fire:

```
kern://install?url=<https-url-to-.kern>&id=<plugin-id>&v=<version>
```

if kern is installed, it opens and installs. if not, the site falls back to "download kern first".

> **danger** kern plugins run with full local privileges. only install plugins from authors you trust. surface author identity (github), check install counts and ratings, and read the readme before installing.
