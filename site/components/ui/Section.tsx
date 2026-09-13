import type { ReactNode } from "react";

/*
  Section — the one wrapper every landing section uses. Controls the
  rhythmic size (vertical breathing) and the content width, and optionally
  renders as a full-bleed band behind the centered content.
*/

type Size = "tight" | "default" | "air";
type Width = "content" | "wide" | "prose";

const sizes: Record<Size, string> = {
  tight: "py-16",
  default: "py-24",
  air: "py-32",
};

const widths: Record<Width, string> = {
  content: "max-w-[1080px]",
  wide: "max-w-[1280px]",
  prose: "max-w-[820px]",
};

export function Section({
  children,
  size = "default",
  width = "content",
  band = false,
  id,
  className = "",
}: {
  children: ReactNode;
  size?: Size;
  width?: Width;
  band?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`${band ? "bg-bg-surface/30 " : ""}${className}`}
    >
      <div
        className={`mx-auto w-full ${widths[width]} px-4 sm:px-6 ${sizes[size]}`}
      >
        {children}
      </div>
    </section>
  );
}
