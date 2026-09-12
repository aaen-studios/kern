// Pre-build hook (run from Tauri's beforeBuildCommand): puts skin.zip where
// the NSIS compiler will find it at build time, and mirrors the custom
// nsNiuniuSkin DLLs into Tauri's shared NSIS plugins cache so they resolve
// via `!addplugindir "${ADDITIONALPLUGINSPATH}"`.
//
// The DLLs live under nsis-skin/ in the repo (committed) and are only copied
// into the cache if missing — the cache is machine-global and may already be
// populated (e.g. from another project using the same skin engine).
//
// Run:  node scripts/prepare-nsis.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = join(__dirname, '..', 'src-tauri');
const SKIN_DIR = join(SRC_TAURI, 'windows', 'nsis-skin');
const SKIN_ZIP = join(SKIN_DIR, 'skin.zip');

const DLLS = ['nsNiuniuSkin.dll', 'BgWorker.dll', 'nsProcess.dll', 'nsis7zU.dll'];

// Pinned SHA-256 hashes of the committed NSIS plugin DLLs. These binaries run
// with user privileges inside every installer build, so we verify them before
// staging and refuse to build if the cache holds a different file. Update the
// hashes (and record why) when intentionally upgrading the skin engine.
const DLL_SHA256 = {
  'nsNiuniuSkin.dll': 'acf0a9f02f82e3f684cf90cd1fa3f587124cc2d1cf1d01f10017ceefe4892c76',
  'BgWorker.dll': '50f735ab8f3473423e6873d628150bbc0777be7b4f6405247cddf22bb00fb6be',
  'nsProcess.dll': '51da07da18a5486b11e0d51ebff77a3f2fcbb4d66b5665d212cc6bda480c4257',
  'nsis7zU.dll': 'e4ab3064f2e094910ae80104ef9d371ccb74ebbeeed592582cf099acd83f5fe9',
};

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Resolve Tauri's global NSIS plugins cache. On Windows this is
// %LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\. NSIS is a
// Windows-only target, so on other platforms we no-op the cache step.
function pluginsCacheDir() {
  if (platform() !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(local, 'tauri', 'NSIS', 'Plugins', 'x86-unicode', 'additional');
}

function ensureCacheDlls() {
  const cache = pluginsCacheDir();
  if (!cache) return;

  // Verify every source DLL against the pinned hash first.
  for (const dll of DLLS) {
    const src = join(SKIN_DIR, dll);
    if (!existsSync(src)) {
      console.error(`✗ Missing NSIS plugin DLL: ${src}`);
      process.exit(1);
    }
    const actual = sha256(src);
    if (actual !== DLL_SHA256[dll]) {
      console.error(
        `✗ ${dll} does not match its pinned SHA-256.\n` +
          `  expected: ${DLL_SHA256[dll]}\n` +
          `  actual:   ${actual}\n` +
          '  If this is an intentional upgrade, update DLL_SHA256 in scripts/prepare-nsis.mjs.'
      );
      process.exit(1);
    }
  }

  mkdirSync(cache, { recursive: true });
  for (const dll of DLLS) {
    const src = join(SKIN_DIR, dll);
    const dest = join(cache, dll);
    if (!existsSync(dest)) {
      copyFileSync(src, dest);
      console.log(`  mirrored ${dll} -> cache`);
      continue;
    }
    // A stale/poisoned cache entry would silently be compiled into the
    // installer; abort rather than trust it.
    const cached = sha256(dest);
    if (cached !== DLL_SHA256[dll]) {
      console.error(
        `✗ Cached ${dll} differs from the pinned hash — refusing to build.\n` +
          `  cache: ${dest}\n` +
          '  Delete that file and re-run the build.'
      );
      process.exit(1);
    }
  }
}

function main() {
  if (!existsSync(SKIN_ZIP)) {
    console.error(
      `✗ skin.zip not found at ${SKIN_ZIP}.\n` +
        '  Run `bun run installer:assets` first to generate the skin assets and zip.'
    );
    process.exit(1);
  }

  // Copy skin.zip into the NSIS build output dir. Tauri compiles the .nsi from
  // target/release/nsis/x64/, so relative `File` paths in installer.nsi
  // resolve from there.
  const targetNsis = join(SRC_TAURI, 'target', 'release', 'nsis', 'x64');
  mkdirSync(targetNsis, { recursive: true });
  copyFileSync(SKIN_ZIP, join(targetNsis, 'skin.zip'));
  console.log(`✓ Copied skin.zip -> ${join(targetNsis, 'skin.zip')}`);

  ensureCacheDlls();
  console.log('✓ NSIS preparation complete.');
}

main();
