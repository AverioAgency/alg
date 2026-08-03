import { z } from "zod"
import { TargetTypeSchema } from "./target.js"

export const AddressSchema = z.object({
  street: z.string().nullable().optional(),
  house_number: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  /** ISO 3166-1 alpha-2, uppercase. */
  country: z.string().length(2).nullable().optional(),
})

export type Address = z.infer<typeof AddressSchema>

export const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})

export type GeoPoint = z.infer<typeof GeoPointSchema>

/**
 * What a discovery adapter emits before normalization and dedupe. Deliberately
 * loose: adapters differ wildly in what they can supply. `raw` keeps the untouched
 * source payload so we can re-normalize later without re-fetching.
 */
export const RawEntitySchema = z.object({
  /** Adapter id that produced this, e.g. "overpass". */
  source: z.string().min(1),
  /** Stable id within that source, if it has one (place_id, OSM id, WKO number). */
  sourceId: z.string().min(1).nullable().optional(),
  targetType: TargetTypeSchema,
  name: z.string().min(1),
  address: AddressSchema.nullable().optional(),
  geo: GeoPointSchema.nullable().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  /** Source-specific category strings, unmapped. */
  categories: z.array(z.string()).optional(),
  /** Untouched source payload for later re-normalization. */
  raw: z.record(z.string(), z.unknown()).optional(),
})

export type RawEntity = z.infer<typeof RawEntitySchema>

/**
 * A persisted, deduplicated entity. Signal providers read this and write back
 * into the signals map.
 */
export const EntitySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  targetType: TargetTypeSchema,
  name: z.string(),
  domain: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  address: AddressSchema.nullable().optional(),
  geo: GeoPointSchema.nullable().optional(),
  /**
   * Flattened signal space, keyed by dotted path ("web.presence.has_website").
   * Populated on demand by the providers the planner selected - absent keys mean
   * "not computed", not "false".
   */
  signals: z.record(z.string(), z.unknown()).default({}),
})

export type Entity = z.infer<typeof EntitySchema>

export const ContactSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  companyId: z.uuid().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
})

export type Contact = z.infer<typeof ContactSchema>

/** An entity plus the contact it will be reached through, as channels see it. */
export const LeadSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  company: EntitySchema,
  contact: ContactSchema.nullable().optional(),
  score: z.number().nullable().optional(),
})

export type Lead = z.infer<typeof LeadSchema>
