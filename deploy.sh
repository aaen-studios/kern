#!/usr/bin/env bash
set -eu

# ─── kern deploy script ────────────────────────────────────────────────
# Usage:  ./deploy.sh [new_version]
# Example: ./deploy.sh 0.2.0
#
# Works on: Windows (Git Bash/MSYS2), Linux, macOS
# Does:
#   1. Bumps version in package.json, tauri.conf.json, Cargo.toml
#   2. Builds the Tauri app
#   3. Creates the compressed archive needed for updater signing
#   4. Signs the archive and generates update.json
# ─────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── Load .env for signing credentials ────────────────────────────────
# Parsed line-by-line (not `export $(... | xargs)`) so values containing
# spaces, quotes, or `#` survive intact.
if [ -f src-tauri/.env ]; then
  set +u
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -z "$key" ] && continue
    export "$key=$value"
  done < src-tauri/.env
  set -u
  echo "✓ Loaded .env"
fi

KEY_PATH="${UPDATER_PRIVATE_KEY_PATH:-src-tauri/updater.key}"
if [ ! -f "$KEY_PATH" ]; then
  echo "! Private key not found at $KEY_PATH" >&2
  exit 1
fi

# ── Version ──────────────────────────────────────────────────────────
# Read the current version from each source-of-truth file independently.
PKG_VERSION="$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')"
CONF_VERSION="$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')"
CARGO_VERSION="$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/^version = "\(.*\)"/\1/')"

if [ -n "${1:-}" ]; then
  # Explicit version argument wins — bump all three files to it.
  VERSION="$1"
  if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
    echo "! '$VERSION' is not valid semver (expected MAJOR.MINOR.PATCH)" >&2
    exit 1
  fi
  # Refuse accidental downgrades — the updater treats versions monotonicly.
  version_lt() {
    [ "$1" = "$2" ] && return 1
    local IFS=.
    local -a a=($1) b=($2)
    local i ai bi
    for i in 0 1 2; do
      ai="${a[$i]:-0}"; ai="${ai%%[-+]*}"
      bi="${b[$i]:-0}"; bi="${bi%%[-+]*}"
      [ "${ai:-0}" -lt "${bi:-0}" ] 2>/dev/null && return 0
      [ "${ai:-0}" -gt "${bi:-0}" ] 2>/dev/null && return 1
    done
    return 1
  }
  if version_lt "$VERSION" "$CONF_VERSION"; then
    echo "! refusing to downgrade from $CONF_VERSION to $VERSION" >&2
    exit 1
  fi
  echo "⟳ Bumping version → $VERSION"
  sed -i.bak "s/\"version\": \"$PKG_VERSION\"/\"version\": \"$VERSION\"/" package.json
  sed -i.bak "s/\"version\": \"$CONF_VERSION\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
  sed -i.bak "s/^version = \"$CARGO_VERSION\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
  rm -f package.json.bak src-tauri/tauri.conf.json.bak src-tauri/Cargo.toml.bak
else
  # No argument: all three files must agree, else refuse to proceed.
  if [ "$PKG_VERSION" != "$CONF_VERSION" ] || [ "$CONF_VERSION" != "$CARGO_VERSION" ]; then
    echo "! Version mismatch detected:" >&2
    echo "    package.json:      $PKG_VERSION" >&2
    echo "    tauri.conf.json:   $CONF_VERSION" >&2
    echo "    Cargo.toml:        $CARGO_VERSION" >&2
    echo "  Pass an explicit version to resync, e.g. ./deploy.sh 0.3.2" >&2
    exit 1
  fi
  VERSION="$CONF_VERSION"
  echo "✓ Version: $VERSION"
fi

# Confirm version actually changed in the files
CONFIRMED="$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')"
echo "  (tauri.conf.json version: $CONFIRMED)"

