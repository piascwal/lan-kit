import { describe, expect, it } from 'vitest';
import { chiffre, dechiffre } from '../src/reseau-local';
import { codeDuLien, genereCode, lienInvitation, normaliseCode, salonEnLigne } from '../src/en-ligne';
import { nettoiePseudo, qualitePing, texteLatence } from '../src/joueur';

const APP = { id: 'bandeja', version: 1 };

describe('code de salon', () => {
  it('se génère au bon format, sans caractères ambigus, et varie', () => {
    const codes = new Set(Array.from({ length: 200 }, genereCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });

  it('se saisit sans souci de casse, d’espaces ni de tiret', () => {
    expect(normaliseCode('kynx 4k7p')).toBe('KYNX-4K7P');
    expect(normaliseCode(' kynx4k7p ')).toBe('KYNX-4K7P');
    expect(normaliseCode('KYNX-4K7')).toBeNull();
    expect(normaliseCode('KYNX-4K7O')).toBeNull();
    expect(normaliseCode('KYNX-4K7P-X')).toBeNull();
    expect(normaliseCode('')).toBeNull();
  });

  it('passe par un lien d’invitation, dans le fragment', () => {
    const lien = lienInvitation('https://exemple.fr/jeu/?x=1#autre', 'KYNX-4K7P');
    expect(lien).toBe('https://exemple.fr/jeu/?x=1#salon=KYNX-4K7P');
    expect(codeDuLien(new URL(lien).hash)).toBe('KYNX-4K7P');
    expect(codeDuLien('#salon=nimporte')).toBeNull();
    expect(codeDuLien('#salon=%E0%A4%A')).toBeNull();
    expect(codeDuLien('')).toBeNull();
  });
});

describe('salon en ligne', () => {
  it('est le même pour le même code, quelle que soit la saisie', async () => {
    const a = await salonEnLigne(APP, 'KYNX-4K7P');
    const b = await salonEnLigne(APP, 'kynx 4k7p');
    expect(a.base).toBe(b.base);
    const msg = await chiffre(a, 't', { x: 1 });
    expect(await dechiffre(b, 't', msg)).toEqual({ x: 1 });
  });

  it('ne révèle pas le code, et sépare codes, jeux et versions', async () => {
    const a = await salonEnLigne(APP, 'KYNX-4K7P');
    expect(a.base).not.toContain('KYNX');
    expect(a.base).toMatch(/^bandeja\/v1\/ligne\/[0-9a-f]{32}$/);
    const autre = await salonEnLigne(APP, 'KYNX-4K7Q');
    const autreJeu = await salonEnLigne({ id: 'face-off', version: 1 }, 'KYNX-4K7P');
    const autreVersion = await salonEnLigne({ id: 'bandeja', version: 2 }, 'KYNX-4K7P');
    expect(new Set([a.base, autre.base, autreJeu.base, autreVersion.base]).size).toBe(4);
    // un autre code ne lit rien
    const msg = await chiffre(a, 't', { x: 1 });
    expect(await dechiffre(autre, 't', msg)).toBeNull();
    expect(await dechiffre(autreJeu, 't', msg)).toBeNull();
  });

  it('refuse un code invalide', async () => {
    await expect(salonEnLigne(APP, 'nimporte quoi')).rejects.toThrow('code');
  });
});

describe('pseudo et ping', () => {
  it('nettoie un pseudo pour le réseau', () => {
    expect(nettoiePseudo('Élodie_99!')).toBe('ELODIE99');
    expect(nettoiePseudo('  a   b  ')).toBe('A B');
    expect(nettoiePseudo('ABCDEFGHIJKLMNOPQRS')).toBe('ABCDEFGHIJKLMN');
    expect(nettoiePseudo('😀😀', 'MOI')).toBe('MOI');
    expect(nettoiePseudo('')).toBe('JOUEUR');
  });

  it('classe et affiche le ping', () => {
    expect(qualitePing(20)).toBe('bon');
    expect(qualitePing(100)).toBe('moyen');
    expect(qualitePing(400)).toBe('mauvais');
    expect(qualitePing(null)).toBe('inconnu');
    expect(texteLatence(41.6)).toBe('42 ms');
    expect(texteLatence(null)).toBe('--');
  });
});

describe('liaison en ligne', () => {
  const SDP = [
    'a=candidate:1 1 udp 1 192.168.1.5 5000 typ host',
    'a=candidate:2 1 udp 1 82.64.12.9 5000 typ srflx',
    'a=fingerprint:sha-256 AA',
  ].join('\r\n');

  async function liaison(enLigne: boolean) {
    const configs: RTCConfiguration[] = [];
    const recu: string[] = [];
    class PcFactice {
      connectionState = 'new';
      iceGatheringState = 'complete';
      localDescription = { sdp: SDP };
      remoteDescription = null;
      constructor(c: RTCConfiguration) {
        configs.push(c);
      }
      createDataChannel() {
        return { readyState: 'connecting', addEventListener() {} };
      }
      async setRemoteDescription(d: { sdp: string }) {
        recu.push(d.sdp);
      }
      async createOffer() {
        return {};
      }
      async setLocalDescription() {}
    }
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = PcFactice;
    const { Liaison } = await import('../src/liaison');
    const l = new Liaison(true, [], { enLigne, serveursIce: [{ urls: 'turn:exemple.fr' }] });
    const offre = await l.creeOffre();
    await l.accepteReponse(SDP);
    return { configs, offre, recu };
  }

  it('garde tous les candidats et ajoute STUN et relais', async () => {
    const { configs, offre, recu } = await liaison(true);
    expect(offre).toContain('82.64.12.9');
    expect(recu[0]).toContain('82.64.12.9');
    expect(configs[0]!.iceServers!.length).toBe(2);
  });

  it('reste limitée au réseau local quand ce n’est pas en ligne', async () => {
    const { offre, recu } = await liaison(false);
    expect(offre).not.toContain('82.64.12.9');
    expect(recu[0]).not.toContain('82.64.12.9');
    expect(offre).toContain('192.168.1.5');
  });
});
