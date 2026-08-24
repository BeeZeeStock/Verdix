// Human-readable labels for BillabilityEventType (lib/types.ts), shared so
// every surface that lets a reviewer record/display operational-event
// evidence — the Review drawer's one-time-fee card and the Parked Invoices
// card — uses the exact same wording. Deliberately generic across all five
// supported event types (never hardcoded to customer_acceptance alone),
// even though Contract B's Integration Fee only exercises that one member.
import type { BillabilityEventType } from './types'

export const EVIDENCE_ACTION_LABELS: Record<BillabilityEventType, string> = {
  contract_signature:     'Record signature',
  delivery:                'Record delivery',
  customer_acceptance:     'Record acceptance',
  final_acceptance:        'Record final acceptance',
  change_order_signature:  'Record change order signature',
}

export const EVIDENCE_RECORDED_LABELS: Record<BillabilityEventType, string> = {
  contract_signature:     'Contract signature recorded',
  delivery:                'Delivery recorded',
  customer_acceptance:     'Customer acceptance recorded',
  final_acceptance:        'Final acceptance recorded',
  change_order_signature:  'Change order signature recorded',
}

export const EVIDENCE_WAITING_LABELS: Record<BillabilityEventType, string> = {
  contract_signature:     'Waiting for contract signature',
  delivery:                'Waiting for delivery',
  customer_acceptance:     'Waiting for customer acceptance',
  final_acceptance:        'Waiting for final acceptance',
  change_order_signature:  'Waiting for change order signature',
}
