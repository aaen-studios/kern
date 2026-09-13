import type { ReactNode } from "react";

/*
  Panel — surfaces in the elevation ladder (utility recipes in globals.css).
    flat   = default content panel, same material as bg-core
    raised = interactive/selected, lifts off the page
    glow   = one focal panel per view
*/

type Variant = "flat" | "raised" | "glow";

const variants: Record<Variant, string> = {
  flat: "panel-flat",
  raised: "panel-raised",
  glow: "panel-glow",
};

export function Panel({
  children,
  variant = "flat",
  className = "",
}: {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <div className={`${variants[variant]} ${className}`}>{children}</div>
  );
}
