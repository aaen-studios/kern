import Link from "next/link";
import type { ReactNode } from "react";

/*
  kern button — lowercase verb labels (§3.6).
  Variants are strictly semantic:
    primary   = signal-high (running/active/cta)
    secondary = bg-surface outlined (standby)
    ghost     = transparent (tertiary)
  No decorative colors.
*/
type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-mono lowercase tracking-tight " +
  "transition-colors duration-150 select-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "disabled:opacity-40 disabled:cursor-not-allowed";

const variants: Record<Variant, string> = {
  primary:
    "bg-signal-high text-bg-core hover:brightness-110 " +
    "shadow-[0_0_24px_-6px_rgba(76,245,160,0.5)]",
  secondary:
    "bg-bg-surface text-zinc-200 matrix-border hover:text-signal-high",
  ghost: "text-signal-low hover:text-signal-high",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-xs px-4 py-2",
  lg: "text-sm px-5 py-2.5",
};

type CommonProps = {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
};

// Anchor-ish button (used for external hrefs / downloads)
type ButtonAsLinkProps = CommonProps & {
  href: string;
  external?: boolean;
  onClick?: never;
  type?: never;
};

// Real <button>
type ButtonAsButtonProps = CommonProps & {
  href?: undefined;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
};

type ButtonProps = ButtonAsLinkProps | ButtonAsButtonProps;

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;

  if ("href" in rest && rest.href !== undefined) {
    const { href, external, ...linkRest } = rest as ButtonAsLinkProps;
    const isExternal = external ?? /^https?:\/\//.test(href);
    if (isExternal || href.startsWith("kern://")) {
      return (
        <a
          href={href}
          className={cls}
          {...(isExternal
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={cls} {...linkRest}>
        {children}
      </Link>
    );
  }

  const { onClick, type = "button", disabled } = rest as ButtonAsButtonProps;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
