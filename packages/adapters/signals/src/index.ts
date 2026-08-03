export { createWebPresenceProvider, type WebPresenceOptions } from "./web-presence/provider.js"
export {
  createLegalImpressumProvider,
  type LegalImpressumOptions,
} from "./legal-impressum/provider.js"
export {
  extractImpressum,
  findImpressumLinks,
  htmlToText,
  IMPRESSUM_PATHS,
  type ImpressumData,
} from "./legal-impressum/extract.js"
export { createWebTechstackProvider, type WebTechstackOptions } from "./web-techstack/provider.js"
export {
  detectTech,
  detectFeatures,
  SIGNATURES,
  type TechDetection,
  type FeatureDetection,
} from "./web-techstack/detect.js"
export { createContactBasicProvider } from "./contact-basic/provider.js"
export { buildSignalRegistry, type SignalRegistryOptions } from "./registry.js"
