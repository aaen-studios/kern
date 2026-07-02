import { getAllReleases, getRelease } from "@/lib/github";
import { Hero } from "@/components/landing/Hero";
import { SignalRadarStrip } from "@/components/landing/SignalRadarStrip";
import { TerminalMock } from "@/components/landing/TerminalMock";
import { LifecycleMock } from "@/components/landing/LifecycleMock";
import { FileEditorMock } from "@/components/landing/FileEditorMock";
import { PluginCards } from "@/components/landing/PluginCards";
import { DownloadSection } from "@/components/download/DownloadSection";
import { MiniChangelog } from "@/components/landing/MiniChangelog";

/*
  Landing page (§10). Server component — fetches release data at build time
  (revalidate: 3600 in lib/github.ts). Never crashes: getRelease() returns
  null and the download section degrades to a single releases link.
*/
export default async function Home() {
  const [release, releases] = await Promise.all([
    getRelease(),
    getAllReleases(),
  ]);

  return (
    <>
      <Hero release={release} />
      <SignalRadarStrip />
      <TerminalMock />
      <LifecycleMock />
      <FileEditorMock />
      <PluginCards />

      {/* mini-changelog excerpt above the download cards */}
      <section className="mx-auto max-w-[1080px] px-4 py-12 sm:px-6">
        <MiniChangelog releases={releases} />
      </section>

      <DownloadSection release={release} />
    </>
  );
}
