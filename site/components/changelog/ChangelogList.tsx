"use client";

import { useEffect, useRef, useState } from "react";
import type { Release } from "@/lib/github";
import { getReleasesPage } from "@/lib/github";
import { ReleaseCard } from "@/components/changelog/ReleaseCard";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  §9.1 — client-side infinite scroll. An IntersectionObserver watches a
  sentinel <div>; on intersect, fetch the next page via getReleasesPage and
  append. Stops when a page comes back empty. The first page is seeded from
  the server (getAllReleases at build time).
*/
export function ChangelogList({ initial }: { initial: Release[] }) {
  const [releases, setReleases] = useState<Release[]>(initial);
  const [page, setPage] = useState(2); // page 1 was the seed
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(initial.length === 0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Guard against concurrent fetches — the IntersectionObserver callback is
  // async, so multiple entries intersecting before React re-renders could
  // otherwise fire overlapping getReleasesPage calls with the same page.
  const fetchingRef = useRef(false);

  useEffect(() => {
    if (done) return;
    const el = sentinelRef.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting || done) return;
        if (fetchingRef.current) return;
        fetchingRef.current = true;
        setLoading(true);
        try {
          const next = await getReleasesPage(page);
          if (cancelled) return;
          if (next.length === 0) {
            setDone(true);
          } else {
            setReleases((prev) => [...prev, ...next]);
            setPage((p) => p + 1);
          }
        } catch {
          // Network error — user can scroll again to retry
        } finally {
          fetchingRef.current = false;
          if (!cancelled) setLoading(false);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [page, loading, done]);

  if (releases.length === 0) {
    return (
      <p className="font-mono text-xs lowercase text-signal-low">
        no releases published yet.
      </p>
    );
  }

  return (
    <div className="space-y-10">
      {releases.map((r) => (
        <ReleaseCard key={r.tag_name + r.published_at} release={r} />
      ))}

      <div ref={sentinelRef} className="h-8">
        {loading && !done && (
          <div className="flex items-center gap-2">
            <StatusDots status="breathe" label="loading more releases" count={4} />
            <span className="font-mono text-[11px] lowercase text-signal-low">
              fetching…
            </span>
          </div>
        )}
        {done && releases.length > 0 && (
          <p className="font-mono text-[11px] lowercase text-signal-low">
            end of feed.
          </p>
        )}
      </div>
    </div>
  );
}
