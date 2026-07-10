"use client";

import { useSpotlight } from "@/hooks/useSpotlight";

/*
  Client wrapper that applies the cursor-reactive radar bloom to its
  children. Lets server components (PluginCards, ReleaseCard, etc.) gain the
  spotlight effect without themselves becoming client components.

  Renders a <div className="spotlight …">; pass extra classes via className.
*/
export function Spotlight({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const handlers = useSpotlight();
  return (
    <div className={`spotlight ${className}`} {...handlers}>
      {children}
    </div>
  );
}
