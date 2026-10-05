import { TEXTE_SUR } from './annuaire';

/**
 * Un pseudo « sûr » pour le réseau : majuscules sans accent, lettres, chiffres et
 * espaces, 14 caractères au plus (voir `TEXTE_SUR`). Renvoie `repli` si rien ne reste.
 */
export function nettoiePseudo(saisie: string, repli = 'JOUEUR'): string {
  const net = saisie
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14)
    .trim();
  return TEXTE_SUR.test(net) ? net : repli;
}

export type QualitePing = 'bon' | 'moyen' | 'mauvais' | 'inconnu';

/** Pour colorer un ping : vert sous 60 ms, orange sous 150 ms, rouge au-delà. */
export function qualitePing(ms: number | null): QualitePing {
  if (ms === null || !Number.isFinite(ms)) return 'inconnu';
  return ms < 60 ? 'bon' : ms < 150 ? 'moyen' : 'mauvais';
}

/** Le ping tel qu'on l'affiche : `42 ms`, ou `--` tant qu'il est inconnu. */
export const texteLatence = (ms: number | null): string =>
  ms === null || !Number.isFinite(ms) ? '--' : `${Math.round(ms)} ms`;
