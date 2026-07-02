"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Plugin } from "@/lib/registry";
import { formatRelativeTime } from "@/lib/registry";
import { createClient } from "@/lib/supabase";
import { StatusDots } from "@/components/ui/StatusDots";

export function MyPluginTable() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setLoading(false);
          return;
        }

        // Fetch user's profile first
        const { data: profile } = await supabase
          .from("profiles")
          .select("github_user")
          .eq("id", user.id)
          .single();

        if (profile) {
          const res = await fetch(`/api/plugins?author=${profile.github_user}`);
          if (res.ok) {
            const data = await res.json();
            setPlugins(data);
          }
        }
      } catch (err) {
        console.error("Failed to load plugins:", err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-20">
        <StatusDots status="breathe" label="loading" count={4} />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="font-mono text-sm text-signal-low">
          you haven&apos;t published any plugins yet.
        </p>
        <Link
          href="/plugins/submit"
          className="bg-signal-high px-4 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110"
        >
          submit your first plugin
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-grid-bounds/60 text-left">
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">plugin</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">category</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">versions</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">upvotes</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">updated</th>
            <th className="py-2 font-mono text-[11px] lowercase text-signal-low"></th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr
              key={p.id}
              className="border-b border-grid-bounds/30 text-zinc-200"
            >
              <td className="py-3 pr-4">
                <Link
                  href={`/plugins/${p.id}`}
                  className="font-mono text-xs text-signal-high hover:brightness-125"
                >
                  {p.display_name}
                </Link>
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {p.category}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {p.versions.length}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {p.rating_sum}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {formatRelativeTime(p.updated_at)}
              </td>
              <td className="py-3">
                <Link
                  href={`/plugins/${p.id}/edit`}
                  className="font-mono text-[11px] lowercase text-signal-high transition hover:brightness-125"
                >
                  edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
