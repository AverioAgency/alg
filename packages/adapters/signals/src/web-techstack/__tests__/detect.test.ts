import { describe, expect, it } from "vitest"
import { detectFeatures, detectTech } from "../detect.js"

/**
 * Fingerprints are matched against markup real sites emit. The point of these
 * tests is that a signature keeps matching what it was written for, and does not
 * quietly start matching everything.
 */

describe("detectTech", () => {
  it("detects WordPress from its asset paths", () => {
    const html = '<link href="/wp-content/themes/x/style.css"><script src="/wp-includes/js/a.js">'
    expect(detectTech(html).cms).toBe("WordPress")
  })

  it("detects WooCommerce alongside WordPress", () => {
    const html = '<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">'
    const tech = detectTech(html)

    expect(tech.cms).toBe("WordPress")
    expect(tech.shop).toBe("WooCommerce")
  })

  it("detects the common site builders", () => {
    expect(detectTech('<script src="https://static.wixstatic.com/x.js">').builder).toBe("Wix")
    expect(detectTech('<link href="https://static1.squarespace.com/a.css">').builder).toBe(
      "Squarespace"
    )
    expect(detectTech('<script src="https://assets.jimstatic.com/x.js">').builder).toBe("Jimdo")
  })

  it("detects shop systems", () => {
    expect(detectTech('<script src="https://cdn.shopify.com/s/x.js">').shop).toBe("Shopify")
    expect(detectTech('<div class="shopware-slider">').shop).toBe("Shopware")
  })

  it("collects analytics tags and flags tracking", () => {
    // Relevant for GDPR reporting, not just curiosity.
    const html = `
      <script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>
      <script>gtag('config','G-X')</script>
      <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
    `
    const tech = detectTech(html)

    expect(tech.analytics).toContain("Google Analytics")
    expect(tech.analytics).toContain("Meta Pixel")
    expect(tech.hasTracking).toBe(true)
  })

  it("reports no tracking when there is none", () => {
    expect(detectTech("<html><body><p>Statische Seite</p></body></html>").hasTracking).toBe(false)
  })

  it("reads a header-based signature", () => {
    const headers = new Headers({ server: "cloudflare" })
    expect(detectTech("<html></html>", headers).all).toContain("Cloudflare")
  })

  it("returns nulls for a plain page rather than guessing", () => {
    const tech = detectTech("<html><body><h1>Hallo</h1></body></html>")

    expect(tech.cms).toBeNull()
    expect(tech.shop).toBeNull()
    expect(tech.all).toStrictEqual([])
  })

  it("handles empty input", () => {
    expect(() => detectTech("")).not.toThrow()
  })
})

describe("detectFeatures", () => {
  it("detects a contact form", () => {
    const html = '<form action="/kontakt"><input name="email"><textarea name="nachricht">'
    expect(detectFeatures(html, "https://x.at").hasContactForm).toBe(true)
  })

  it("does not call a search box a contact form", () => {
    const html = '<form action="/suche"><input name="q" placeholder="Suchen"></form>'
    expect(detectFeatures(html, "https://x.at").hasContactForm).toBe(false)
  })

  it("detects the usual cookie banners", () => {
    for (const html of [
      '<div class="cookie-banner">',
      '<script src="https://consent.cookiebot.com/x.js">',
      '<script src="https://app.usercentrics.eu/x.js">',
    ]) {
      expect(detectFeatures(html, "https://x.at").hasCookieBanner, html).toBe(true)
    }
  })

  it("reads mobile readiness from the viewport meta tag", () => {
    const withMeta = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    expect(detectFeatures(withMeta, "https://x.at").hasViewportMeta).toBe(true)
    expect(detectFeatures("<html></html>", "https://x.at").hasViewportMeta).toBe(false)
  })

  it("takes SSL from the final URL, not from the markup", () => {
    expect(detectFeatures("", "https://x.at").hasSsl).toBe(true)
    expect(detectFeatures("", "http://x.at").hasSsl).toBe(false)
  })

  it("collects social profile links", () => {
    const html = `
      <a href="https://www.facebook.com/musterfirma">FB</a>
      <a href="https://www.instagram.com/musterfirma/">IG</a>
      <a href="https://at.linkedin.com/company/musterfirma">LI</a>
    `
    const features = detectFeatures(html, "https://x.at")

    expect(features.hasSocialLinks).toContain("facebook")
    expect(features.hasSocialLinks).toContain("instagram")
    expect(features.hasSocialLinks).toContain("linkedin")
  })

  it("does not count a share button as a profile link", () => {
    const html = '<a href="https://www.facebook.com/sharer/sharer.php?u=x">Teilen</a>'
    expect(detectFeatures(html, "https://x.at").hasSocialLinks).not.toContain("facebook")
  })

  it("detects structured data", () => {
    const html = '<script type="application/ld+json">{"@type":"LocalBusiness"}</script>'
    expect(detectFeatures(html, "https://x.at").hasStructuredData).toBe(true)
  })
})
