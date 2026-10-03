# lan-kit — notes pour Claude

Lire le README avant toute modification.

- Rien de spécifique à un jeu ici : si un type ou une constante vient de Face-Off ou de Bandeja, il reste dans le jeu et le kit reçoit un paramètre (voir `AppLan`, `valideContenu`).
- Avant de proposer un changement : `npm run typecheck && npm run lint && npm run format:check && npm test`.
- Aucun fichier au-delà de 300 lignes de code. Tout en français.
- Une modification qui casse l'API ou le format des salons : nouvelle étiquette `v0.x.0`, et prévenir que les jeux doivent mettre à jour leur dépendance.
