/** Bearer-token API client for the panel (same-origin `/api/*`). */

import { getToken, clearSession } from "./session";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiRaw(
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(opts.headers ?? {}),
  };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event("kern:unauthorized"));
    throw new ApiError(401, "not paired");
  }
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `http ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export async function pairDevice(
  code: string,
  device: string,
): Promise<{ token: string; user: unknown }> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device }),
  });
  const data = (await res.json()) as { token?: string; user?: unknown; error?: string };
  if (!res.ok || !data.token) {
    throw new ApiError(res.status, data.error ?? "pairing failed");
  }
  return { token: data.token, user: data.user };
}

export async function invitePreview(code: string): Promise<{
  name: string;
  role: string;
  expiresAt: number;
  valid: boolean;
} | null> {
  try {
    const res = await fetch(`/api/invite?code=${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    return (await res.json()) as {
      name: string;
      role: string;
      expiresAt: number;
      valid: boolean;
    };
  } catch {
    return null;
  }
}
