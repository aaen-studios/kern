import type { Metadata } from "next";
import { getAllReleases } from "@/lib/github";
import { ChangelogList } from "@/components/changelog/ChangelogList";
import { MatrixDivider } from "@/components/ui/MatrixBorder";

export const metadata: Metadata = {
  title: "changelog",
  description:
    "release history for kern — every version, pulled live from github releases.",
};

// §9.1 — server component seeds the first 5 releases at build time; the client
// ChangelogList implements infinite scroll for the rest.
export default async function ChangelogPage() {
  const releases = await getAllReleases();

  return (
    <main className="mx-auto max-w-[820px] px-4 pb-24 pt-28 sm:px-6">
      <header className="mb-10">
        <p className="font-mono text-xs lowercase text-signal-low">{"// "}changelog</p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
          latest.log
        </h1>
        <p className="mt-3 font-mono text-xs text-signal-low">
          every release, from{" "}
          <a
            href="https://github.com/ellipog/kern/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="text-signal-high underline underline-offset-2"
          >
            ellipog/kern
          </a>
          . scroll to load more.
        </p>
      </header>

      <MatrixDivider className="mb-10 opacity-60" />

      <ChangelogList initial={releases} />
    </main>
  );
}
