import { AppError, PROBLEM_TYPES } from "@alg/shared"

/**
 * Global outbound kill switch.
 *
 * Built in M0 rather than alongside the channel adapters in M5 on purpose: the
 * guard has to exist before the first adapter does, otherwise the first one written
 * establishes a pattern of sending without checking. Staging and test keep
 * ALG_SENDING_ENABLED=false, so any accidental send path fails loudly there.
 */

export class SendingDisabledError extends AppError {
  constructor(channelId?: string) {
    super(PROBLEM_TYPES.SENDING_DISABLED, {
      detail: channelId
        ? `Sending is globally disabled (ALG_SENDING_ENABLED=false); channel "${channelId}" refused to send.`
        : "Sending is globally disabled (ALG_SENDING_ENABLED=false).",
    })
    this.name = "SendingDisabledError"
  }
}

export interface SendingGuardOptions {
  enabled: boolean
  /** Dry runs render messages and stop short of dispatch, regardless of the switch. */
  dryRun?: boolean
}

/**
 * Every ChannelAdapter.send() implementation must call this first. There is no
 * bypass parameter by design.
 */
export function assertSendingEnabled(options: SendingGuardOptions, channelId?: string): void {
  if (options.dryRun) {
    throw new SendingDisabledError(channelId)
  }
  if (!options.enabled) {
    throw new SendingDisabledError(channelId)
  }
}

export function isSendingEnabled(options: SendingGuardOptions): boolean {
  return options.enabled && !options.dryRun
}
