import { COURTIERS } from './courtiers';
import { ClientMqtt } from './mqtt';
import { chiffre, dechiffre, idAleatoire, type AppLan, type Salon } from './reseau-local';

const RAFRAICHISSEMENT_MS = 30_000;
const PEREMPTION_MS = 5 * 60_000;

/**
 * Une partie annoncée sur le réseau : les champs communs ajoutés par l'annuaire
 * (`id`, version `v`, date `t`, `salon` d'où elle a été vue : local, jamais transmis)
 * plus le contenu propre au jeu (format, score, équipes...).
 */
export type Annonce<T> = T & { id: string; v: number; t: number; salon: number };

export type Signal =
  /** `spect` : l'appareil veut seulement regarder le match. */
  | { type: 'offre'; sdp: string; nom: string; spect: boolean }
  | { type: 'reponse'; sdp: string }
  | { type: 'refus'; raison: 'complet' | 'version' | 'spectateurs' };

/** Texte « sûr » : un nom de joueur ou d'équipe affiché tel quel dans la liste des parties. */
export const TEXTE_SUR = /^[A-Z0-9 ]{1,14}$/;
const ID_SUR = /^[0-9a-f]{16}$/;
const SDP_MAX = 16_000;

/**
 * Valide le contenu propre au jeu d'une annonce déjà déchiffrée : renvoie le
 * contenu nettoyé (sans `id`, `v`, `t`), ou null s'il est invalide. Tout ce
 * qui vient du réseau est suspect, même chiffré.
 */
export type ValideContenu<T> = (o: Record<string, unknown>) => T | null;

/** Valide une annonce déchiffrée : champs communs, puis contenu du jeu. */
export function valideAnnonce<T>(
  o: unknown,
  idTopic: string,
  salon: number,
  valide: ValideContenu<T>,
): Annonce<T> | null {
  if (!o || typeof o !== 'object') return null;
  const a = o as Record<string, unknown>;
  if (a.id !== idTopic || typeof a.id !== 'string' || !ID_SUR.test(a.id)) return null;
  if (typeof a.v !== 'number' || typeof a.t !== 'number' || !Number.isFinite(a.t)) return null;
  const contenu = valide(a);
  if (!contenu) return null;
  return { ...contenu, id: a.id, v: a.v, t: a.t, salon };
}

export function valideSignal(o: unknown): Signal | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as Record<string, unknown>;
  if (
    s.type === 'offre' &&
    typeof s.sdp === 'string' &&
    s.sdp.length < SDP_MAX &&
    typeof s.nom === 'string' &&
    TEXTE_SUR.test(s.nom)
  ) {
    return { type: 'offre', sdp: s.sdp, nom: s.nom, spect: s.spect === true };
  }
  if (s.type === 'reponse' && typeof s.sdp === 'string' && s.sdp.length < SDP_MAX)
    return { type: 'reponse', sdp: s.sdp };
  if (s.type === 'refus' && (s.raison === 'complet' || s.raison === 'version' || s.raison === 'spectateurs'))
    return { type: 'refus', raison: s.raison };
  return null;
}

export interface OptionsAnnuaire<T> {
  app: AppLan;
  salons: Salon[];
  /** valide le contenu des annonces reçues (propre au jeu) */
  valideContenu: ValideContenu<T>;
  courtiers?: string[];
  /** Hôte : le broker efface l'annonce tout seul si la connexion tombe. */
  testament?: boolean;
}

export class Annuaire<T extends object> {
  readonly id = idAleatoire();
  onAnnonce: (a: Annonce<T>) => void = () => {};
  onRetrait: (id: string) => void = () => {};
  onSignal: (de: string, salon: number, s: Signal) => void = () => {};

  private clients: ClientMqtt[] = [];
  private ferme_ = false;
  private ecoute = false;
  private annonceCourante: T | null = null;
  private minuteurAnnonce: ReturnType<typeof setInterval> | null = null;
  private readonly vus = new Set<string>();

  readonly app: AppLan;
  readonly salons: Salon[];
  private readonly valideContenu: ValideContenu<T>;
  private readonly courtiers: string[];
  private readonly testament: boolean;

  constructor(o: OptionsAnnuaire<T>) {
    this.app = o.app;
    this.salons = o.salons;
    this.valideContenu = o.valideContenu;
    this.courtiers = o.courtiers ?? COURTIERS;
    this.testament = o.testament ?? false;
  }

  private topicAnnonce(salon: number, id = this.id): string {
    return `${this.salons[salon]!.base}/parties/${id}`;
  }

  private topicBoite(salon: number, id: string): string {
    return `${this.salons[salon]!.base}/boite/${id}`;
  }

  /** Se connecte à tous les courtiers ; renvoie combien ont répondu (lève une erreur si aucun). */
  async ouvre(): Promise<number> {
    const essais = this.courtiers.map((url, i) => this.connecte(url, i));
    const res = await Promise.allSettled(essais);
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    if (ok === 0) throw new Error('aucun serveur de découverte joignable');
    return ok;
  }

