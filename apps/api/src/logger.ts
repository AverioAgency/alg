import pino, { type Logger } from "pino"

/**
 * Redaction paths. ALG processes contact data for a living, so the default has to
 * be "nothing personal reaches a log line". Add a path here before adding a field
 * that could carry one - Sentry inherits the same redacted objects.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-supabase-token']",
  /**
   * Der Service-Token ist eine Mandantengrenze, kein Komfortmerkmal.
   *
   * Wer ihn hat, kann fuer jeden Workspace handeln. Er stand im Klartext in
   * jeder Zeile des Request-Logs - pino-http loggt die Header vollstaendig, und
   * die Liste hier kannte nur x-supabase-token. Aufgefallen ist es, als ein
   * Fehlerlog zum Debuggen weitergereicht wurde: damit war das Geheimnis
   * unterwegs. Ein Log wandert weiter als der Prozess, der es schreibt.
   */
  "req.headers['x-alg-service-token']",
  "req.headers['idempotency-key']",
  "res.headers['set-cookie']",
  "*.email",
  "*.phone",
  "*.firstName",
  "*.lastName",
  "*.displayName",
  "*.name",
  "*.password",
  "*.token",
  "*.secret",
  "*.apiKey",
  "*.accessToken",
  "*.refreshToken",
  "email",
  "phone",
  "password",
  "token",
  "secret",
  "contact.email",
  "contact.phone",
  "contact.firstName",
  "contact.lastName",
  "lead.contact",
  "company.email",
  "company.phone",
  "credentials",
  "smtpPassword",
  "authToken",
]

export interface LoggerOptions {
  level: string
  nodeEnv: string
  service: string
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    name: options.service,
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Structured JSON in production; pino-pretty is a dev-only convenience the
    // operator can pipe into, so the process itself stays dependency-free.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: options.service, env: options.nodeEnv },
  })
}

export type { Logger }
