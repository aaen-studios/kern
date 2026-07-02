import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { StickyNav } from "@/components/layout/StickyNav";
import { Footer } from "@/components/layout/Footer";
import { BackToTop } from "@/components/layout/BackToTop";
import { AuthProvider } from "@/components/auth/AuthProvider";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://kern.aaenz.no"),
  title: {
    default: "kern - any server. one panel.",
    template: "%s · kern",
  },
  description:
    "kern turns any folder on your computer into a managed server instance — with a live terminal, telemetry, and graceful lifecycle. teach it new server types by installing plugins.",
  applicationName: "kern",
  keywords: [
    "kern",
    "server manager",
    "self-hosted",
    "tauri",
    "desktop server panel",
    "plugin system",
  ],
  authors: [{ name: "kern", url: "https://github.com/aaen-studios/kern" }],
  openGraph: {
    type: "website",
    url: "https://kern.aaenz.no",
    siteName: "kern",
    title: "kern - any server. one panel.",
    description:
      "a native desktop server manager. live terminal, per-process telemetry, graceful lifecycle, and a plugin system that teaches it how to run each kind of server.",
  },
  twitter: {
    card: "summary_large_image",
    title: "kern - any server. one panel.",
    description:
      "a native desktop server manager with a live terminal, telemetry, and plugins.",
  },
  robots: { index: true, follow: true },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "kern",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Windows, macOS, Linux",
  description:
    "Cross-platform desktop server manager built with Tauri. Live terminal, per-process telemetry, graceful lifecycle, and a plugin system.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: "https://kern.aaenz.no",
  downloadUrl: "https://github.com/aaen-studios/kern/releases/latest",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* skip link — first focusable element */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:bg-bg-surface focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:text-signal-high focus:ring-2 focus:ring-signal-high"
        >
          skip to content
        </a>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
        <AuthProvider>
          <StickyNav />
          <div id="main" className="flex-1">
            {children}
          </div>
        </AuthProvider>
        <Footer />
        <BackToTop />
      </body>
    </html>
  );
}
