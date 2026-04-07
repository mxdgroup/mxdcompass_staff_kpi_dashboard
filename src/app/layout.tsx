import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "KPI Dashboard — MxD Digital",
  description: "Weekly team velocity dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-surface text-gray-900 font-[family-name:var(--font-inter)]" suppressHydrationWarning>
        <Suspense>{children}</Suspense>
      </body>
    </html>
  );
}
