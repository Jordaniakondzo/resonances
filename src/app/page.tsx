import styles from "./page.module.css";

// Initial placeholder for T1: no Gallery, no data access yet.
export default function HomePage() {
  return (
    <section aria-labelledby="titre-accueil" className={styles.hero}>
      <h1 id="titre-accueil" className={styles.title}>
        Voir, ressentir, questionner l’amour
      </h1>
      <p className={styles.lead}>
        Résonances est un projet éditorial et visuel : une image ouvre un
        parcours de ressenti, d’interprétation et de réflexion autour de
        l’amour, de ses élans comme de ses zones fragiles.
      </p>
      <p className={styles.note}>Le site est en cours de construction.</p>
    </section>
  );
}
