import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BountyPay",
  description: "Pays open-source bounties through PayPal when Claude confirms the merged PR resolves the issue.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
