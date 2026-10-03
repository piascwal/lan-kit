/**
 * Client MQTT 3.1.1 minimal au-dessus d'un WebSocket sécurisé (wss://).
 *
 * Sert uniquement à la *découverte* des parties en réseau local : les hôtes y
 * déposent une annonce chiffrée, les clients y déposent leur offre WebRTC.
 * Aucune donnée de jeu n'y transite — une fois la liaison pair-à-pair
 * établie, tout passe en direct sur le Wi-Fi. On se limite à la QoS 0, aux
 * messages retenus (annonces) et au « testament » (will) qui efface
 * l'annonce si l'hôte disparaît sans prévenir.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const MQTT_CONNECT = 1;
export const MQTT_CONNACK = 2;
export const MQTT_PUBLISH = 3;
export const MQTT_SUBSCRIBE = 8;
export const MQTT_SUBACK = 9;
export const MQTT_UNSUBSCRIBE = 10;
export const MQTT_PINGREQ = 12;
export const MQTT_PINGRESP = 13;
export const MQTT_DISCONNECT = 14;

/** Longueur restante encodée sur 1 à 4 octets (7 bits par octet). */
export function encodeLongueur(n: number): number[] {
  const out: number[] = [];
  do {
    let o = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) o |= 0x80;
    out.push(o);
  } while (n > 0);
  return out;
}

