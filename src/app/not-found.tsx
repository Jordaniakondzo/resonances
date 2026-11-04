import type { Metadata } from "next";
import Link from "next/link";

import styles from "./not-found.module.css";

export const metadata: Metadata = {
  title: "Page introuvable",
};

export default function NotFound() {
  return (
    <section aria-labelledby="titre-404" className={styles.block}>
      <h1 id="titre-404" className={styles.title}>
        Page introuvable
      </h1>
      <p>Cette page n’existe pas ou n’est plus disponible.</p>
      <p>
        <Link href="/">Retourner à l’accueil</Link>
      </p>
    </section>
  );
}
