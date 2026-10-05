/**
 * lan-kit : le socle réseau des jeux Wi-Fi de piascwal (Face-Off, Bandeja...).
 * Un appareil hôte fait office de serveur ; les autres le trouvent sur le même
 * Wi-Fi sans saisir d'adresse. Rien de spécifique à un jeu ici : les messages,
 * l'état de la partie et les sièges restent dans chaque jeu.
 */
export { COURTIERS } from './courtiers';
export type { OptionsLiaison } from './liaison';
export { Annuaire, TEXTE_SUR, valideAnnonce, valideSignal } from './annuaire';
export type { Annonce, OptionsAnnuaire, Signal, ValideContenu } from './annuaire';
export { codeDuLien, genereCode, lienInvitation, normaliseCode, salonEnLigne } from './en-ligne';
export { nettoiePseudo, qualitePing, texteLatence } from './joueur';
export type { QualitePing } from './joueur';
export { Liaison, adressePrivee, candidatLocal, filtreSdpLocal } from './liaison';
export { Limiteur } from './limiteur';
export { ClientMqtt, LecteurMqtt, PAQUET_MQTT_MAX } from './mqtt';
export { chiffre, dechiffre, idAleatoire, salonPour } from './reseau-local';
export type { AppLan, Salon } from './reseau-local';
export { salonsDuReseau } from './reseau';
export type { ReseauDetecte } from './reseau';
export { Veille, attente } from './veille';
export type { MsgVeille } from './veille';
