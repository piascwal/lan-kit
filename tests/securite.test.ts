import { describe, expect, it } from 'vitest';
import { adressePrivee, candidatLocal, filtreSdpLocal } from '../src/liaison';
import { Limiteur } from '../src/limiteur';
import { LecteurMqtt, PAQUET_MQTT_MAX } from '../src/mqtt';

const c = (adresse: string, typ = 'host', transport = 'udp') =>
  `a=candidate:842163049 1 ${transport} 1677729535 ${adresse} 54321 typ ${typ} generation 0`;

describe('liaison WebRTC limitée au réseau local', () => {
  it('garde les candidats host sur une adresse privée ou un nom mDNS', () => {
    for (const a of [
      '192.168.1.20',
      '10.0.0.7',
      '172.16.4.2',
      '172.31.255.1',
      '169.254.3.3',
      '2b8f4f5a-1c3d-4e5f-9a0b-c1d2e3f4a5b6.local',
      'fd12:3456::1',
      'fe80::1c2b',
      '127.0.0.1',
    ]) {
      expect(candidatLocal(c(a)), a).toBe(true);
    }
    expect(candidatLocal(c('192.168.1.20', 'host', 'tcp'))).toBe(true);
  });

  it('refuse les adresses publiques, même en host (IPv4 publique, IPv6 globale, plage 100.64 des opérateurs)', () => {
    for (const a of [
      '82.64.12.9',
      '192.0.2.2',
      '172.32.0.1',
      '100.64.1.1',
      '2a01:e0a:1f::5',
      '8.8.8.8',
      'exemple.com',
    ]) {
      expect(candidatLocal(c(a)), a).toBe(false);
    }
  });

  it('refuse tout candidat vu depuis Internet ou relayé (srflx, prflx, relay)', () => {
    for (const typ of ['srflx', 'prflx', 'relay']) expect(candidatLocal(c('192.168.1.20', typ))).toBe(false);
    expect(candidatLocal('a=candidate:1 1 udp 1 192.168.1.2 5000')).toBe(false);
  });

  it('en secours, un candidat srflx n’est accepté que s’il sort par notre propre box', () => {
    const nous = ['82.64.12.9'];
    expect(candidatLocal(c('82.64.12.9', 'srflx'), true, nous)).toBe(true);
    expect(candidatLocal(c('90.1.2.3', 'srflx'), true, nous)).toBe(false);
    expect(candidatLocal(c('82.64.12.9', 'srflx'))).toBe(false);
    expect(candidatLocal(c('82.64.12.9', 'relay'), true, nous)).toBe(false);
    expect(filtreSdpLocal([c('82.64.12.9', 'srflx'), c('90.1.2.3', 'srflx')].join('\r\n'), true, nous)).toBe(
      c('82.64.12.9', 'srflx'),
    );
  });

  it('hors plage stricte (développement), seule la règle « host » reste', () => {
    expect(candidatLocal(c('192.0.2.2'), false)).toBe(true);
    expect(candidatLocal(c('192.0.2.2', 'srflx'), false)).toBe(false);
  });

  it('filtre une description SDP sans toucher au reste', () => {
    const sdp = [
      'v=0',
      'a=fingerprint:sha-256 AB:CD',
      c('192.168.1.20'),
      c('82.64.12.9', 'srflx'),
      c('2a01:e0a::5'),
      'a=end-of-candidates',
      '',
    ].join('\r\n');
    const f = filtreSdpLocal(sdp);
    expect(f).toContain('192.168.1.20');
    expect(f).not.toContain('82.64.12.9');
    expect(f).not.toContain('2a01:e0a::5');
    expect(f).toContain('a=fingerprint:sha-256 AB:CD');
    expect(f).toContain('a=end-of-candidates');
  });

  it('reconnaît les plages privées aux bornes', () => {
    expect(adressePrivee('172.15.0.1')).toBe(false);
    expect(adressePrivee('172.16.0.1')).toBe(true);
    expect(adressePrivee('192.169.0.1')).toBe(false);
    expect(adressePrivee('fc00::1')).toBe(true);
    expect(adressePrivee('fec0::1')).toBe(false);
  });
});

describe('limiteur de débit par appareil', () => {
  it('laisse passer une rafale, puis le débit moyen seulement', () => {
    const l = new Limiteur(20, 40, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (l.accepte(0)) ok++;
    expect(ok).toBe(40);
    // une seconde plus tard : 20 jetons de plus, pas davantage
    ok = 0;
    for (let i = 0; i < 100; i++) if (l.accepte(1)) ok++;
    expect(ok).toBe(20);
  });

  it('un usage normal (actions, réactions, ping) n’est jamais bridé', () => {
    const l = new Limiteur(20, 40, 0);
    for (let t = 0; t < 10; t += 0.1) expect(l.accepte(t)).toBe(true);
  });

  it('le seau ne déborde pas après une longue pause', () => {
    const l = new Limiteur(20, 40, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (l.accepte(3600)) ok++;
    expect(ok).toBe(40);
  });
});

describe('lecteur MQTT : taille des paquets plafonnée', () => {
  /** En-tête PUBLISH avec la longueur restante `n` encodée en MQTT. */
  const entete = (n: number) => {
    const o = [0x30];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      o.push(b);
    } while (n > 0);
    return new Uint8Array(o);
  };

  it('accepte un paquet normal, découpé en plusieurs trames', () => {
    const l = new LecteurMqtt();
    const corps = new Uint8Array(1000).fill(7);
    expect(l.pousse(entete(1000))).toEqual([]);
    expect(l.pousse(corps.subarray(0, 400))).toEqual([]);
    const p = l.pousse(corps.subarray(400));
    expect(p).toHaveLength(1);
    expect(p[0]!.corps.length).toBe(1000);
  });

  it('refuse dès l’en-tête un paquet plus gros que le plafond (sans attendre ni stocker le corps)', () => {
    const l = new LecteurMqtt();
    expect(() => l.pousse(entete(PAQUET_MQTT_MAX + 1))).toThrow();
    expect(() => new LecteurMqtt().pousse(entete(PAQUET_MQTT_MAX))).not.toThrow();
  });
});
