import { getAllReleases, getRelease } from "@/lib/github";
import { Hero } from "@/components/landing/Hero";
import { SignalRadarStrip } from "@/components/landing/SignalRadarStrip";
import { ScanDivider } from "@/components/ui/ScanDivider";
import { LazySections } from "@/components/landing/LazySections";

/*
  Landing page (§10). Server component — fetches release data at build time
  (revalidate: 3600 in lib/github.ts). Never crashes: getRelease() returns
  null and the download section degrades to a single releases link.

  Below-fold sections are lazy-loaded via the <LazySections /> client island
  — their JS bundles aren't sent until the user scrolls near them.
*/
export default async function Home() {
  const [release, releases] = await Promise.all([
    getRelease(),
    getAllReleases(),
  ]);

  return (
    <>
      {/* above-fold — always eager */}
      <Hero release={release} />
      <ScanDivider />
      <SignalRadarStrip />
      <ScanDivider />

      {/* below-fold — lazy-loaded client island */}
      <LazySections release={release} releases={releases} />
    </>
  );
}
