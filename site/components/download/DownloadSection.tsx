import Link from "next/link";
import type { Release } from "@/lib/github";
import { RELEASES_PAGE, formatBytes, getPlatforms } from "@/lib/github";
import { VersionBadge } from "@/components/download/VersionBadge";
import { MatrixDivider } from "@/components/ui/MatrixBorder";
import { Spotlight } from "@/components/ui/Spotlight";

const OS_GLYPH: Record<string, string> = {
  Windows: "⊞",
  macOS: "⌘",
  Linux: "⌥",
};

/*
  §4 download flow. Server component — awaits getRelease() at build time.
  Per-OS cards with filename/size/download btn. If a platform has no matched
  asset → "Not available yet" + releases fallback. If release is null entirely
  (API down at build) → a single link to the releases page. Never crashes.
*/
export function DownloadSection({ release }: { release: Release | null }) {
  return (
    <section id="download" className="relative mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <div className="mb-10 flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs lowercase text-signal-low">{"// "}download</p>
          <h2 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
            install kern
          </h2>
          <p className="mt-3 max-w-md font-mono text-xs text-signal-low">
            native desktop app. windows ships first; macos and linux as
            available. the app auto-updates itself — signed.
          </p>
        </div>
        {release && <VersionBadge tag={release.tag_name} />}
      </div>

      {release ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {getPlatforms(release).map((p) => (
            <Spotlight key={p.os}>
            <div
              className="flex flex-col gap-4 bg-bg-surface/60 p-5"
              style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm lowercase text-zinc-100">
                  <span className="mr-2 text-signal-high" aria-hidden="true">
                    {OS_GLYPH[p.os]}
                  </span>
                  {p.os}
                </h3>
                <span className="font-mono text-[10px] lowercase text-signal-low">
                  {p.hint}
                </span>
              </div>

              {p.asset ? (
                <>
                  <div className="matrix-border h-px w-full opacity-60" />
                  <div className="flex flex-col gap-1">
                    <span className="break-all font-mono text-[11px] text-signal-low">
                      {p.asset.name}
                    </span>
                    <span className="font-mono text-[11px] text-signal-low">
                      {formatBytes(p.asset.size)}
                    </span>
                  </div>
                  <a
                    href={p.asset.browser_download_url}
                    className="mt-auto inline-flex items-center justify-center bg-signal-high px-4 py-2.5 font-mono text-xs lowercase text-bg-core transition hover:brightness-110"
                  >
                    download
                  </a>
                </>
              ) : (
                <>
                  <div className="matrix-border h-px w-full opacity-60" />
                  <p className="font-mono text-xs lowercase text-signal-low">
                    not available yet
                  </p>
                  <Link
                    href={RELEASES_PAGE}
                    target="_blank"
                    className="mt-auto inline-flex items-center justify-center bg-bg-core px-4 py-2.5 font-mono text-xs lowercase text-zinc-300 ring-1 ring-grid-bounds transition hover:text-signal-high"
                  >
                    view releases
                  </Link>
                </>
              )}
            </div>
            </Spotlight>
          ))}
        </div>
      ) : (
        // §4.5 — release is null (API down at build). Degrade gracefully.
        <div className="bg-bg-surface/60 p-8 text-center" style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}>
          <p className="font-mono text-xs lowercase text-signal-low">
            no release asset data right now — the build couldn&rsquo;t reach github.
          </p>
          <a
            href={RELEASES_PAGE}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center bg-signal-high px-4 py-2.5 font-mono text-xs lowercase text-bg-core transition hover:brightness-110"
          >
            download from github
          </a>
        </div>
      )}

      <MatrixDivider className="mt-16" />
    </section>
  );
}
