# lan-kit

Le socle réseau des jeux Wi-Fi de piascwal ([Face-Off](https://github.com/piascwal/face-off),
[Bandeja](https://github.com/piascwal/bandeja)) : **un appareil héberge, les autres le trouvent
sur le même Wi-Fi, sans saisir d'adresse IP, ou par Internet avec un code de salon**, sans aucun serveur à déployer.

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

## Jeu par Internet (depuis 0.2.0)

Toujours **sans serveur à vous** : l'hôte crée un salon et obtient un **code** (`NYXK-4K7P`) ou
un **lien d'invitation** (le code est dans le fragment `#salon=`, jamais envoyé à un serveur).
Les autres le saisissent.

```ts
const code = genereCode(); // l'hôte, à communiquer
const salon = await salonEnLigne(APP, code); // chez tous : même code → même salon et même clé
const annuaire = new Annuaire({ app: APP, salons: [salon], valideContenu, testament: true });
// ... puis comme sur le Wi-Fi ; la liaison accepte les candidats publics :
const liaison = new Liaison(false, [], { enLigne: true });
```

- Le code dérive (PBKDF2, 210 000 itérations) la clé AES-GCM et le nom du salon : les serveurs
  MQTT publics ne voient que du chiffré, et un essai de code coûte un calcul lent.
- 31 symboles sans ambiguïté (ni 0, O, 1, I, L), 8 par code : près de 40 bits.
- Tout le trafic de jeu reste chiffré de bout en bout (DTLS).
- **Exposition :** chaque joueur voit l'adresse IP des autres (inhérent au pair à pair). Les
  réseaux qui bloquent le pair à pair (environ 15 à 20 %) demandent un relais TURN : voir
  [docs/TURN.md](docs/TURN.md), déjà prévu (`serveursIce`).
- `Veille` accepte un silence toléré plus long (3e paramètre) ; `nettoiePseudo`, `qualitePing`
  et `texteLatence` aident les jeux à afficher pseudos et pings.

## Utiliser

Dépendance Git, **figée sur une étiquette** : une correction ici ne change rien à un jeu tant
qu'il n'a pas mis à jour sa dépendance.

```bash
npm install github:piascwal/lan-kit#v0.2.0
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
empêche la liaison ; le jeu par Internet passe par un code de salon (voir plus haut).

## Développer

```bash
npm install
npm run typecheck && npm run lint && npm run format:check && npm test
```

- Aucun fichier au-delà de 300 lignes de code (ESLint `max-lines`).
- Toute modification de comportement s'accompagne d'un test ; un changement **incompatible**
  (signature, format de salon) donne une nouvelle version mineure (0.x) et une étiquette.
- Les jeux fixent une version : `v0.2.0` → tag `v0.2.0`.

## Licence

Apache-2.0, voir [LICENSE](LICENSE).