  private async connecte(url: string, i: number, tentative = 0): Promise<void> {
    const c = new ClientMqtt(url, {
      clientId: `${this.app.id.slice(0, 6)}-${this.id}-${i}-${idAleatoire(2)}`,
      keepalive: 20,
      will: this.testament
        ? { topic: this.topicAnnonce(0), payload: new Uint8Array(0), retain: true }
        : undefined,
    });
    c.onMessage = (topic, payload) => void this.recoit(topic, payload);
    c.onFerme = () => {
      this.clients = this.clients.filter((x) => x !== c);
      if (!this.ferme_)
        setTimeout(
          () => void this.connecte(url, i, tentative + 1).catch(() => {}),
          Math.min(30_000, 2000 * 2 ** tentative),
        );
    };
    await c.ouvre();
    if (this.ferme_) {
      c.ferme();
      return;
    }
    this.clients.push(c);
    for (let s = 0; s < this.salons.length; s++) c.abonne(this.topicBoite(s, this.id));
    if (this.ecoute)
      for (let s = 0; s < this.salons.length; s++) c.abonne(`${this.salons[s]!.base}/parties/+`);
    if (this.annonceCourante) void this.publieAnnonce([c]);
  }

  get nbConnectes(): number {
    return this.clients.length;
  }

  /** (Ré)abonne aux annonces : les messages retenus arrivent aussitôt. */
  ecouteAnnonces(): void {
    this.ecoute = true;
    for (const c of this.clients) {
      for (const s of this.salons) {
        c.desabonne(`${s.base}/parties/+`);
        c.abonne(`${s.base}/parties/+`);
      }
    }
  }

  arreteAnnonces(): void {
    this.ecoute = false;
    for (const c of this.clients) for (const s of this.salons) c.desabonne(`${s.base}/parties/+`);
  }

  annonce(contenu: T): void {
    this.annonceCourante = contenu;
    void this.publieAnnonce(this.clients);
    if (!this.minuteurAnnonce)
      this.minuteurAnnonce = setInterval(() => void this.publieAnnonce(this.clients), RAFRAICHISSEMENT_MS);
  }

  private async publieAnnonce(cibles: ClientMqtt[]): Promise<void> {
    const a = this.annonceCourante;
    if (!a) return;
    for (let s = 0; s < this.salons.length; s++) {
      const topic = this.topicAnnonce(s);
      const payload = await chiffre(this.salons[s]!, topic, {
        ...a,
        id: this.id,
        v: this.app.version,
        t: Date.now(),
      });
      if (!this.annonceCourante) return;
      for (const c of cibles) c.publie(topic, payload, true);
    }
  }

  retireAnnonce(): void {
    this.annonceCourante = null;
    if (this.minuteurAnnonce) clearInterval(this.minuteurAnnonce);
    this.minuteurAnnonce = null;
    for (let s = 0; s < this.salons.length; s++)
      for (const c of this.clients) c.publie(this.topicAnnonce(s), new Uint8Array(0), true);
  }

  async signale(dest: string, salon: number, s: Signal): Promise<void> {
    const topic = this.topicBoite(salon, dest);
    const payload = await chiffre(this.salons[salon]!, topic, {
      n: idAleatoire(),
      de: this.id,
      t: Date.now(),
      s,
    });
    for (const c of this.clients) c.publie(topic, payload, false);
  }

  private async recoit(topic: string, payload: Uint8Array): Promise<void> {
    const salon = this.salons.findIndex((s) => topic.startsWith(`${s.base}/`));
    if (salon < 0) return;
    const reste = topic.slice(this.salons[salon]!.base.length + 1).split('/');
    if (reste.length !== 2) return;
    const [genre, id] = reste as [string, string];
    if (genre === 'parties') {
      if (id === this.id) return;
      if (payload.length === 0) {
        this.onRetrait(id);
        return;
      }
      const a = valideAnnonce(
        await dechiffre(this.salons[salon]!, topic, payload),
        id,
        salon,
        this.valideContenu,
      );
      if (a && Math.abs(Date.now() - a.t) < PEREMPTION_MS) this.onAnnonce(a);
    } else if (genre === 'boite' && id === this.id) {
      const o = (await dechiffre(this.salons[salon]!, topic, payload)) as Record<string, unknown> | null;
      if (
        !o ||
        typeof o.n !== 'string' ||
        typeof o.de !== 'string' ||
        !ID_SUR.test(o.de) ||
        typeof o.t !== 'number'
      )
        return;
      // le même message arrive par chaque courtier : on ne le traite qu'une fois
      if (this.vus.has(o.n) || Math.abs(Date.now() - o.t) > PEREMPTION_MS) return;
      this.vus.add(o.n);
      if (this.vus.size > 500) this.vus.clear();
      const s = valideSignal(o.s);
      if (s) this.onSignal(o.de, salon, s);
    }
  }

  ferme(): void {
    if (this.annonceCourante) this.retireAnnonce();
    this.ferme_ = true;
    if (this.minuteurAnnonce) clearInterval(this.minuteurAnnonce);
    for (const c of this.clients) c.ferme();
    this.clients = [];
  }
}
