# lan-kit

Le socle réseau des jeux Wi-Fi de piascwal ([Face-Off](https://github.com/piascwal/face-off),
[Bandeja](https://github.com/piascwal/bandeja)) : **un appareil héberge, les autres le trouvent
sur le même Wi-Fi, sans saisir d'adresse IP**, sans aucun serveur à déployer.

Ce paquet ne contient **rien de spécifique à un jeu** : ni messages, ni état de partie, ni
sièges. Chaque jeu garde son protocole et sa logique ; `lan-kit` ne fait que mettre en relation
des appareils et leur donner un canal sûr.

## Ce qu'il fait

Une page web ne peut ni ouvrir de port d'écoute, ni faire de broadcast, ni utiliser mDNS. D'où
le montage (détaillé dans le README de Face-Off) :

| Besoin                                         | Moyen                                                                                                                                   | Module                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Trouver les appareils du même Wi-Fi            | l'adresse publique de la box (vue par STUN) donne un nom de salon et une clé AES-GCM, sans jamais être publiée                          | `reseau-local`, `reseau`        |
| Une boîte aux lettres pour la mise en relation | trois serveurs MQTT publics en parallèle (annonces retenues, testament de l'hôte)                                                       | `mqtt`, `courtiers`, `annuaire` |
| Le jeu en direct                               | liaison WebRTC pair à pair (deux canaux : fiable pour le salon, sans retransmission pour les instantanés), limitée aux adresses locales | `liaison`                       |
| Se protéger d'un appareil bavard               | seau à jetons par appareil                                                                                                              | `limiteur`                      |
| Savoir si le pair est vivant                   | ping/pong, latence, coupure après 6 s de silence                                                                                        | `veille`                        |

## Utiliser

Dépendance Git, **figée sur une étiquette** : une correction ici ne change rien à un jeu tant
qu'il n'a pas mis à jour sa dépendance.

```bash
npm install github:piascwal/lan-kit#v0.1.0
```

Le paquet est livré en **TypeScript source** (pas de compilation) : le Vite du jeu le compile.

```ts
import { Annuaire, salonsDuReseau, Liaison, Veille, type AppLan } from '@piascwal/lan-kit';

// l'identité du jeu : deux jeux, ou deux versions du protocole, ne se voient jamais
const APP: AppLan = { id: 'bandeja', version: 1 };

const { salons, ipsPubliques } = await salonsDuReseau(APP);

// l'hôte annonce sa partie ; chaque jeu valide le contenu des annonces reçues
const annuaire = new Annuaire<MonAnnonce>({
  app: APP,
  salons,
  valideContenu: valideMonAnnonce,
  testament: true,
});
await annuaire.ouvre();
annuaire.annonce({ nom: 'LYNX 12', format: 'coop' /* ... */ });
```

`valideContenu` reçoit l'objet déchiffré et renvoie le contenu nettoyé, ou `null`. Tout ce qui
vient du réseau est suspect, même chiffré : c'est au jeu de borner ses propres champs.

## Sécurité (ce que le kit garantit)

- Annonces et offres chiffrées (AES-GCM) avec une clé dérivée du réseau ; le topic sert de
  donnée authentifiée (un message ne peut pas être rejoué ailleurs).
- Liaisons **limitées au réseau local** : seuls les candidats `host` privés ou mDNS, ou un
  candidat qui sort par notre propre box, sont acceptés. Jamais de relais.
- Paquets MQTT plafonnés à 64 Ko dès l'en-tête ; débit limité par appareil.
- Tout le trafic de jeu est chiffré par DTLS (WebRTC).

Limites connues : un Wi-Fi « invités » qui isole les appareils, ou un réseau qui bloque STUN,
empêche la liaison ; le jeu par Internet est volontairement impossible.

## Développer

```bash
npm install
npm run typecheck && npm run lint && npm run format:check && npm test
```

- Aucun fichier au-delà de 300 lignes de code (ESLint `max-lines`).
- Toute modification de comportement s'accompagne d'un test ; un changement **incompatible**
  (signature, format de salon) donne une nouvelle version mineure (0.x) et une étiquette.
- Les jeux fixent une version : `v0.1.0` → tag `v0.1.0`.

## Licence

Apache-2.0, voir [LICENSE](LICENSE).
