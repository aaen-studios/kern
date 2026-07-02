import Link from "next/link";
import type { Metadata } from "next";
import { getDocNav } from "@/lib/docs";
import { DocSearch } from "@/components/docs/DocSearch";

export const metadata: Metadata = {
  title: "docs",
  description:
    "kern docs hub — getting started, plugin development, manifest reference, and architecture.",
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nav = getDocNav();
  const allDocs = nav.flatMap((g) => g.docs);

  return (
    <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-24 sm:px-6">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_1fr]">
        {/* sidebar */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="mb-5">
            <DocSearch docs={allDocs} />
          </div>
          <nav aria-label="docs">
            {nav.map((group) => (
              <div key={group.group} className="mb-5">
                <h2 className="mb-2 font-mono text-[11px] lowercase text-signal-low">
                  {group.group}
                </h2>
                <ul className="space-y-0.5">
                  {group.docs.map((d) => (
                    <li key={d.slug}>
                      <Link
                        href={`/docs/${d.slug}`}
                        className="block px-2 py-1 font-mono text-[11px] lowercase text-zinc-300 transition-colors hover:bg-bg-surface hover:text-signal-high"
                      >
                        {d.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* prose */}
        <div className="min-w-0 max-w-[820px]">{children}</div>
      </div>
    </div>
  );
}
