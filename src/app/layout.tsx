import type { Metadata } from "next";
import { Azeret_Mono, Michroma, Schibsted_Grotesk } from "next/font/google";
import { Providers } from "@/components/app/providers";
import "./globals.css";

// Body: a sturdy newspaper grotesk. Numbers: a wide, even mono for dates and lengths. Titles: a wide, aerospace-style display face.
const body = Schibsted_Grotesk({ variable: "--font-body", subsets: ["latin"] });
const mono = Azeret_Mono({ variable: "--font-numeric", subsets: ["latin"] });
const display = Michroma({ variable: "--font-headline", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Dockmaster — berth scheduling", template: "%s · Dockmaster" },
  description: "Berth reservations for a marine research facility: no double-bookings, no vessel too long for its berth.",
};

// Set the theme class before first paint so dark mode doesn't flash.
// Same rule as src/lib/theme.ts: a saved choice wins, otherwise follow the system.
const themeScript = `try{var t=localStorage.getItem('dock.theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${body.variable} ${mono.variable} ${display.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
