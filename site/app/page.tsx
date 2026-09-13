import { getAllReleases, getRelease } from "@/lib/github";
import { Hero } from "@/components/landing/Hero";
import { SignalRadarStrip } from "@/components/landing/SignalRadarStrip";
import { ScanDivider } from "@/components/ui/ScanDivider";
import { LazySections } from "@/components/landing/LazySections";
import { FAQ_ITEMS } from "@/lib/faq";

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

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
        }}
      />

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
