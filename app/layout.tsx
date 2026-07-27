import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rescript — edit videos like you edit text",
  description:
    "A fully offline, open-source transcript-based video editor. Transcribe with Whisper, cut by deleting words, export with ffmpeg — all in your browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Provides COOP/COEP via a service worker on static hosts (GitHub
            Pages) that can't send headers; no-op when the server already
            sends them. Required for SharedArrayBuffer / multi-threading. */}
        <Script
          src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/coi-serviceworker.js`}
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-full">{children}</body>
      <GoogleAnalytics gaId="G-WZ055S858C" />
    </html>
  );
}
