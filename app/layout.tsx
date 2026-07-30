import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { GoogleAnalytics } from "@next/third-parties/google";
import { isElectron } from "@/lib/platform";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const title = "Rescript — edit videos like you edit text";
const description =
  "A fully offline, open-source transcript-based video editor. Transcribe with Whisper, cut by deleting words, export with ffmpeg — on your device.";

export const metadata: Metadata = {
  metadataBase: new URL("https://wassgha.github.io"),
  title,
  description,
  openGraph: {
    type: "website",
    siteName: "Rescript",
    url: `${basePath}/`,
    title,
    description,
    images: [
      {
        url: `${basePath}/og.png`,
        width: 1200,
        height: 630,
        alt: "Rescript — a transcript-based video editor running in the browser",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${basePath}/og.png`],
  },
};

/** Apply stored appearance before paint to avoid a light→dark flash. */
const appearanceBootScript = `(function(){try{if(localStorage.getItem("rescript.appearance")==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="appearance-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: appearanceBootScript }}
        />
        {/* Provides COOP/COEP via a service worker on static hosts (GitHub
            Pages) that can't send headers; no-op when the server already
            sends them. Required for SharedArrayBuffer / multi-threading.
            Skipped in the Electron shell — the app:// protocol sets the
            headers directly. */}
        {!isElectron && (
          <Script
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/coi-serviceworker.js`}
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className="min-h-full">{children}</body>
      <GoogleAnalytics gaId="G-WZ055S858C" />
    </html>
  );
}
