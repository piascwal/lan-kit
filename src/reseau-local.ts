/**
 * « Empreinte » du réseau local, sans jamais demander d'adresse IP au joueur.
 *
 * Tous les appareils branchés sur le même Wi-Fi sortent sur Internet par la
 * même adresse publique (celle de la box). Le navigateur la découvre tout
 * seul via STUN, le mécanisme standard que WebRTC utilise de toute façon :
 * c'est la clé qui regroupe les appareils d'un même réseau. Elle n'est
 * jamais publiée telle quelle : on n'en publie qu'un condensé (le nom du
 * « salon » sur le serveur de découverte), et une seconde dérivation sert de
 * clé AES-GCM pour chiffrer annonces et offres de connexion. Un tiers qui ne
 * partage pas votre adresse publique ne voit ni vos parties ni vos offres.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Identité d'un jeu sur le réseau : deux jeux (ou deux versions d'un même
 * protocole) ne se voient jamais, car le nom des salons en dépend.
 */
export interface AppLan {
  /** court, en minuscules et sans espace : `face-off`, `bandeja` */
  id: string;
  /** version du protocole du jeu : change à chaque modification incompatible des messages */
  version: number;
}

export const SERVEURS_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

/** Extrait l'adresse d'un candidat ICE « server reflexive » (vue depuis Internet). */
export function adresseSrflx(ligne: string): string | null {
  const champs = ligne.trim().split(/\s+/);
  const typ = champs.indexOf('typ');
  if (typ < 0 || champs[typ + 1] !== 'srflx') return null;
  return champs[4] ?? null;
}

function developpeIpv6(ip: string): string[] | null {
  const [tete, queue] = ip.split('::') as [string, string | undefined];
  const a = tete ? tete.split(':') : [];
  const b = queue !== undefined && queue !== '' ? queue.split(':') : [];
  if (queue === undefined && a.length !== 8) return null;
  const manque = 8 - a.length - b.length;
  if (manque < 0) return null;
  return [...a, ...Array<string>(queue === undefined ? 0 : manque).fill('0'), ...b].map((h) =>
    h.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/**
 * Clé de regroupement : l'IPv4 publique telle quelle, ou le préfixe /64 pour
 * l'IPv6 (chaque appareil a sa propre adresse IPv6, mais tout le réseau
 * local partage le même préfixe). `null` pour tout ce qui n'est pas une IP.
 */
export function cleReseau(adresse: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(adresse)) return `ip4:${adresse}`;
  if (adresse.includes(':')) {
    const h = developpeIpv6(adresse);
    if (!h || h.length !== 8) return null;
    return `ip6:${h.slice(0, 4).join(':')}`;
  }
  return null;
}

/** Détecte la ou les clés de réseau de cet appareil (souvent une seule). */
export async function detecteReseaux(delaiMs = 3000): Promise<string[]> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: SERVEURS_STUN }] });
  const cles = new Set<string>();
  try {
    pc.createDataChannel('sonde');
    await new Promise<void>((resoudre) => {
      let tardif: ReturnType<typeof setTimeout> | null = null;
      const garde = setTimeout(resoudre, delaiMs);
      const fin = () => {
        clearTimeout(garde);
        if (tardif) clearTimeout(tardif);
        resoudre();
      };
      pc.onicecandidate = (e) => {
        if (!e.candidate) return fin();
        const a = adresseSrflx(e.candidate.candidate);
        const c = a ? cleReseau(a) : null;
        if (c) {
          cles.add(c);
          // on laisse un court instant à une éventuelle 2e famille d'adresses (IPv4 + IPv6)
          if (!tardif) tardif = setTimeout(fin, 400);
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') fin();
      };
      void pc.createOffer().then((o) => pc.setLocalDescription(o));
    });
  } finally {
    pc.close();
  }
  return [...cles].sort();
}

export interface Salon {
  /** Préfixe des topics MQTT de ce réseau (condensé de la clé, jamais l'IP). */
  base: string;
  cle: CryptoKey;
}

async function condense(texte: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(texte)));
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function salonPour(app: AppLan, cleRes: string): Promise<Salon> {
  const prefixe = `${app.id}/lan/v1`;
  const id = hex(await condense(`${prefixe}|salon|${cleRes}`)).slice(0, 32);
  const brut = await condense(`${prefixe}|cle|${cleRes}`);
  const cle = await crypto.subtle.importKey('raw', brut, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { base: `${app.id}/v${app.version}/${id}`, cle };
}

/** Chiffre un objet JSON ; le topic sert de donnée authentifiée (un message ne peut pas être rejoué ailleurs). */
export async function chiffre(salon: Salon, topic: string, objet: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clair = enc.encode(JSON.stringify(objet));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(topic) }, salon.cle, clair),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** Renvoie l'objet déchiffré, ou null (message d'un autre réseau, altéré, ou illisible). */
export async function dechiffre(salon: Salon, topic: string, payload: Uint8Array): Promise<unknown> {
  if (payload.length < 29 || payload.length > 32768) return null;
  try {
    const copie = new Uint8Array(payload);
    const clair = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copie.subarray(0, 12), additionalData: enc.encode(topic) },
      salon.cle,
      copie.subarray(12),
    );
    return JSON.parse(dec.decode(clair));
  } catch {
    return null;
  }
}

export function idAleatoire(octets = 8): string {
  return hex(crypto.getRandomValues(new Uint8Array(octets)));
}
