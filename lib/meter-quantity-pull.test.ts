import { describe, it, expect } from 'vitest'
import { pullMeterQuantity } from './meter-quantity-pull'

// Step 17D, item 11 — this module was extracted verbatim from
// lib/usage-pull.ts's own inline dispatch (see that refactor's own
// commit); these tests cover the branches reachable without a real
// network/DB call (test mode, missing-endpoint skip) — the remembill/
// generic-fetch-success paths are exercised indirectly via
// lib/usage-pull.test.ts's own existing coverage (this codebase has no
// precedent for mocking fetch/supabaseServer in a lib test; DB/network-
// dependent behavior is covered by real-Postgres-gated integration tests
// instead).
describe('pullMeterQuantity — Step 17D, item 11', () => {
  it('test mode substitutes test_usage_value when ignoreTestModeGate is set', async () => {
    const result = await pullMeterQuantity({
      orgId: 'org-1', meterKey: 'issued_payment_request_count',
      def: { pull_endpoint_url: null, pull_auth_token: null, pull_param_name: null, mode: 'test', test_usage_value: 42, connector: null, response_metric_key: null },
      customerId: 'cust-1', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'),
      ignoreTestModeGate: true,
    })
    expect(result).toEqual({ status: 'ok', totalUnits: 42 })
  })

  it('test mode without ignoreTestModeGate skips real overage (never invoices off a test-mode meter)', async () => {
    const result = await pullMeterQuantity({
      orgId: 'org-1', meterKey: 'issued_payment_request_count',
      def: { pull_endpoint_url: null, pull_auth_token: null, pull_param_name: null, mode: 'test', test_usage_value: 42, connector: null, response_metric_key: null },
      customerId: 'cust-1', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'),
    })
    expect(result.status).toBe('skip')
  })

  it('test mode with no test_usage_value configured skips even when ignoreTestModeGate is set', async () => {
    const result = await pullMeterQuantity({
      orgId: 'org-1', meterKey: 'x',
      def: { pull_endpoint_url: null, pull_auth_token: null, pull_param_name: null, mode: 'test', test_usage_value: null, connector: null, response_metric_key: null },
      customerId: 'cust-1', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'),
      ignoreTestModeGate: true,
    })
    expect(result.status).toBe('skip')
  })

  it('generic connector with no pull_endpoint_url configured skips', async () => {
    const result = await pullMeterQuantity({
      orgId: 'org-1', meterKey: 'x',
      def: { pull_endpoint_url: null, pull_auth_token: null, pull_param_name: null, mode: 'live', test_usage_value: null, connector: null, response_metric_key: null },
      customerId: 'cust-1', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'),
    })
    expect(result.status).toBe('skip')
  })

  it('null def (no meter definition found at all) skips', async () => {
    const result = await pullMeterQuantity({
      orgId: 'org-1', meterKey: 'x', def: null,
      customerId: 'cust-1', periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'),
    })
    expect(result.status).toBe('skip')
  })
})
