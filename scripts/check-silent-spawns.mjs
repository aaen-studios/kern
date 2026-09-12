#!/usr/bin/env node
// Fails when a Rust source file spawns a subprocess without console
// suppression. kern is a Windows GUI app: any console-subsystem child spawned
// without CREATE_NO_WINDOW flashes a terminal window. All spawns must go
// through `process::silent_command` (or the installer's local equivalent), or
// carry an explicit suppression call / justification nearby.
//
// Allowed shapes:
//   1. silent_command("…")                     — the sanctioned constructor
//   2. a `suppress_window(&mut cmd)` call within a few lines of the spawn site
//   3. a `// silent-spawn-ok: <reason>` marker on one of those lines

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src-tauri/src", "installer/src"];
const WINDOW = 8;
const SPAWN_RE = /\b(?:Std)?Command::new\s*\(/;

for (const root of ROOTS) {
  if (!existsSync(root)) {
    console.error(`check-silent-spawns: ${root} not found — run from the repo root`);
    process.exit(1);
  }
}

function* rustFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* rustFiles(path);
    else if (path.endsWith(".rs")) yield path;
  }
}

let failures = 0;
let checked = 0;

for (const root of ROOTS) {
  for (const file of rustFiles(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!SPAWN_RE.test(line)) return;
      checked += 1;
      const lo = Math.max(0, i - WINDOW);
      const hi = Math.min(lines.length, i + WINDOW + 1);
      const around = lines.slice(lo, hi).join("\n");
      if (line.includes("silent_command(")) return;
      if (around.includes("suppress_window")) return;
      if (around.includes("silent-spawn-ok")) return;

      failures += 1;
      const rel = relative(process.cwd(), file).replaceAll("\\", "/");
      console.error(`${rel}:${i + 1}: subprocess spawn without console suppression`);
      console.error(`    ${line.trim()}`);
      console.error(
        "    use silent_command(...), call suppress_window(&mut cmd), or add `// silent-spawn-ok: <reason>`",
      );
    });
  }
}

if (failures > 0) {
  console.error(`\ncheck-silent-spawns: ${failures} offending spawn(s)`);
  process.exit(1);
}
console.log(
  `check-silent-spawns: ok (${checked} spawn site${checked === 1 ? "" : "s"} audited)`,
);
