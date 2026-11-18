// .kern file parser — validates .kern packages (which are zip files)
// and extracts manifest.json for preview.

/**
 * Expected structure inside a .kern zip:
 *   manifest.json  — required, must conform to ManifestSchema
 *   ui/            — optional UI bundle directory
 *   scripts/       — optional lifecycle scripts
 */
export interface KernManifest {
  id: string;
  displayName: string;
  version: string;
  author: string;
  description?: string;
  category?: string;
  tags?: string[];
  configSchema?: Record<string, unknown>[];
  repoUrl?: string;
  homepageUrl?: string;
}

export interface KernValidation {
  valid: boolean;
  manifest: KernManifest | null;
  error?: string;
  sha256?: string;
  sizeBytes?: number;
}

const REQUIRED_MANIFEST_FIELDS: (keyof KernManifest)[] = [
  "id",
  "displayName",
  "version",
  "author",
];

/**
 * Minimum valid manifest check (without Node.js zip lib).
 * In a real deployment, server-side validation uses `adm-zip` to
 * open the .kern zip, extract manifest.json, and parse it.
 *
 * This function does a basic field-level check on an already-parsed object.
 */
export function validateManifest(
  manifest: Record<string, unknown>,
): KernValidation {
  const m = manifest as unknown as KernManifest;

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!m[field] || typeof m[field] !== "string" || m[field].trim() === "") {
      return {
        valid: false,
        manifest: null,
        error: `manifest is missing required field: ${field}`,
      };
    }
  }

  // Validate author matches GitHub username pattern
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(m.author)) {
    return {
      valid: false,
      manifest: null,
      error: "author must be a valid GitHub username",
    };
  }

  // Validate semver-ish version
  if (!/^\d+\.\d+\.\d+/.test(m.version)) {
    return {
      valid: false,
      manifest: null,
      error: "version must be semver (e.g. 1.0.0)",
    };
  }

  return {
    valid: true,
    manifest: m,
  };
}

/**
 * Attempt to parse a manifest.json string.
 * Used after extracting the file from a .kern zip.
 */
export function parseManifestJson(
  jsonString: string,
): KernManifest | null {
  try {
    const parsed = JSON.parse(jsonString);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as KernManifest;
  } catch {
    return null;
  }
}

/**
 * Compute a rough estimate of semantic version precedence.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
