import { type AppLan, type Salon } from './reseau-local';

/**
 * Le jeu par Internet : pas de serveur à vous, un **code de salon** que l'hôte
 * communique aux autres (à voix haute, par message, ou par lien).
 *
 * Le code ne sert pas qu'à nommer le salon : il dérive aussi la clé AES-GCM qui
 * chiffre les annonces et les offres de connexion déposées sur les serveurs MQTT
 * publics. Sans le code, on ne voit ni le salon ni son contenu, et on ne peut ni
 * s'y faire passer pour l'hôte ni y rejouer un message. Le nom du salon sur le
 * serveur est un condensé du code, pas le code : le deviner demande de calculer
 * une dérivation lente (PBKDF2) pour chaque essai, hors ligne comme en ligne.
 */

const enc = new TextEncoder();

/** Sans 0, O, 1, I ni L, qu'on confond à la lecture : 31 symboles, 8 par code, soit près de 40 bits. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LONGUEUR_CODE = 8;
/** Recommandation OWASP pour PBKDF2-SHA256 : ~100 à 200 ms sur un appareil récent. */
const ITERATIONS = 210_000;

/** Un code de salon au hasard, au format `XXXX-XXXX`. */
export function genereCode(): string {
  let brut = '';
  // tirage sans biais : on écarte les octets qui ne tomberaient pas sur un tour complet de l'alphabet
  const limite = 256 - (256 % ALPHABET.length);
  while (brut.length < LONGUEUR_CODE) {
    for (const o of crypto.getRandomValues(new Uint8Array(16))) {
      if (o < limite && brut.length < LONGUEUR_CODE) brut += ALPHABET[o % ALPHABET.length];
    }
  }
  return `${brut.slice(0, 4)}-${brut.slice(4)}`;
}

/** Ce que le joueur a saisi, en code propre (`XXXX-XXXX`), ou null s'il est invalide. Casse, espaces et tirets sont libres. */
export function normaliseCode(saisie: string): string | null {
  const brut = saisie.toUpperCase().replace(/[\s-]/g, '');
  if (brut.length !== LONGUEUR_CODE || [...brut].some((c) => !ALPHABET.includes(c))) return null;
  return `${brut.slice(0, 4)}-${brut.slice(4)}`;
}

/** Le lien d'invitation : le code est dans le fragment (`#salon=`), que le navigateur n'envoie jamais à un serveur. */
export function lienInvitation(base: string, code: string): string {
  return `${base.split('#')[0]}#salon=${encodeURIComponent(code)}`;
}

/** Le code d'un lien d'invitation (`location.hash`), ou null. */
export function codeDuLien(hash: string): string | null {
  const m = /^#?salon=([^&]*)/.exec(hash);
  if (!m) return null;
  try {
    return normaliseCode(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Le salon d'un code : même code, même jeu, même version de protocole → même salon, chez tous les joueurs. Lève si le code est invalide. */
export async function salonEnLigne(app: AppLan, code: string): Promise<Salon> {
  const propre = normaliseCode(code);
  if (!propre) throw new Error('code');
  const base = await crypto.subtle.importKey('raw', enc.encode(propre), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: enc.encode(`${app.id}|ligne|v1`) },
      base,
      384,
    ),
  );
  const cle = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { base: `${app.id}/v${app.version}/ligne/${hex(bits.slice(32, 48))}`, cle };
}
