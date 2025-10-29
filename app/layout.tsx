import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "HydraMate - Pengingat Minum Air",
  description:
    "Aplikasi web progresif untuk membantu kamu tetap terhidrasi dengan pengingat minum air yang pintar.",
  manifest: "/manifest.json"
};

export const viewport: Viewport = {
  themeColor: "#2563eb"
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html lang="id">
      <body>
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
