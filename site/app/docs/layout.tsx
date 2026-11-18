import type { Metadata } from "next";
import { getDocNav, getSearchSections } from "@/lib/docs";
import { getRelease, formatVersion } from "@/lib/github";
import { DocSearch } from "@/components/docs/DocSearch";
import { AgentSkillMenu } from "@/components/docs/AgentSkillMenu";
import { DocNav } from "@/components/docs/DocNav";

export const metadata: Metadata = {
  title: "docs",
  description:
    "kern docs hub — getting started, plugin development, manifest reference, and architecture.",
};

export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nav = getDocNav();
  const allDocs = nav.flatMap((g) => g.docs);
  const sections = getSearchSections();
  // Build-time release fetch; null on failure so the layout never crashes.
  const release = await getRelease();
  const version = release?.tag_name ? formatVersion(release.tag_name) : null;

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-24 pt-24 sm:px-6">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_1fr]">
        {/* sidebar */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="mb-5">
            <DocSearch docs={allDocs} sections={sections} />
            {version && (
              <p className="mt-2 font-mono text-[10px] lowercase text-signal-low">
                docs for {version}
              </p>
            )}
          </div>
          <DocNav nav={nav} />
        </aside>

        {/* prose */}
        <div className="min-w-0">
          <div className="mb-4 flex justify-end">
            <AgentSkillMenu />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
