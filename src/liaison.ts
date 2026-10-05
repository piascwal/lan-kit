import { SERVEURS_STUN } from './reseau-local';

/**
 * Un candidat ICE (ligne `a=candidate:` ou `candidate:` d'une description
 * SDP) désigne-t-il le réseau local ? Sont gardés :
 * - les candidats `host` (l'appareil lui-même) sur une adresse privée : nom
 *   mDNS `.local` (ce que les navigateurs annoncent par défaut), IPv4 privée
 *   ou de lien local, IPv6 locale unique ou de lien local ;
 * - en secours (réseau qui bloque le mDNS), les candidats `srflx` dont
 *   l'adresse publique est la nôtre (`ipsPubliques`) : l'autre appareil sort
 *   sur Internet par la même box, le trafic ne fait que la traverser.
 * Tout le reste (adresse publique d'un autre réseau, relais) est refusé :
 * même un tiers qui aurait percé la clé de découverte ne peut pas se
 * connecter depuis Internet. Hors `plageStricte` (développement), tout
 * candidat `host` est accepté.
 */
export function candidatLocal(
  ligne: string,
  plageStricte = true,
  ipsPubliques: readonly string[] = [],
): boolean {
  const champs = ligne.trim().replace(/^a=/, '').split(/\s+/);
  const typ = champs.indexOf('typ');
  const genre = typ < 0 ? '' : champs[typ + 1];
  const adresse = (champs[4] ?? '').toLowerCase();
  if (genre === 'srflx') return ipsPubliques.includes(adresse);
  if (genre !== 'host') return false;
  if (!plageStricte) return adresse !== '';
  return adressePrivee(adresse);
}

/** Adresse privée, de lien local ou nom mDNS (`.local`) : jamais joignable depuis Internet. */
export function adressePrivee(a: string): boolean {
  if (/^[a-z0-9-]+\.local$/.test(a)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return (
      x === 10 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      x === 127
    );
  }
  if (a.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a) || a === '::1';
  return false;
}

/** Retire d'une description SDP tous les candidats qui ne sont pas sur le réseau local. */
export function filtreSdpLocal(
  sdp: string,
  plageStricte = true,
  ipsPubliques: readonly string[] = [],
): string {
  return sdp
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('a=candidate:') || candidatLocal(l, plageStricte, ipsPubliques))
    .join('\r\n');
}

/**
 * Liaison pair-à-pair WebRTC entre l'hôte et un client, sur le Wi-Fi.
 *
 * Deux canaux de données, chiffrés de bout en bout par DTLS (obligatoire
 * dans WebRTC, rien à configurer) :
 * - `ctrl` : fiable et ordonné — salon, lancement, évènements de jeu, ping ;
 * - `jeu`  : sans retransmission ni ordre — instantanés de l'hôte (60/s) et
 *   entrées du client. Un paquet perdu est simplement remplacé par le
 *   suivant, sans jamais bloquer ceux d'après (pas d'à-coups sur le Wi-Fi).
 * Les canaux sont « négociés » (ids fixes) : les deux côtés les créent à
 * l'identique, sans aller-retour supplémentaire.
 *
 * Liaison strictement locale : jamais de relais, et seuls les candidats ICE
 * du réseau local sont proposés et acceptés (voir `candidatLocal`) ; le STUN
 * ne sert qu'au secours par la box commune (`ipsPubliques` : nos adresses
 * publiques). `plageStricte` n'est relâché qu'en développement (tests sur une
 * machine dont l'adresse n'est pas dans une plage privée).
 */
export interface OptionsLiaison {
  /**
   * Jeu par Internet : on accepte aussi les candidats publics (adresses des
   * joueurs, vues par STUN). Chaque joueur voit alors l'adresse IP des autres,
   * c'est inhérent au pair à pair ; un relais TURN (`serveursIce`) la masquerait.
   */
  enLigne?: boolean;
  /** Serveurs ICE en plus du STUN public, notamment un relais TURN (voir docs/TURN.md). */
  serveursIce?: RTCIceServer[];
}

export class Liaison {
  readonly pc: RTCPeerConnection;
  readonly ctrl: RTCDataChannel;
  readonly jeu: RTCDataChannel;
  onCtrl: (msg: unknown) => void = () => {};
  onJeu: (data: ArrayBuffer) => void = () => {};
  onFerme: () => void = () => {};
  private fermee = false;
  private readonly enLigne: boolean;

