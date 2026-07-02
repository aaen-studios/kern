"use client";

import { useState } from "react";

export function ReportButton({
  pluginId,
  pluginName,
}: {
  pluginId: string;
  pluginName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const handleSubmit = async () => {
    if (!reason.trim()) return;
    setSending(true);

    try {
      const res = await fetch(`/api/plugins/${pluginId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      if (res.ok) {
        setSubmitted(true);
        setTimeout(() => {
          setOpen(false);
          setSubmitted(false);
          setReason("");
        }, 2500);
      }
    } catch (err) {
      console.error("Report failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 bg-bg-surface px-3 py-1.5 font-mono text-xs lowercase text-signal-low ring-1 ring-grid-bounds transition hover:text-fault-vector hover:ring-fault-vector/50"
        aria-label="report this plugin"
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
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
        report
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-core/80 backdrop-blur-sm">
          <div
            className="w-full max-w-md bg-bg-surface p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            {submitted ? (
              <div className="text-center">
                <p className="font-mono text-sm text-signal-high">
                  report submitted
                </p>
                <p className="mt-2 font-mono text-[11px] text-signal-low">
                  thank you — the team will review this plugin.
                </p>
              </div>
            ) : (
              <>
                <h3 className="font-mono text-sm lowercase text-zinc-100">
                  report plugin
                </h3>
                <p className="mt-1 font-mono text-[11px] text-signal-low">
                  reporting: <span className="text-zinc-300">{pluginName}</span>
                </p>

                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="why are you reporting this plugin?"
                  rows={4}
                  className="mt-4 w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
                />

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setOpen(false)}
                    className="px-3 py-1.5 font-mono text-xs lowercase text-signal-low transition hover:text-zinc-300"
                  >
                    cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={sending || !reason.trim()}
                    className="bg-fault-vector px-3 py-1.5 font-mono text-xs lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
                  >
                    {sending ? "sending…" : "submit report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
