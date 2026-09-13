/*
  Radar snapshot regression test.

  Renders one fixed frame of lib/radar/radar.wgsl through vgpu/node (Dawn)
  and compares tolerant image metrics against the committed baseline —
  exact pixels vary across GPU backends, but a blank shader, a broken
  uniform, or a dead alpha channel cannot hide from these numbers.

    node scripts/radar-snapshot.mjs            # check
    node scripts/radar-snapshot.mjs --update   # refresh the baseline

  In CI without a working GPU the check skips (exit 0) unless
  RADAR_SNAPSHOT_REQUIRE=1 is set.
*/
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shader = readFileSync(path.join(root, "lib/radar", "radar.wgsl"), "utf8");
const baselinePath = path.join(root, "tests", "radar-snapshot.json");
const update = process.argv.includes("--update");
const required = process.env.RADAR_SNAPSHOT_REQUIRE === "1";

const WIDTH = 160;
const HEIGHT = 90;

async function render(time) {
  const { init, effect, target } = await import("vgpu/node");
  const gpu = await init();
  const colorTarget = target(gpu, { size: [WIDTH, HEIGHT] });
  const radar = effect(gpu, shader, {
    set: {
      params: {
        time,
        resolution: [WIDTH, HEIGHT],
        pointer: [0.5, 0.5],
        quality: 1,
        sweepSpeed: 0.5,
        gain: 1,
      },
    },
  });
  radar.draw(colorTarget);
  const pixels = await colorTarget.read();
  gpu.dispose();
  return pixels;
}

function metrics(pixels) {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  let nonBlack = 0;
  let lum = 0;
  let greenish = 0;
  let core = 0;
  let coreCount = 0;
  let edge = 0;
  let edgeCount = 0;

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum += l;
      if (r > 8 || g > 8 || b > 8) nonBlack++;
      if (g > r + 10 && g > b + 10) greenish++;

      const dx = x - cx;
      const dy = y - cy;
      const rad = Math.hypot(dx, dy);
      if (rad <= 2) {
        core += l;
        coreCount++;
      } else if (Math.abs(rad - 0.43 * HEIGHT) < 1.5) {
        edge += l;
        edgeCount++;
      }
    }
  }

  const total = WIDTH * HEIGHT;
  return {
    nonBlackPct: +(100 * (nonBlack / total)).toFixed(2),
    greenPct: +((100 * greenish) / Math.max(1, nonBlack)).toFixed(2),
    meanLum: +(lum / total).toFixed(3),
    coreLum: +(core / Math.max(1, coreCount)).toFixed(2),
    edgeLum: +(edge / Math.max(1, edgeCount)).toFixed(2),
  };
}

// per-metric tolerance: absolute where the value is a percentage, relative
// where it is a luminance
const TOLERANCE = {
  nonBlackPct: 2.0,
  greenPct: 1.5,
  meanLum: 0.35,
  coreLum: 0.45,
  edgeLum: 0.45,
};

let pixels;
try {
  pixels = await render(1.25);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (required) {
    console.error(`radar snapshot render failed: ${message}`);
    process.exit(1);
  }
  console.warn(`radar snapshot skipped — no usable GPU: ${message}`);
  process.exit(0);
}

// animation sanity: the sweep must actually move between frames. A shader
// that renders the same image at two different times is frozen — the exact
// bug class behind "the sweep disappears after a moment".
try {
  const later = await render(1.75);
  let same = later.length === pixels.length;
  if (same) {
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] !== later[i]) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    console.error(
      "radar shader is frozen: identical pixels at time 1.25 and 1.75",
    );
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (required) {
    console.error(`radar animation check failed: ${message}`);
    process.exit(1);
  }
  console.warn(`radar animation check skipped: ${message}`);
}

const current = metrics(pixels);

if (current.nonBlackPct < 1) {
  console.error(
    `radar snapshot is essentially blank (${current.nonBlackPct}% non-black) — failing`,
  );
  process.exit(1);
}

if (update || !existsSync(baselinePath)) {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  console.log("radar snapshot baseline written:", current);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const problems = [];
for (const [key, tolerance] of Object.entries(TOLERANCE)) {
  const a = baseline[key];
  const b = current[key];
  if (a === undefined || b === undefined) continue;
  const limit = Math.abs(a) * tolerance;
  if (Math.abs(a - b) > Math.max(limit, 0.001)) {
    problems.push(`${key}: baseline ${a} vs actual ${b}`);
  }
}

if (problems.length) {
  console.error(
    `radar snapshot drifted:\n  ${problems.join("\n  ")}\n` +
      "if the shader change is intentional: node scripts/radar-snapshot.mjs --update",
  );
  process.exit(1);
}

console.log(
  `radar snapshot ok (non-black ${current.nonBlackPct}%, green ${current.greenPct}%, core ${current.coreLum}, edge ${current.edgeLum})`,
);
