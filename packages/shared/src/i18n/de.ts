/**
 * User-visible German strings. Handlers reference keys only - never inline German
 * text - so the frontend can override or translate without a backend change.
 */
export const de = {
  "error.validation-failed": "Die Anfrage ist ungültig.",
  "error.unauthenticated": "Nicht angemeldet.",
  "error.forbidden": "Kein Zugriff auf diese Ressource.",
  "error.workspace-required": "Kein Workspace ausgewählt.",
  "error.not-found": "Nicht gefunden.",
  "error.conflict": "Konflikt mit dem aktuellen Zustand.",
  "error.idempotency-key-reused":
    "Dieser Idempotency-Key wurde bereits mit einem anderen Request verwendet.",
  "error.rate-limited": "Zu viele Anfragen. Bitte später erneut versuchen.",
  "error.payload-too-large": "Die Anfrage ist zu groß.",
  "error.unsupported-media-type": "Nicht unterstütztes Format.",
  "error.sending-disabled": "Der Versand ist systemweit deaktiviert.",
  "error.storage-limit-exceeded": "Das Speicherlimit ist erreicht.",
  "error.storage-object-missing": "Die Datei ist nicht mehr vorhanden.",
  "error.invalid-signed-token": "Der Link ist ungültig oder abgelaufen.",
  "error.upstream-unavailable": "Ein externer Dienst ist nicht erreichbar.",
  "error.budget-exceeded": "Das Monatsbudget ist ausgeschöpft.",
  "error.internal-error": "Ein interner Fehler ist aufgetreten.",

  "health.ok": "Betriebsbereit",
  "health.degraded": "Eingeschränkt betriebsbereit",
  "health.down": "Nicht betriebsbereit",
} as const

export type I18nKey = keyof typeof de

export const DEFAULT_LOCALE = "de" as const

/**
 * Resolves a key to German, falling back to the key itself when unknown - a
 * missing translation should surface as a visible key, not an empty string.
 */
const messages: Readonly<Record<string, string>> = de

export function t(key: string): string {
  return messages[key] ?? key
}
