import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import type { ReactNode } from "react";

import "../styles/tokens.css";
import "../styles/globals.css";
import styles from "./layout.module.css";

// Only the weights actually used by the design tokens (D06).
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-inter",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "700"],
  display: "swap",
  variable: "--font-playfair",
});

export const metadata: Metadata = {
  title: {
    default: "Résonances — Voir, ressentir, questionner l’amour",
    template: "%s — Résonances",
  },
  description:
    "Résonances est un projet éditorial et visuel autour de l’amour : une image, un ressenti, une réflexion, une question ouverte.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={`${inter.variable} ${playfair.variable}`}>
      <body>
        <a className={styles.skipLink} href="#contenu">
          Aller au contenu
        </a>
        <header className={styles.header}>
          <div className={styles.container}>
            <p className={styles.siteName}>Résonances</p>
          </div>
        </header>
        <main id="contenu" className={styles.main}>
          <div className={styles.container}>{children}</div>
        </main>
      </body>
    </html>
  );
}
