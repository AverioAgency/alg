export {
  type FileStorage,
  type PutInput,
  FileNotFoundError,
  StorageLimitExceededError,
} from "./storage/file-storage.js"
export { LocalFileStorage, type LocalFileStorageOptions } from "./storage/local-file-storage.js"
export {
  buildRelativePath,
  resolveWithinRoot,
  mimeForExt,
  UnsafePathError,
  MIME_BY_EXT,
} from "./storage/paths.js"
export {
  signFileToken,
  verifyFileToken,
  InvalidTokenError,
  type SignedFileToken,
} from "./storage/signing.js"
export { runStorageCleanup, type CleanupReport, type CleanupOptions } from "./storage/cleanup.js"
export {
  assertSendingEnabled,
  isSendingEnabled,
  SendingDisabledError,
  type SendingGuardOptions,
} from "./sending/kill-switch.js"
export {
  safeFetch,
  assertPublicHost,
  isBlockedAddress,
  SsrfBlockedError,
  ResponseTooLargeError,
  type SafeFetchOptions,
  type SafeResponse,
} from "./http/safe-fetch.js"
export {
  normalizeDomain,
  normalizePhone,
  normalizeCompanyName,
  normalizeCountryCode,
  normalizePostalCode,
  normalizeEmail,
  normalizeWebsite,
  cleanString,
} from "./discovery/normalize.js"
export {
  findDuplicate,
  dedupeBatch,
  toDedupeCandidate,
  trigramSimilarity,
  trigrams,
  DEFAULT_TRIGRAM_THRESHOLD,
  type DedupeCandidate,
  type DedupeMatch,
  type DedupeStage,
} from "./discovery/dedupe.js"
export {
  DiscoveryRegistry,
  UnknownAdapterError,
  type AdapterSelection,
} from "./discovery/registry.js"
export { evaluateFilter, haversineMetres, type EvalOptions } from "./discovery/filter-eval.js"
