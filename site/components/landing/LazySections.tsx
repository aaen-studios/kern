"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { ScanDivider } from "@/components/ui/ScanDivider";
import type { Release } from "@/lib/github";

/*
  Client component that lazy-loads all below-fold landing sections.
  `ssr: false` is only valid in Client Components in Next.js 16 — so this
  wrapper exists solely to host the dynamic imports and their Suspense
  boundaries. Each section loads when the user scrolls near it.

  Props are forwarded from the server page (release data, etc.).
*/

const TerminalMock = dynamic(
  () => import("@/components/landing/TerminalMock").then((m) => m.TerminalMock),
  { ssr: false },
);
const LifecycleMock = dynamic(
  () => import("@/components/landing/LifecycleMock").then((m) => m.LifecycleMock),
  { ssr: false },
);
const FileEditorMock = dynamic(
  () => import("@/components/landing/FileEditorMock").then((m) => m.FileEditorMock),
  { ssr: false },
);
const PluginCards = dynamic(
  () => import("@/components/landing/PluginCards").then((m) => m.PluginCards),
  { ssr: false },
);
const DownloadSection = dynamic(
  () => import("@/components/download/DownloadSection").then((m) => m.DownloadSection),
  { ssr: false },
);
const MiniChangelog = dynamic(
  () => import("@/components/landing/MiniChangelog").then((m) => m.MiniChangelog),
  { ssr: false },
);

function SectionFallback({ height = "h-96" }: { height?: string }) {
  return <div className={`w-full ${height}`} aria-hidden="true" />;
}

export function LazySections({
  release,
  releases,
}: {
  release: Release | null;
  releases: Release[];
}) {
  return (
    <>
      <Suspense fallback={<SectionFallback height="h-[500px]" />}>
        <TerminalMock />
      </Suspense>
      <ScanDivider />
      <Suspense fallback={<SectionFallback height="h-[400px]" />}>
        <LifecycleMock />
      </Suspense>
      <ScanDivider />
      <Suspense fallback={<SectionFallback height="h-[400px]" />}>
        <FileEditorMock />
      </Suspense>
      <ScanDivider />
      <Suspense fallback={<SectionFallback height="h-[500px]" />}>
        <PluginCards />
      </Suspense>

      <section className="mx-auto max-w-[1080px] px-4 py-12 sm:px-6">
        <Suspense fallback={<SectionFallback height="h-48" />}>
          <MiniChangelog releases={releases} />
        </Suspense>
      </section>

      <Suspense fallback={<SectionFallback height="h-[400px]" />}>
        <DownloadSection release={release} />
      </Suspense>
    </>
  );
}
