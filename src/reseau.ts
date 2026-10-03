import { detecteReseaux, salonPour, type AppLan, type Salon } from './reseau-local';

export interface ReseauDetecte {
  salons: Salon[];
  /** Nos adresses IPv4 publiques (celles de la box) : secours des liaisons locales. */
  ipsPubliques: string[];
}

/**
 * Détecte le ou les réseaux de cet appareil (via STUN) et en dérive les salons
 * de découverte du jeu. `reseauForce` remplace la détection : tests à
 * plusieurs onglets sur une seule machine, avec un courtier local.
 * Lève une erreur `reseau` si aucun réseau n'est détecté.
 */
export async function salonsDuReseau(app: AppLan, reseauForce: string | null = null): Promise<ReseauDetecte> {
  const cles = reseauForce ? [`dev:${reseauForce}`] : await detecteReseaux();
  if (!cles.length) throw new Error('reseau');
  const ipsPubliques = cles.filter((c) => c.startsWith('ip4:')).map((c) => c.slice(4));
  return { salons: await Promise.all(cles.map((c) => salonPour(app, c))), ipsPubliques };
}
