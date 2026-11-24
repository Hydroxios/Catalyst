/** Erreur attendue d'une étape : son message est affiché tel quel à l'utilisateur. */
export class StepError extends Error {}

/** Le déploiement a été annulé (nouveau commit ou demande explicite). */
export class CancelledError extends Error {
  constructor(public readonly reason: 'superseded' | 'cancelled' | 'shutdown') {
    super(
      reason === 'superseded'
        ? 'superseded by a newer commit'
        : reason === 'shutdown'
          ? 'platform shutdown'
          : 'cancelled',
    );
  }
}
