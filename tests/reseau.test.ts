import { describe, expect, it } from 'vitest';
import { Annuaire, TEXTE_SUR, valideAnnonce, valideSignal, type ValideContenu } from '../src/annuaire';
import {
  correspond,
  encodeLongueur,
  LecteurMqtt,
  lisPublish,
  MQTT_PUBLISH,
  paquetPublish,
} from '../src/mqtt';
import { adresseSrflx, chiffre, cleReseau, dechiffre, salonPour, type AppLan } from '../src/reseau-local';

const FACEOFF: AppLan = { id: 'face-off', version: 23 };
const BANDEJA: AppLan = { id: 'bandeja', version: 1 };

describe('MQTT minimal', () => {
  it('encode la longueur restante sur 1 à 4 octets', () => {
    expect(encodeLongueur(0)).toEqual([0]);
    expect(encodeLongueur(127)).toEqual([127]);
    expect(encodeLongueur(128)).toEqual([0x80, 1]);
    expect(encodeLongueur(16383)).toEqual([0xff, 0x7f]);
    expect(encodeLongueur(16384)).toEqual([0x80, 0x80, 1]);
  });

  it('recolle des paquets coupés arbitrairement entre trames', () => {
    const charge = new Uint8Array(300).map((_, i) => i & 0xff);
    const a = paquetPublish('jeu/v1/abc/parties/1234', charge, true);
    const b = paquetPublish('x/y', new Uint8Array([1, 2, 3]), false);
    const flux = new Uint8Array(a.length + b.length);
    flux.set(a);
    flux.set(b, a.length);
    const l = new LecteurMqtt();
    const recus = [
      ...l.pousse(flux.slice(0, 5)),
      ...l.pousse(flux.slice(5, 200)),
      ...l.pousse(flux.slice(200)),
    ];
    expect(recus).toHaveLength(2);
    expect(recus[0]!.type).toBe(MQTT_PUBLISH);
    const m = lisPublish(recus[0]!);
    expect(m.topic).toBe('jeu/v1/abc/parties/1234');
    expect(m.retain).toBe(true);
    expect([...m.payload]).toEqual([...charge]);
    expect(lisPublish(recus[1]!).payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('applique les jokers de filtre', () => {
    expect(correspond('a/+/c', 'a/b/c')).toBe(true);
    expect(correspond('a/+/c', 'a/b/d')).toBe(false);
    expect(correspond('a/#', 'a/b/c')).toBe(true);
    expect(correspond('a/+', 'a/b/c')).toBe(false);
  });
});

describe('empreinte du réseau local', () => {
  it('lit l’adresse publique des seuls candidats srflx', () => {
    expect(
      adresseSrflx(
        'candidate:842163049 1 udp 1677729535 203.0.113.7 51234 typ srflx raddr 192.168.1.20 rport 51234',
      ),
    ).toBe('203.0.113.7');
    expect(adresseSrflx('candidate:1 1 udp 2122260223 abcd.local 51234 typ host')).toBeNull();
  });

  it('regroupe l’IPv4 publique telle quelle et l’IPv6 par préfixe /64', () => {
    expect(cleReseau('203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(cleReseau('2a01:e0a:1f:2c40:1111:2222:3333:4444')).toBe(cleReseau('2a01:e0a:1f:2c40::9'));
    expect(cleReseau('2a01:e0a:1f:2c40::9')).toBe('ip6:2a01:e0a:1f:2c40');
    expect(cleReseau('abcd.local')).toBeNull();
  });

  it('chiffre les messages : illisibles depuis un autre réseau ou un autre topic', async () => {
    const ici = await salonPour(FACEOFF, 'ip4:203.0.113.7');
    const ailleurs = await salonPour(FACEOFF, 'ip4:198.51.100.9');
    expect(ici.base).not.toContain('203');
    expect(ici.base).not.toBe(ailleurs.base);
    const topic = `${ici.base}/parties/0123456789abcdef`;
    const c = await chiffre(ici, topic, { nom: 'LYNX 12' });
    expect(await dechiffre(ici, topic, c)).toEqual({ nom: 'LYNX 12' });
    expect(await dechiffre(ailleurs, topic, c)).toBeNull();
    expect(await dechiffre(ici, `${ici.base}/parties/fedcba9876543210`, c)).toBeNull();
    c[20] ^= 1;
    expect(await dechiffre(ici, topic, c)).toBeNull();
  });

  it('deux jeux, ou deux versions de protocole, ne se voient jamais sur le même Wi-Fi', async () => {
    const reseau = 'ip4:203.0.113.7';
    const fo = await salonPour(FACEOFF, reseau);
    const bj = await salonPour(BANDEJA, reseau);
    const fo2 = await salonPour({ ...FACEOFF, version: 24 }, reseau);
    expect(new Set([fo.base, bj.base, fo2.base]).size).toBe(3);
    expect(bj.base.startsWith('bandeja/v1/')).toBe(true);
    // la clé aussi diffère : une annonce de l'un est illisible pour l'autre
    const topic = `${bj.base}/parties/0123456789abcdef`;
    const c = await chiffre(bj, topic, { x: 1 });
    expect(await dechiffre(fo, topic, c)).toBeNull();
  });
});

describe('annonces et signaux reçus', () => {
  interface Contenu {
    nom: string;
    score: [number, number];
  }
  const valide: ValideContenu<Contenu> = (o) => {
    if (typeof o.nom !== 'string' || !TEXTE_SUR.test(o.nom)) return null;
    const sc = o.score;
    if (!Array.isArray(sc) || sc.length !== 2 || !sc.every((x) => Number.isInteger(x) && x >= 0 && x < 100))
      return null;
    return { nom: o.nom, score: [sc[0] as number, sc[1] as number] };
  };
  const ok = { id: '0123456789abcdef', nom: 'LYNX 12', score: [2, 1], v: 1, t: 1 };

  it('valide les champs communs puis le contenu du jeu', () => {
    expect(valideAnnonce(ok, ok.id, 3, valide)).toEqual({
      nom: 'LYNX 12',
      score: [2, 1],
      id: ok.id,
      v: 1,
      t: 1,
      salon: 3,
    });
    expect(valideAnnonce(ok, 'fedcba9876543210', 0, valide)).toBeNull(); // le topic ne correspond pas
    expect(valideAnnonce({ ...ok, id: 'nope' }, 'nope', 0, valide)).toBeNull();
    expect(valideAnnonce({ ...ok, t: Infinity }, ok.id, 0, valide)).toBeNull();
    expect(valideAnnonce({ ...ok, v: 'x' }, ok.id, 0, valide)).toBeNull();
    expect(valideAnnonce({ ...ok, nom: '<script>' }, ok.id, 0, valide)).toBeNull();
    expect(valideAnnonce({ ...ok, score: [1, -3] }, ok.id, 0, valide)).toBeNull();
    expect(valideAnnonce(null, ok.id, 0, valide)).toBeNull();
  });

  it('n’expose que ce que le validateur du jeu a retenu', () => {
    const a = valideAnnonce({ ...ok, pirate: 'x'.repeat(10_000) }, ok.id, 0, valide);
    expect(a).not.toHaveProperty('pirate');
  });

  it('valide les signaux de connexion', () => {
    expect(valideSignal({ type: 'offre', sdp: 'x'.repeat(20_000), nom: 'A' })).toBeNull();
    expect(valideSignal({ type: 'refus', raison: 'complet' })).toEqual({ type: 'refus', raison: 'complet' });
    expect(valideSignal({ type: 'refus', raison: 'spectateurs' })).toEqual({
      type: 'refus',
      raison: 'spectateurs',
    });
    expect(valideSignal({ type: 'refus', raison: 'autre' })).toBeNull();
    expect(valideSignal({ type: 'offre', sdp: 'x', nom: 'A', spect: true })).toEqual({
      type: 'offre',
      sdp: 'x',
      nom: 'A',
      spect: true,
    });
    expect(valideSignal({ type: 'offre', sdp: 'x', nom: 'A', spect: 'oui' })).toMatchObject({ spect: false });
    expect(valideSignal({ type: 'offre', sdp: 'x', nom: '<b>' })).toBeNull();
  });

  it('un annuaire se construit avec l’identité du jeu et son validateur', async () => {
    const salon = await salonPour(BANDEJA, 'dev:test');
    const a = new Annuaire<Contenu>({ app: BANDEJA, salons: [salon], valideContenu: valide, courtiers: [] });
    expect(a.app).toBe(BANDEJA);
    expect(a.nbConnectes).toBe(0);
    await expect(a.ouvre()).rejects.toThrow();
  });
});
