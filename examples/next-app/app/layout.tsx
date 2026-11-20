import "dpdp-kit/react/styles.css"; // optional: dpdp-kit's default look for the consent screen and privacy centre
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Chai & Co", description: "A dpdp-kit example: Next.js App Router on SQLite" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="shop">
          <a href="/" className="brand">Chai &amp; Co</a>
          <a href="/privacy">Your privacy</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
