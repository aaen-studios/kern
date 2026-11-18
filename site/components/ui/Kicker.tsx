import type { ReactNode } from "react";

/* The `// label` line above a heading. One definition, used everywhere. */
export function Kicker({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`font-mono text-xs lowercase text-signal-low ${className}`}>
      {"// "}
      {children}
    </p>
  );
}