function chaine(s: string | Uint8Array): Uint8Array {
  const b = typeof s === 'string' ? enc.encode(s) : s;
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function concat(parties: (Uint8Array | number[])[]): Uint8Array {
  const n = parties.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parties) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function paquet(entete: number, corps: Uint8Array): Uint8Array {
  return concat([[entete], encodeLongueur(corps.length), corps]);
}

export interface Testament {
  topic: string;
  payload: Uint8Array;
  retain: boolean;
}

export function paquetConnect(clientId: string, keepalive: number, will?: Testament): Uint8Array {
  let flags = 0x02; // clean session
  if (will) flags |= 0x04 | (will.retain ? 0x20 : 0);
  const variable = concat([chaine('MQTT'), [4, flags, keepalive >> 8, keepalive & 0xff]]);
  const charge = [chaine(clientId)];
  if (will) charge.push(chaine(will.topic), chaine(will.payload));
  return paquet(MQTT_CONNECT << 4, concat([variable, ...charge]));
}

export function paquetPublish(topic: string, payload: Uint8Array, retain: boolean): Uint8Array {
  return paquet((MQTT_PUBLISH << 4) | (retain ? 1 : 0), concat([chaine(topic), payload]));
}

export function paquetSubscribe(id: number, filtre: string): Uint8Array {
  return paquet((MQTT_SUBSCRIBE << 4) | 0x02, concat([[id >> 8, id & 0xff], chaine(filtre), [0]]));
}

export function paquetUnsubscribe(id: number, filtre: string): Uint8Array {
  return paquet((MQTT_UNSUBSCRIBE << 4) | 0x02, concat([[id >> 8, id & 0xff], chaine(filtre)]));
}

export interface PaquetMqtt {
  type: number;
  flags: number;
  corps: Uint8Array;
}

/**
 * Taille maximale d'un paquet MQTT reçu. Nos annonces et offres chiffrées
 * font quelques kilo-octets : au-delà, c'est une erreur ou une tentative de
 * saturer la mémoire, et la connexion est coupée (puis rétablie).
 */
export const PAQUET_MQTT_MAX = 64 * 1024;

/** Découpe un flux d'octets (trames WebSocket arbitraires) en paquets MQTT complets. */
export class LecteurMqtt {
  private tampon: Uint8Array = new Uint8Array(0);

  pousse(morceau: Uint8Array): PaquetMqtt[] {
    this.tampon = concat([this.tampon, morceau]);
    const out: PaquetMqtt[] = [];
    for (;;) {
      if (this.tampon.length < 2) break;
      let mult = 1;
      let longueur = 0;
      let i = 1;
      let complet = false;
      for (; i < 5 && i < this.tampon.length; i++) {
        const o = this.tampon[i]!;
        longueur += (o & 0x7f) * mult;
        mult *= 128;
        if (!(o & 0x80)) {
          complet = true;
          break;
        }
      }
      if (!complet) {
        if (i >= 5) throw new Error('longueur MQTT invalide');
        break;
      }
      if (longueur > PAQUET_MQTT_MAX) throw new Error('paquet MQTT trop gros');
      const debut = i + 1;
      if (this.tampon.length < debut + longueur) break;
      const h = this.tampon[0]!;
      out.push({ type: h >> 4, flags: h & 0x0f, corps: this.tampon.slice(debut, debut + longueur) });
      this.tampon = this.tampon.slice(debut + longueur);
    }
    return out;
  }
}

export function lisPublish(p: PaquetMqtt): { topic: string; payload: Uint8Array; retain: boolean } {
  const lt = (p.corps[0]! << 8) | p.corps[1]!;
  const topic = dec.decode(p.corps.subarray(2, 2 + lt));
  const qos = (p.flags >> 1) & 3;
  const debut = 2 + lt + (qos > 0 ? 2 : 0);
  return { topic, payload: p.corps.slice(debut), retain: (p.flags & 1) === 1 };
}

/** Filtre MQTT (`+` = un niveau, `#` = la suite) contre un topic concret. */
export function correspond(filtre: string, topic: string): boolean {
  const f = filtre.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export interface OptionsClientMqtt {
  clientId: string;
  keepalive?: number;
  will?: Testament;
}

export class ClientMqtt {
  onMessage: (topic: string, payload: Uint8Array, retain: boolean) => void = () => {};
  onFerme: () => void = () => {};

  private ws: WebSocket | null = null;
  private readonly lecteur = new LecteurMqtt();
  private idPaquet = 1;
  private minuteur: ReturnType<typeof setInterval> | null = null;
  private connecte_ = false;

  constructor(
    readonly url: string,
    private readonly opts: OptionsClientMqtt,
  ) {}

  get connecte(): boolean {
    return this.connecte_;
  }

  ouvre(delaiMs = 6000): Promise<void> {
    return new Promise((resoudre, rejeter) => {
      let fini = false;
      const echec = (raison: string) => {
        if (fini) return;
        fini = true;
        this.ferme(false);
        rejeter(new Error(raison));
      };
      const garde = setTimeout(() => echec('délai dépassé'), delaiMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, ['mqtt']);
      } catch (e) {
        clearTimeout(garde);
        echec(String(e));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const keepalive = this.opts.keepalive ?? 25;
        ws.send(paquetConnect(this.opts.clientId, keepalive, this.opts.will));
        this.minuteur = setInterval(
          () => this.envoie(new Uint8Array([MQTT_PINGREQ << 4, 0])),
          (keepalive * 1000) / 2,
        );
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        let paquets: PaquetMqtt[];
        try {
          paquets = this.lecteur.pousse(new Uint8Array(e.data));
        } catch {
          this.ferme(false);
          return;
        }
        for (const p of paquets) {
          if (p.type === MQTT_CONNACK) {
            clearTimeout(garde);
            if (p.corps[1] === 0) {
              this.connecte_ = true;
              fini = true;
              resoudre();
            } else echec(`refus ${p.corps[1]}`);
          } else if (p.type === MQTT_PUBLISH) {
            const m = lisPublish(p);
            this.onMessage(m.topic, m.payload, m.retain);
          }
        }
      };
      ws.onerror = () => echec('erreur réseau');
      ws.onclose = () => {
        clearTimeout(garde);
        const etaitConnecte = this.connecte_;
        this.nettoie();
        if (!fini) echec('fermé');
        else if (etaitConnecte) this.onFerme();
      };
    });
  }

  private envoie(b: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
  }

  private prochainId(): number {
    this.idPaquet = (this.idPaquet % 65535) + 1;
    return this.idPaquet;
  }

  publie(topic: string, payload: Uint8Array, retain = false): void {
    this.envoie(paquetPublish(topic, payload, retain));
  }

  abonne(filtre: string): void {
    this.envoie(paquetSubscribe(this.prochainId(), filtre));
  }

  desabonne(filtre: string): void {
    this.envoie(paquetUnsubscribe(this.prochainId(), filtre));
  }

  private nettoie(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
    this.connecte_ = false;
  }

  /** `propre` : DISCONNECT explicite, le broker ne publie alors pas le testament. */
  ferme(propre = true): void {
    const ws = this.ws;
    this.ws = null;
    this.nettoie();
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      if (propre && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([MQTT_DISCONNECT << 4, 0]));
      ws.close();
    } catch {
      /* déjà fermé */
    }
  }
}
