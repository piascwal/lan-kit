# Relais TURN : la solution pour plus tard

Le jeu en ligne de `lan-kit` n'utilise aujourd'hui **que du pair à pair** (STUN public) :
aucun serveur à vous, aucun compte. Environ 15 à 20 % des connexions ne passent pas en
direct (4G avec NAT strict, Wi-Fi d'entreprise ou d'école) ; le jeu affiche alors
« connexion impossible, essayez un autre réseau ».

Si des joueurs se retrouvent bloqués, un **relais TURN** règle le problème : le trafic
(toujours chiffré de bout en bout par DTLS, le relais ne lit rien) transite par lui, et il
masque aussi l'adresse IP des joueurs entre eux.

## Ce que le kit sait déjà faire

`Liaison` accepte des serveurs ICE supplémentaires :

```ts
new Liaison(false, [], { enLigne: true, serveursIce: [{ urls: 'turn:…', username, credential }] });
```

Il suffit donc de lui fournir une liste. Rien d'autre à changer dans le kit.

## Où trouver un TURN

| Option                                    | Coût                    | À savoir                                                                     |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| **Cloudflare Realtime TURN** (recommandé) | palier gratuit généreux | demande un compte ; les identifiants se génèrent par appel d'API authentifié |
| TURN public sans compte                   | gratuit                 | peu fiable, sans garantie, débit limité : à éviter                           |
| `coturn` sur un petit serveur             | quelques euros par mois | un serveur à entretenir                                                      |

## Le point délicat : ne jamais embarquer le secret

Les identifiants TURN permanents mis dans la page seraient publics : n'importe qui pourrait
utiliser le relais à vos frais. La bonne pratique est d'émettre des **identifiants à durée
courte** (quelques heures) :

1. Un petit **Cloudflare Worker** (gratuit, pas un serveur à héberger) détient le secret.
2. Le jeu l'appelle à la création ou à l'entrée dans un salon ; il renvoie `{ urls, username, credential }` valables quelques heures.
3. Le jeu passe cette liste à `Liaison` (`serveursIce`).

Précautions : limiter les origines autorisées (CORS sur votre domaine GitHub Pages),
limiter le débit par IP, et choisir une durée de validité courte.

## Quand s'en occuper

Quand des retours de joueurs montrent des échecs de connexion en ligne. En attendant, rien
à faire : l'ajout est local à l'écran de connexion de chaque jeu.
