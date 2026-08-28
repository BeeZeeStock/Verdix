import { describe, it, expect } from 'vitest'
import { isNotificationChannelMismatch, NOTIFICATION_CHANNEL_MISMATCH_CONFIDENCE_CAP } from './meter-suggestion-guard'

describe('isNotificationChannelMismatch — Step 17C.3b, item B', () => {
  it('flags the real observed false positive: "payment request" matched against an "Invoices Sent" meter', () => {
    expect(isNotificationChannelMismatch('payment request', {
      meter_key: 'invoice', display_name: 'Invoices Sent', unit_label: 'invoices',
    })).toBe(true)
  })

  it('flags a payment/transaction metric matched against every other notification-channel meter in the reported set', () => {
    const meters = [
      { meter_key: 'email', display_name: 'Emails Sent', unit_label: 'emails' },
      { meter_key: 'letter', display_name: 'Letters Sent', unit_label: 'letters' },
      { meter_key: 'reminder', display_name: 'Reminders Sent', unit_label: 'reminders' },
      { meter_key: 'sms', display_name: 'SMS Sent', unit_label: 'messages' },
    ]
    for (const meter of meters) {
      expect(isNotificationChannelMismatch('payment request', meter)).toBe(true)
      expect(isNotificationChannelMismatch('transaction', meter)).toBe(true)
    }
  })

  it('does not flag an unrelated (non-transactional) contract metric against a notification-channel meter', () => {
    // "SMS reminder" as a CONTRACT metric genuinely should match an "SMS"
    // meter — the guard only fires for transactional metrics colliding
    // with a dispatch-channel meter, never blanket-blocks the channel
    // meters themselves from legitimate matches.
    expect(isNotificationChannelMismatch('SMS reminder', {
      meter_key: 'sms', display_name: 'SMS Sent', unit_label: 'messages',
    })).toBe(false)
  })

  it('does not flag a genuinely transactional meter that happens to mention "invoice" without a dispatch qualifier', () => {
    expect(isNotificationChannelMismatch('payment request', {
      meter_key: 'invoice_value', display_name: 'Invoice Payments Processed', unit_label: 'EUR',
    })).toBe(false)
  })

  it('does not flag a transactional metric against a genuinely transactional meter (api_call, transaction)', () => {
    expect(isNotificationChannelMismatch('payment request', {
      meter_key: 'api_call', display_name: 'API Calls', unit_label: 'calls',
    })).toBe(false)
  })

  it('the confidence cap is well below the route\'s own no_match threshold (0.4)', () => {
    expect(NOTIFICATION_CHANNEL_MISMATCH_CONFIDENCE_CAP).toBeLessThan(0.4)
  })
})