  constructor(
    private readonly plageStricte = true,
    private readonly ipsPubliques: readonly string[] = [],
    options: OptionsLiaison = {},
  ) {
    this.enLigne = options.enLigne ?? false;
    this.pc = new RTCPeerConnection({
      iceServers: [
        ...(ipsPubliques.length || this.enLigne ? [{ urls: SERVEURS_STUN }] : []),
        ...(options.serveursIce ?? []),
      ],
    });
    this.ctrl = this.pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
    this.jeu = this.pc.createDataChannel('jeu', {
      negotiated: true,
      id: 1,
      ordered: false,
      maxRetransmits: 0,
    });
    this.jeu.binaryType = 'arraybuffer';
    this.ctrl.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 65536) return;
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onCtrl(msg);
    };
    this.jeu.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer && e.data.byteLength <= 4096) this.onJeu(e.data);
    };
    const coupe = () => this.ferme();
    this.ctrl.onclose = coupe;
    this.jeu.onclose = coupe;
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') coupe();
    };
  }

  /** En ligne tout candidat est bon ; sur le Wi-Fi, seuls ceux du réseau local. */
  private filtre(sdp: string): string {
    return this.enLigne ? sdp : filtreSdpLocal(sdp, this.plageStricte, this.ipsPubliques);
  }

  /** Attend la fin de la collecte des candidats (pas d'échange au fil de l'eau : un seul message chacun). */
  private async descriptionComplete(delaiMs = 2500): Promise<string> {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resoudre) => {
        const garde = setTimeout(resoudre, delaiMs);
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') {
            clearTimeout(garde);
            resoudre();
          }
        });
      });
    }
    return this.filtre(this.pc.localDescription!.sdp);
  }

  async creeOffre(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.descriptionComplete();
  }

  async accepteOffre(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({
      type: 'offer',
      sdp: this.filtre(sdp),
    });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.descriptionComplete();
  }

  async accepteReponse(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp: this.filtre(sdp),
    });
  }

  /** Résout quand les deux canaux sont ouverts, échoue après `delaiMs`. */
  ouverte(delaiMs = 15_000): Promise<void> {
    const canal = (c: RTCDataChannel) =>
      c.readyState === 'open'
        ? Promise.resolve()
        : new Promise<void>((r) => c.addEventListener('open', () => r(), { once: true }));
    return new Promise((resoudre, rejeter) => {
      const garde = setTimeout(() => rejeter(new Error('connexion impossible')), delaiMs);
      void Promise.all([canal(this.ctrl), canal(this.jeu)]).then(() => {
        clearTimeout(garde);
        resoudre();
      });
    });
  }

  /**
   * Code de vérification à 4 chiffres, identique des deux côtés, dérivé des
   * empreintes des certificats DTLS des deux appareils. Si un intermédiaire
   * s'était glissé dans l'échange (serveur de découverte malveillant), les
   * codes affichés sur les deux écrans différeraient.
   */
  async codeVerification(): Promise<string> {
    const emp = (sdp: string | undefined) => (sdp?.match(/a=fingerprint:\S+ (\S+)/)?.[1] ?? '').toUpperCase();
    const a = emp(this.pc.localDescription?.sdp);
    const b = emp(this.pc.remoteDescription?.sdp);
    const s = [a, b].sort().join('|');
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
    return String(n % 10000).padStart(4, '0');
  }

  envoieCtrl(msg: unknown): void {
    if (this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(msg));
  }

  envoieJeu(data: ArrayBuffer): void {
    // si le tampon gonfle (Wi-Fi saturé), mieux vaut sauter un instantané que prendre du retard
    if (this.jeu.readyState === 'open' && this.jeu.bufferedAmount < 64 * 1024) this.jeu.send(data);
  }

  get ouverteMaintenant(): boolean {
    return !this.fermee && this.ctrl.readyState === 'open';
  }

  ferme(): void {
    if (this.fermee) return;
    this.fermee = true;
    try {
      this.ctrl.close();
      this.jeu.close();
      this.pc.close();
    } catch {
      /* déjà fermé */
    }
    this.onFerme();
  }
}
