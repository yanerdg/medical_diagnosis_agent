import type { Metadata } from "next";
import "./globals.css";
import { appInfo } from "@/lib/app-info";

export const metadata: Metadata = {
  title: appInfo.name,
  description: appInfo.description,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
