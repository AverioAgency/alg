/**
 * Fingerprints the technology behind a page.
 *
 * Data-driven rather than hardcoded conditionals: a new CMS is a new entry in
 * this table, not a code change. The signals feed rubrics like "site runs an
 * outdated CMS" or "has no shop system yet" - which ones matter is the user's
 * decision, not ours.
 */

export interface TechSignature {
  name: string
  category: "cms" | "shop" | "analytics" | "builder" | "framework" | "hosting"
  /** Matched against the raw HTML. */
  html?: RegExp[]
  /** Matched against response header values, keyed by lowercase header name. */
  headers?: Record<string, RegExp>
  /** Matched against script/link URLs found in the page. */
  urls?: RegExp[]
}

export const SIGNATURES: TechSignature[] = [
  {
    name: "WordPress",
    category: "cms",
    html: [/wp-content\//i, /wp-includes\//i, /<meta name="generator" content="WordPress/i],
  },
  { name: "TYPO3", category: "cms", html: [/typo3temp\//i, /content="TYPO3/i] },
  { name: "Joomla", category: "cms", html: [/\/media\/jui\//i, /content="Joomla/i] },
  { name: "Drupal", category: "cms", html: [/sites\/all\/(themes|modules)/i, /Drupal\.settings/i] },
  { name: "Contao", category: "cms", html: [/content="Contao/i, /\/files\/contao/i] },
  { name: "Wix", category: "builder", html: [/static\.wixstatic\.com/i, /wix-code/i] },
  {
    name: "Squarespace",
    category: "builder",
    html: [/squarespace\.com/i, /static1\.squarespace/i],
  },
  { name: "Jimdo", category: "builder", html: [/jimdo\.com/i, /jimstatic\.com/i] },
  { name: "Webflow", category: "builder", html: [/webflow\.com/i, /wf-domain/i] },
  { name: "Shopify", category: "shop", html: [/cdn\.shopify\.com/i, /Shopify\.theme/i] },
  { name: "WooCommerce", category: "shop", html: [/woocommerce/i, /wc-ajax/i] },
  { name: "Shopware", category: "shop", html: [/shopware/i, /\/widgets\/checkout/i] },
  { name: "Magento", category: "shop", html: [/Magento_/i, /\/static\/version\d+\/frontend\//i] },
  { name: "PrestaShop", category: "shop", html: [/prestashop/i] },
  {
    name: "Google Analytics",
    category: "analytics",
    html: [/gtag\(/i, /google-analytics\.com\/analytics\.js/i, /googletagmanager\.com\/gtag/i],
  },
  { name: "Google Tag Manager", category: "analytics", html: [/googletagmanager\.com\/gtm\.js/i] },
  { name: "Matomo", category: "analytics", html: [/matomo\.js/i, /piwik\.js/i] },
  { name: "Meta Pixel", category: "analytics", html: [/connect\.facebook\.net\/[^"']*fbevents/i] },
  { name: "React", category: "framework", html: [/__NEXT_DATA__/i, /data-reactroot/i] },
  { name: "Vue", category: "framework", html: [/data-v-[0-9a-f]{8}/i, /__NUXT__/i] },
  { name: "Bootstrap", category: "framework", html: [/bootstrap(?:\.min)?\.css/i] },
  { name: "Cloudflare", category: "hosting", headers: { server: /cloudflare/i } },
]

export interface TechDetection {
  cms: string | null
  shop: string | null
  analytics: string[]
  frameworks: string[]
  builder: string | null
  all: string[]
  /** True when a cookie-setting analytics tag was found - relevant for GDPR. */
  hasTracking: boolean
}

export function detectTech(html: string, headers?: Headers): TechDetection {
  const found = new Set<string>()
  const byCategory = new Map<TechSignature["category"], string[]>()

  for (const signature of SIGNATURES) {
    let matched = false

    if (signature.html?.some((pattern) => pattern.test(html))) matched = true

    if (!matched && signature.headers && headers) {
      for (const [header, pattern] of Object.entries(signature.headers)) {
        const value = headers.get(header)
        if (value && pattern.test(value)) {
          matched = true
          break
        }
      }
    }

    if (matched) {
      found.add(signature.name)
      const list = byCategory.get(signature.category) ?? []
      list.push(signature.name)
      byCategory.set(signature.category, list)
    }
  }

  const analytics = byCategory.get("analytics") ?? []

  return {
    // First match wins: the table is ordered by how specific each signature is.
    cms: byCategory.get("cms")?.[0] ?? null,
    shop: byCategory.get("shop")?.[0] ?? null,
    analytics,
    frameworks: byCategory.get("framework") ?? [],
    builder: byCategory.get("builder")?.[0] ?? null,
    all: [...found],
    hasTracking: analytics.length > 0,
  }
}

/** Feature detection that does not depend on a specific vendor. */
export interface FeatureDetection {
  hasContactForm: boolean
  hasCookieBanner: boolean
  hasSsl: boolean
  hasViewportMeta: boolean
  hasOpenGraph: boolean
  hasStructuredData: boolean
  hasSocialLinks: string[]
}

export function detectFeatures(html: string, finalUrl: string): FeatureDetection {
  const socials: string[] = []
  for (const [name, pattern] of Object.entries({
    facebook: /facebook\.com\/(?!sharer|plugins)/i,
    instagram: /instagram\.com\//i,
    linkedin: /linkedin\.com\/(company|in)\//i,
    youtube: /youtube\.com\/(channel|c|user|@)/i,
    tiktok: /tiktok\.com\/@/i,
  })) {
    if (pattern.test(html)) socials.push(name)
  }

  return {
    hasContactForm: /<form[^>]*>[\s\S]*?(email|e-mail|nachricht|message|kontakt)/i.test(html),
    hasCookieBanner:
      /(cookie[-\s]?(banner|consent|notice)|cookiebot|usercentrics|klaro|borlabs)/i.test(html),
    hasSsl: finalUrl.startsWith("https://"),
    hasViewportMeta: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasOpenGraph: /<meta[^>]+property=["']og:/i.test(html),
    hasStructuredData: /application\/ld\+json/i.test(html),
    hasSocialLinks: socials,
  }
}
