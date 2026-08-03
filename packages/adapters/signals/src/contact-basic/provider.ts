import {
  type Entity,
  type RunContext,
  type SignalBundle,
  type SignalDef,
  type SignalProvider,
  type TargetType,
} from "@alg/shared"
import { normalizeEmail, normalizePhone } from "@alg/core"

/**
 * Consolidates the contact data ALG has, from whichever source supplied it.
 *
 * Makes no request of its own: discovery already brought a phone number from OSM
 * or Places, and legal.impressum may have found a better one. This provider
 * decides which to use and says where it came from, so a message can be sent
 * without every consumer re-implementing that precedence.
 *
 * Impressum data wins over directory data: a company stating its own address is
 * more reliable than a third party recording one.
 */

const PROVIDES: SignalDef[] = [
  {
    key: "contact.basic.email",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.contact.basic.email",
  },
  {
    key: "contact.basic.phone",
    type: "string",
    operators: ["eq", "contains", "exists"],
    labelKey: "signal.contact.basic.phone",
  },
  {
    key: "contact.basic.has_email",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.contact.basic.has_email",
  },
  {
    key: "contact.basic.has_phone",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.contact.basic.has_phone",
  },
  {
    key: "contact.basic.reachable",
    type: "boolean",
    operators: ["eq", "neq", "exists"],
    labelKey: "signal.contact.basic.reachable",
  },
  {
    key: "contact.basic.email_source",
    type: "string",
    operators: ["eq", "in", "exists"],
    labelKey: "signal.contact.basic.email_source",
  },
]

/**
 * Optional: without it the provider works on what discovery supplied.
 * Declared as a dependency so the DAG runs Impressum first when both are needed.
 */
export function createContactBasicProvider(): SignalProvider {
  return {
    id: "contact.basic",
    version: "1.0.0",
    provides: PROVIDES,
    dependsOn: ["legal.impressum"],
    appliesTo: ["local_business", "company", "person"] satisfies TargetType[],
    cost: { unit: "per_entity", amount: 0, currency: "EUR" },
    ttlDays: 30,

    async run(entity: Entity, _ctx: RunContext): Promise<SignalBundle> {
      const signals = entity.signals ?? {}

      const impressumEmail = asString(signals["legal.impressum.email"])
      const impressumPhone = asString(signals["legal.impressum.phone"])

      // Impressum first: the company stating its own contact beats a directory
      // entry someone else created.
      const email = normalizeEmail(impressumEmail) ?? normalizeEmail(entity.email ?? null)
      const emailSource = normalizeEmail(impressumEmail)
        ? "impressum"
        : normalizeEmail(entity.email ?? null)
          ? "discovery"
          : null

      const country = entity.address?.country?.toUpperCase()
      const phoneCountry = country === "DE" || country === "CH" ? country : ("AT" as const)

      const phone =
        normalizePhone(impressumPhone, phoneCountry) ??
        normalizePhone(entity.phone ?? null, phoneCountry)

      return {
        values: {
          "contact.basic.email": email,
          "contact.basic.phone": phone,
          "contact.basic.has_email": email !== null,
          "contact.basic.has_phone": phone !== null,
          "contact.basic.reachable": email !== null || phone !== null,
          "contact.basic.email_source": emailSource,
        },
        provenance: {
          providerId: "contact.basic",
          providerVersion: "1.0.0",
          fetchedAt: new Date().toISOString(),
        },
      }
    },
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
