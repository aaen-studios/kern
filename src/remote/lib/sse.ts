/** Server-sent events over fetch (EventSource can't send auth headers). */

import { useEffect, useRef, useState } from "react";
import { authHeaders, apiRaw } from "./api";

export type SseStatus = "connecting" | "live" | "offline";

interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Subscribes to one SSE endpoint and reconnects with backoff while `enabled`.
 * The handler is kept in a ref so callers don't need to memoize it.
 */
export function useSse(
  path: string | null,
  onEvent: (event: string, data: unknown) => void,
  enabled = true,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!path || !enabled) {
      setStatus("offline");
      return;
    }
    let stopped = false;
    const controller = new AbortController();

    const run = async () => {
      let attempt = 0;
      while (!stopped) {
        setStatus(attempt === 0 ? "connecting" : "offline");
        try {
          const res = await fetch(`/api${path}`, {
            headers: authHeaders(),
            signal: controller.signal,
          });
          if (res.status === 401) {
            window.dispatchEvent(new Event("kern:unauthorized"));
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          attempt = 0;
          setStatus("live");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep = buffer.indexOf("\n\n");
            while (sep >= 0) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const parsed: SseFrame = { event: "message", data: null };
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
                else if (line.startsWith("data:")) {
                  const raw = line.slice(5).trim();
                  try {
                    parsed.data = JSON.parse(raw);
                  } catch {
                    parsed.data = raw;
                  }
                }
              }
              if (parsed.data !== null) handlerRef.current(parsed.event, parsed.data);
              sep = buffer.indexOf("\n\n");
            }
          }
        } catch (err) {
          if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        }
        if (stopped) return;
        setStatus("offline");
        attempt += 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };

    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [path, enabled]);

  return status;
}

/** Downloads a remote file through the authenticated download endpoint. */
export async function downloadInstanceFile(
  serverId: string,
  relPath: string,
  fallbackName?: string,
): Promise<void> {
  const res = await apiRaw(
    `/servers/${encodeURIComponent(serverId)}/download?path=${encodeURIComponent(relPath)}`,
  );
  if (!res.ok) throw new Error("download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fallbackName ?? relPath.split("/").pop() ?? "download";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
