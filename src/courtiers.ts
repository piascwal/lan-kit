/**
 * Serveurs publics MQTT (sur WebSocket chiffré) utilisés comme simple boîte
 * aux lettres pour la découverte. Aucun n'est à nous et aucun n'est
 * indispensable : on se connecte à tous en parallèle, on publie sur tous et
 * on dédoublonne à la réception — la découverte marche tant qu'au moins un
 * répond. Ils ne voient passer que des messages chiffrés (voir reseau-local).
 *
 * Module sans dépendance : la politique de sécurité du contenu (CSP, voir
 * vite.config.ts) n'autorise les connexions qu'à ces serveurs.
 */
export const COURTIERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
