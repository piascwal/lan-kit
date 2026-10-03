/**
 * Seau à jetons : un appareil peut envoyer en moyenne `debit` messages par
 * seconde, et jusqu'à `rafale` d'un coup. Au-delà, les messages sont ignorés :
 * un pair malveillant (ou bogué) ne peut pas saturer l'hôte, ni, à travers
 * lui, tous les autres appareils (chaque action provoque une diffusion).
 */
export class Limiteur {
  private jetons: number;
  private dernier: number;

  constructor(
    private readonly debit: number,
    private readonly rafale: number,
    maintenant = performance.now() / 1000,
  ) {
    this.jetons = rafale;
    this.dernier = maintenant;
  }

  /** Le message est-il dans le budget ? (consomme un jeton si oui) */
  accepte(maintenant = performance.now() / 1000): boolean {
    this.jetons = Math.min(this.rafale, this.jetons + Math.max(0, maintenant - this.dernier) * this.debit);
    this.dernier = maintenant;
    if (this.jetons < 1) return false;
    this.jetons -= 1;
    return true;
  }
}