# Remove stale installers from prior runs so the new build can't be confused
rm -f src-tauri/target/release/bundle/nsis/*.exe
rm -f src-tauri/target/release/bundle/nsis/*.exe.zip

# ── Platform detection ──────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    PLATFORM="linux"
    BIN_EXT=""
    UPDATE_KEY="${ARCH}-linux"
    [ "$ARCH" = "x86_64" ] && UPDATE_KEY="linux-x86_64"
    [ "$ARCH" = "aarch64" ] && UPDATE_KEY="linux-aarch64"
    ;;
  Darwin)
    PLATFORM="macos"
    BIN_EXT=""
    [ "$ARCH" = "arm64" ] && UPDATE_KEY="darwin-aarch64" || UPDATE_KEY="darwin-x86_64"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="windows"
    BIN_EXT=".exe"
    UPDATE_KEY="windows-x86_64"
    ;;
  *)
    echo "Unsupported OS: $OS"; exit 1 ;;
esac

echo "⟳ Platform: $PLATFORM ($ARCH)"

# Pick a python interpreter for the archive/merge steps below.
if command -v python3 &>/dev/null; then
  PY=python3
else
  PY=python
fi

# ── Build ───────────────────────────────────────────────────────────
# KERN_CUSTOM_INSTALLER=1 uses the standalone installer app (installer/)
# instead of the skinned NSIS bundle. Both produce the same updater artifact
# shape (an .exe zipped + minisign-signed) and both honor /P and /R.
if [ "${KERN_CUSTOM_INSTALLER:-0}" = "1" ]; then
  echo "⟳ Building kern v$VERSION + standalone installer ..."
  bun install --frozen-lockfile
  node scripts/build-installer.mjs
else
  echo "⟳ Building kern v$VERSION ..."
  bun install --frozen-lockfile
  # TAURI_BUNDLES optionally narrows which bundles to build (e.g. "appimage"
  # on CI where the rpm toolchain isn't installed).
  if [ -n "${TAURI_BUNDLES:-}" ]; then
    bun tauri build --bundles "$TAURI_BUNDLES"
  else
    bun tauri build
  fi
fi
echo "✓ Build complete."

# ── Locate artifacts & create archive ─────────────────────────────────
echo "  Checking for artifacts in src-tauri/target/release/bundle/ ..."
ls -la src-tauri/target/release/bundle/ 2>/dev/null || echo "  (no bundle dir yet)"
case "$PLATFORM" in
  windows)
    if [ "${KERN_CUSTOM_INSTALLER:-0}" = "1" ]; then
      INSTALLER="installer/target/release/kern-setup.exe"
      if [ ! -f "$INSTALLER" ]; then
        echo "! Standalone installer not found at $INSTALLER."
        exit 1
      fi
    else
      BUNDLE_DIR="src-tauri/target/release/bundle/nsis"
      INSTALLER=""
      for f in "$BUNDLE_DIR"/*.exe; do
        [ -f "$f" ] && INSTALLER="$f" && break
      done
      if [ -z "$INSTALLER" ]; then
        echo "! No .exe found in $BUNDLE_DIR/ — check build output."
        exit 1
      fi
    fi
    ARCHIVE="${INSTALLER}.zip"
    echo "⟳ Creating $ARCHIVE ..."
    rm -f "$ARCHIVE"
    $PY -c "
import zipfile, os, sys
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(sys.argv[2], os.path.basename(sys.argv[2]))
" "$ARCHIVE" "$INSTALLER"
    ;;
  linux)
    BUNDLE_DIR="src-tauri/target/release/bundle/appimage"
    INSTALLER=""
    for f in "$BUNDLE_DIR"/*.AppImage; do
      [ -f "$f" ] && INSTALLER="$f" && break
    done
    if [ -z "$INSTALLER" ]; then
      BUNDLE_DIR="src-tauri/target/release/bundle/deb"
      for f in "$BUNDLE_DIR"/*.deb; do
        [ -f "$f" ] && INSTALLER="$f" && break
      done
    fi
    if [ -z "$INSTALLER" ]; then
      echo "! No installer found in appimage/ or deb/ — check build output."
      exit 1
    fi
    ARCHIVE="${INSTALLER}.tar.gz"
    echo "⟳ Creating $ARCHIVE ..."
    rm -f "$ARCHIVE"
    tar czf "$ARCHIVE" -C "$(dirname "$INSTALLER")" "$(basename "$INSTALLER")"
    ;;
  macos)
    BUNDLE_DIR="src-tauri/target/release/bundle/dmg"
    INSTALLER=""
    for f in "$BUNDLE_DIR"/*.dmg; do
      [ -f "$f" ] && INSTALLER="$f" && break
    done
    # The updater needs a `.app.tar.gz` (it swaps the .app bundle); a dmg is
    # only the human-facing installer. Build the tarball from the bundle.
    APP_DIR="src-tauri/target/release/bundle/macos"
    if [ -d "$APP_DIR/kern.app" ]; then
      ARCHIVE="$APP_DIR/kern.app.tar.gz"
      echo "⟳ Creating $ARCHIVE ..."
      rm -f "$ARCHIVE"
      tar czf "$ARCHIVE" -C "$APP_DIR" kern.app
    elif [ -n "$INSTALLER" ]; then
      # Fallback: no .app bundle (older Tauri output) — gzip the dmg.
      ARCHIVE="${INSTALLER}.gz"
      echo "⟳ Creating $ARCHIVE ..."
      rm -f "$ARCHIVE"
      gzip -c "$INSTALLER" > "$ARCHIVE"
    else
      for f in "$APP_DIR"/*.app.tar.gz; do
        [ -f "$f" ] && ARCHIVE="$f" && break
      done
    fi
    if [ -z "${INSTALLER:-}" ]; then
      echo "! No .dmg or .app found — check build output."
      exit 1
    fi
    ;;
esac

if [ -z "${INSTALLER:-}" ] || [ ! -f "$INSTALLER" ]; then
  echo "! No build artifact found in $BUNDLE_DIR"
  echo "  Check src-tauri/target/release/bundle/ manually."
  exit 1
fi

if [ -z "${ARCHIVE:-}" ] || [ ! -f "$ARCHIVE" ]; then
  echo "! No updater archive was produced — check the build output above."
  exit 1
fi

echo "  Installer: $INSTALLER"
echo "  Archive:   $ARCHIVE"

# Verify archive exists
if [ -f "$ARCHIVE" ]; then
  echo "✓ Archive created: $(du -h "$ARCHIVE" | cut -f1)"
else
  echo "! Archive NOT created at $ARCHIVE"
  echo "  Retrying with Python zipfile..."
  $PY -c "
import zipfile, os, sys
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(sys.argv[2], os.path.basename(sys.argv[2]))
" "$ARCHIVE" "$INSTALLER"
  if [ -f "$ARCHIVE" ]; then
    echo "✓ Created successfully."
  else
    echo "! Still failed. Run this manually after the script:"
    echo "  $PY -c \"import zipfile,os,sys; zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED).write(sys.argv[2],os.path.basename(sys.argv[2]))\" \"$ARCHIVE\" \"$INSTALLER\""
  fi
fi

# ── Sign ────────────────────────────────────────────────────────────
echo ""
echo "⟳ Signing archive..."
# Pass the password explicitly (even when empty) so the signer can never fall
# back to an interactive prompt — in CI there is no TTY, and a prompt would
# hang forever instead of failing. `UPDATER_PRIVATE_KEY_PASSWORD` comes from
# src-tauri/.env (or the environment).
TAURI_BIN="./node_modules/.bin/tauri"
if [ ! -x "$TAURI_BIN" ]; then
  TAURI_BIN="bun run tauri"
fi
SIGNATURE="$($TAURI_BIN signer sign \
  --private-key-path "$KEY_PATH" \
  --password "${UPDATER_PRIVATE_KEY_PASSWORD:-}" \
  "$ARCHIVE" < /dev/null 2>&1 || true)"

# Extract just the signature line (starts with dW50cn... or RW...)
SIGNATURE="$(echo "$SIGNATURE" | tr -d '\r' | grep -E '^(dW50cn|RW)' | head -1 | xargs)"

if [ -z "$SIGNATURE" ]; then
  echo "! Failed to extract signature from output:" >&2
  echo "$SIGNATURE" >&2
  exit 1
fi
echo "✓ Signature captured"

# Verify signature was for the correct file
ARCHIVE_NAME="$(basename "$ARCHIVE")"
SIG_DECODED="$($PY -c "import base64,sys; print(base64.b64decode(sys.argv[1]).decode())" "$SIGNATURE" 2>/dev/null || \
               python -c "import base64,sys; print(base64.b64decode(sys.argv[1]).decode())" "$SIGNATURE" 2>/dev/null || true)"
SIGNED_FILE="$(echo "$SIG_DECODED" | sed -n 's/.*file:\(.*\)/\1/p')"
if [ -z "$SIGNED_FILE" ]; then
  echo "! Could not read filename from signature trusted comment" >&2
  exit 1
fi
if [ "$SIGNED_FILE" != "$ARCHIVE_NAME" ]; then
  echo "! Signature was for wrong file: '$SIGNED_FILE'" >&2
  echo "  Expected: '$ARCHIVE_NAME'" >&2
  echo "  The version in tauri.conf.json may have changed after signing." >&2
  exit 1
fi
echo "✓ Signature verified for: $SIGNED_FILE"

# ── Generate update.json ───────────────────────────────────────────
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > update.json <<JSON
{
  "version": "$VERSION",
  "notes": "See https://github.com/aaen-studios/kern/releases/tag/v$VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "$UPDATE_KEY": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/aaen-studios/kern/releases/download/v$VERSION/$ARCHIVE_NAME"
    }
  }
}
JSON

echo "✓ update.json generated"

# ── Multi-platform update.json merging ─────────────────────────────
if [ -f update.json.prev ]; then
  echo "⟳ Merging with previous update.json ..."
  $PY -c "
import json, sys
prev = json.load(open('update.json.prev'))
curr = json.load(open('update.json'))
if prev.get('version') == curr['version']:
    platforms = {**prev.get('platforms', {}), **curr['platforms']}
else:
    # Never carry platform entries from a previous version: clients would be
    # told vNEW exists but download the vOLD artifact.
    platforms = curr['platforms']
    if prev.get('platforms'):
        print(f'  previous manifest was v{prev.get(\"version\")} — starting a fresh platform set')
merged = {
  'version': curr['version'],
  'notes': curr['notes'],
  'pub_date': curr['pub_date'],
  'platforms': platforms
}
json.dump(merged, open('update.json', 'w'), indent=2)
print('Merged platforms:', list(merged['platforms'].keys()))
"
fi

cp update.json update.json.prev

# ── Stage release assets ────────────────────────────────────────────
# Collect everything a release needs into one directory with stable names:
#   release-assets/<installer>          (human download)
#   release-assets/<archive>            (updater artifact)
#   release-assets/update-<platform>.json (per-platform manifest fragment)
# The release workflow uploads these and merges the fragments into update.json;
# local users can upload the files to a GitHub release manually.
mkdir -p release-assets
rm -f release-assets/*
cp "$INSTALLER" release-assets/
cp "$ARCHIVE" release-assets/
# Ship the CLI standalone too (it's embedded in the Windows installer payload,
# but Linux/macOS users get it as a release asset).
for cli in src-tauri/target/release/kern-cli.exe src-tauri/target/release/kern-cli; do
  if [ -f "$cli" ]; then
    cp "$cli" release-assets/
    break
  fi
done
cp update.json "release-assets/update-$PLATFORM.json"
echo "✓ Release assets staged in release-assets/"
ls -la release-assets/

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  kern v$VERSION · $PLATFORM ($ARCH)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Release assets ready in release-assets/:"
echo "    • $(basename "$INSTALLER")"
echo "    • $(basename "$ARCHIVE")"
echo "    • update-$PLATFORM.json (fragment for the merged update.json)"
echo ""
echo "  Automated: push a v$VERSION tag — GitHub Actions builds every"
echo "  platform, merges the fragments, and creates the release."
echo ""
echo "  Manual alternative — upload to the GitHub release tag v$VERSION:"
echo "    • $INSTALLER"
echo "    • $ARCHIVE"
echo "    • update.json (merged across platforms)"
echo ""
echo "  To add another platform locally, run on that platform:"
echo "    ./deploy.sh $VERSION"
echo "  (it will merge into update.json automatically)"
echo ""
