import { z } from "zod"
import { type Lead } from "./entities.js"

export const ChannelCapabilitiesSchema = z.object({
  threading: z.boolean(),
  tracking: z.boolean(),
  attachments: z.boolean(),
})

export type ChannelCapabilities = z.infer<typeof ChannelCapabilitiesSchema>

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  /** i18n keys, never pre-rendered German strings. */
  reasonKeys: z.array(z.string()).default([]),
})

export type ValidationResult = z.infer<typeof ValidationResultSchema>

export const RenderedMessageSchema = z.object({
  leadId: z.uuid(),
  workspaceId: z.uuid(),
  channelId: z.string().min(1),
  to: z.string().min(1),
  from: z.string().min(1),
  subject: z.string().nullable().optional(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable().optional(),
  /** RFC 5322 Message-ID of the message being replied to, for threading. */
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).optional(),
  attachmentFileIds: z.array(z.uuid()).optional(),
})

export type RenderedMessage = z.infer<typeof RenderedMessageSchema>

export const SendResultSchema = z.object({
  ok: z.boolean(),
  /** Provider-side id (SMTP Message-ID, Twilio SID). */
  externalId: z.string().nullable().optional(),
  sentAt: z.iso.datetime().nullable().optional(),
  error: z.string().nullable().optional(),
})

export type SendResult = z.infer<typeof SendResultSchema>

export const InboundMessageSchema = z.object({
  channelId: z.string().min(1),
  externalId: z.string().min(1),
  from: z.string(),
  to: z.string(),
  subject: z.string().nullable().optional(),
  bodyText: z.string(),
  receivedAt: z.iso.datetime(),
  /** Threading is resolved via these, never via subject matching. */
  messageId: z.string().nullable().optional(),
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).optional(),
})

export type InboundMessage = z.infer<typeof InboundMessageSchema>

export interface ChannelAdapter {
  id: string
  capabilities: ChannelCapabilities
  validate(lead: Lead): Promise<ValidationResult>
  send(msg: RenderedMessage): Promise<SendResult>
  poll?(): Promise<InboundMessage[]>
}
