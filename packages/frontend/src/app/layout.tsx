import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Outcome — Bitcoin Cash prediction markets",
  description: "Trade binary outcomes on Bitcoin Cash. Markets resolve on-chain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
