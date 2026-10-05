import type { Liaison } from './liaison';

const PING_MS = 1000;
const SILENCE_MAX_MS = 6000;

/** Les deux messages de contrôle que la veille échange : le reste du protocole est celui du jeu. */
export type MsgVeille = { t: 'ping'; k: number } | { t: 'pong'; k: number };

export const attente = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Surveille une liaison : ping/pong pour la latence, et coupure si le pair se tait trop longtemps. */
export class Veille {
  latenceMs: number | null = null;
  private dernierRecu = performance.now();
  private readonly minuteur: ReturnType<typeof setInterval>;

  constructor(
    private readonly liaison: Liaison,
    surSilence: () => void,
    /** silence toléré avant coupure : plus long sur Internet, où la latence varie davantage */
    private readonly silenceMaxMs = SILENCE_MAX_MS,
  ) {
    this.minuteur = setInterval(() => {
      if (performance.now() - this.dernierRecu > this.silenceMaxMs) surSilence();
      else liaison.envoieCtrl({ t: 'ping', k: performance.now() });
    }, PING_MS);
  }

  /** À appeler pour tout message de contrôle reçu ; renvoie true s'il s'agissait d'un ping/pong (déjà traité). */
  recu(m: { t: string; k?: number }): boolean {
    this.dernierRecu = performance.now();
    if (m.t === 'ping' && typeof m.k === 'number') {
      this.liaison.envoieCtrl({ t: 'pong', k: m.k });
      return true;
    }
    if (m.t === 'pong' && typeof m.k === 'number') {
      const rtt = performance.now() - m.k;
      if (rtt >= 0 && rtt < 10_000)
        this.latenceMs = this.latenceMs === null ? rtt : this.latenceMs * 0.7 + rtt * 0.3;
      return true;
    }
    return false;
  }

  /** À appeler pour tout paquet de jeu reçu (instantané, entrée) : le pair est vivant. */
  recuJeu(): void {
    this.dernierRecu = performance.now();
  }

  arrete(): void {
    clearInterval(this.minuteur);
  }
}
