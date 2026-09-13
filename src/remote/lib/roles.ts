import type { AuthUser } from "./types";

export type Scope = "view" | "control" | "admin";

/** Role → capability check (mirrors the backend's scope policy). */
export function can(user: AuthUser | null, scope: Scope): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "operator") return scope !== "admin";
  return scope === "view";
}

/** True when the user may act on a specific server. */
export function canServer(user: AuthUser | null, serverId: string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!user.servers || user.servers.length === 0) return true;
  return user.servers.includes("*") || user.servers.includes(serverId);
}
