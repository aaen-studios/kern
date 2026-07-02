"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

const VOTER_ID_KEY = "kern_voter_id";

function getVoterId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(VOTER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(VOTER_ID_KEY, id);
  }
  return id;
}

export function UpvoteButton({
  pluginId,
  initialUpvotes,
}: {
  pluginId: string;
  initialUpvotes: number;
}) {
  const [upvoted, setUpvoted] = useState(false);
  const [count, setCount] = useState(initialUpvotes);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Check if user has already upvoted
    const voterId = getVoterId();
    if (!voterId) return;

    fetch(`/api/plugins/${pluginId}/upvote?vid=${voterId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.upvoted) setUpvoted(true);
      })
      .catch(() => {});
  }, [pluginId]);

  const handleToggle = async () => {
    if (loading) return;
    setLoading(true);

    const voterId = getVoterId();

    try {
      const res = await fetch(`/api/plugins/${pluginId}/upvote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voter_id: voterId }),
      });

      if (res.ok) {
        const data = await res.json();
        setUpvoted(data.upvoted);
        setCount((c) => (data.upvoted ? c + 1 : c - 1));
      }
    } catch (err) {
      console.error("Upvote failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs lowercase ring-1 transition ${
        upvoted
          ? "bg-signal-high/10 text-signal-high ring-signal-high/40"
          : "bg-bg-surface text-zinc-300 ring-grid-bounds hover:text-signal-high hover:ring-signal-high/50"
      }`}
      aria-label={upvoted ? "remove upvote" : "upvote"}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
      </svg>
      <span>{count}</span>
    </button>
  );
}
