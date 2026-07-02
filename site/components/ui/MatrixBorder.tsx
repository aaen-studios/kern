import type { ReactNode } from "react";

/*
  Dotted-matrix boundary wrapper. Renders the matrix-border utility as a
  1px-tall dotted divider, or as a panel outline.

  mode="divider"  → a horizontal dotted line (section separator)
  mode="panel"    → a padded surface card with a faint dot-grid outline + glow
*/
export function MatrixDivider({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`matrix-border h-px w-full opacity-70 ${className}`}
    />
  );
}

export function MatrixPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative bg-bg-surface/60 ${className}`}
      style={{
        boxShadow:
          "inset 0 0 0 1px rgba(22,25,32,0.9), inset 0 0 0 4px rgba(5,5,6,0.6)",
      }}
    >
      {children}
    </div>
  );
}
