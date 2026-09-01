import { describe, it, expect } from 'vitest'
import { matchUsageComponentTitle, describeLogicStatus, summarizeGroupRowLabels, ruleCategoryFor, sectionizeRows, describeComponentReadiness, describeInvoiceStatus, pluralizeUsageComponentTitle, splitComponentTitle, classifyCommercialCategory, buildComponentMechanismSummary, selectSnapshotRows, looksLikeInternalTestLabel } from './commercial-logic-grouping'

describe('classifyCommercialCategory — Step 17G.6D', () => {
  it('a fixed recurring component is Fixed fee', () => {
    expect(classifyCommercialCategory('fixed')).toBe('Fixed fee')
  })

  it('usage and performance components are both Variable fees — never split into separate top-level categories', () => {
    expect(classifyCommercialCategory('usage')).toBe('Variable fees')
    expect(classifyCommercialCategory('performance')).toBe('Variable fees')
  })

  it('a one-time/project component is its own category', () => {
    expect(classifyCommercialCategory('one_time')).toBe('One-time / project fees')
  })

  it('a credit/rebate component is its own category', () => {
    expect(classifyCommercialCategory('credit')).toBe('Credits & adjustments')
  })
})

describe('matchUsageComponentTitle — Step 17G.5A', () => {
  it('matches a unit_type to its flat fee and runs the label through bomDisplayLabel', () => {
    const fees = [{ fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request' }]
    expect(matchUsageComponentTitle('issued_payment_request', fees)).toBe('Issued payment request')
  })

  it('falls back to a light humanization when no matching fee exists — never a guess', () => {
    expect(matchUsageComponentTitle('sqm_managed', [])).toBe('Sqm managed')
    expect(matchUsageComponentTitle('sqm_managed', null)).toBe('Sqm managed')
  })

  it('picks the fee whose metric_name matches, ignoring unrelated fees', () => {
    const fees = [
      { fee_label: 'Per-completed payment success fee', metric_name: 'completed_payment' },
      { fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request' },
    ]
    expect(matchUsageComponentTitle('completed_payment', fees)).toBe('Completed payment success')
  })
})

describe('describeLogicStatus — Step 17G.5A', () => {
  it('reports complete when nothing is blocked', () => {
    expect(describeLogicStatus(0)).toBe('Logic complete')
  })

  it('reports a singular blocker', () => {
    expect(describeLogicStatus(1)).toBe('Blocked by 1 decision')
  })

  it('reports a plural blocker count', () => {
    expect(describeLogicStatus(3)).toBe('Blocked by 3 decisions')
  })

  it('never reports "Ready to bill" — logic completeness only', () => {
    expect(describeLogicStatus(0)).not.toMatch(/ready to bill/i)
  })
})

describe('summarizeGroupRowLabels — Step 17G.5B', () => {
  it('joins labels under the cap verbatim, dynamically', () => {
    expect(summarizeGroupRowLabels(['Pilot', 'Discount', 'Billing timing'])).toBe('Pilot · Discount · Billing timing')
  })

  it('caps at max and appends a dynamically-computed "+N more"', () => {
    const labels = ['Pilot', 'Discount', 'Partial-period treatment', 'Volume adjustment', 'Billing timing', 'Billing-period treatment']
    expect(summarizeGroupRowLabels(labels, 4)).toBe('Pilot · Discount · Partial-period treatment · Volume adjustment +2 more')
  })

  it('handles an empty list', () => {
    expect(summarizeGroupRowLabels([])).toBe('')
  })

  it('never hard-codes a component name or count — output is a pure function of the input labels', () => {
    const a = summarizeGroupRowLabels(['Charging rule', 'Overage rule'])
    const b = summarizeGroupRowLabels(['Derived measure', 'Charge basis', 'Rate selection'])
    expect(a).toBe('Charging rule · Overage rule')
    expect(b).toBe('Derived measure · Charge basis · Rate selection')
  })
})

describe('ruleCategoryFor — Step 17G.5B / 17G.6A', () => {
  it('groups pilot and discount under Pricing / discount', () => {
    expect(ruleCategoryFor('Pilot')).toBe('Pricing / discount')
    expect(ruleCategoryFor('Discount')).toBe('Pricing / discount')
  })

  it('groups volume adjustment under Pricing adjustment', () => {
    expect(ruleCategoryFor('Volume adjustment')).toBe('Pricing adjustment')
  })

  it('Step 17H.4B0D4H1B4E7.1 §11 — the new "Volume adjustment measurement" detail row still groups under Pricing adjustment, not the unrelated Timing bucket a bare "Measurement" label would land in', () => {
    expect(ruleCategoryFor('Volume adjustment measurement')).toBe('Pricing adjustment')
  })

  it('groups partial-period and billing-period treatment under Period rules', () => {
    expect(ruleCategoryFor('Partial-period treatment')).toBe('Period rules')
    expect(ruleCategoryFor('Billing-period treatment')).toBe('Period rules')
  })

  it('groups timing facts under Timing, using the 17G.6A canonical labels', () => {
    expect(ruleCategoryFor('Recurring fixed-fee timing')).toBe('Timing')
    expect(ruleCategoryFor('Measurement')).toBe('Timing')
    expect(ruleCategoryFor('Invoice timing')).toBe('Timing')
    expect(ruleCategoryFor('Invoice composition')).toBe('Timing')
  })

  it('groups performance-calculation facts under Calculation, using the 17G.6A canonical labels', () => {
    expect(ruleCategoryFor('Derived measure')).toBe('Calculation')
    expect(ruleCategoryFor('Charge basis')).toBe('Calculation')
    expect(ruleCategoryFor('Rate selection')).toBe('Calculation')
    expect(ruleCategoryFor('Calculation')).toBe('Calculation')
  })

  it('groups the usage billing mapping chain (contract measure -> billing metric -> configured source) under Usage billing mapping', () => {
    expect(ruleCategoryFor('Contract measure')).toBe('Usage billing mapping')
    expect(ruleCategoryFor('Billing metric')).toBe('Usage billing mapping')
    expect(ruleCategoryFor('Configured source')).toBe('Usage billing mapping')
  })

  it('groups any required-input row under Required inputs by its value prefix, never by a fixed label list', () => {
    expect(ruleCategoryFor('Paid invoice value', 'Source: Manual operational input')).toBe('Required inputs')
    expect(ruleCategoryFor('Total invoice value of issued requests', 'Source: Manual operational input')).toBe('Required inputs')
    // A genuinely different, future KPI label works too — never hard-coded.
    expect(ruleCategoryFor('Monthly uptime', 'Source: Monitoring API')).toBe('Required inputs')
  })

  it('"Used to calculate" (now usage-only, since 17G.6F moved performance\'s own version to "Calculation flow") always maps to Usage billing mapping', () => {
    expect(ruleCategoryFor('Used to calculate', '• SEK 0.38 per issued payment request')).toBe('Usage billing mapping')
  })

  it('Step 17G.6F, item 5 — "Calculation flow" groups with the rest of the calculation facts', () => {
    expect(ruleCategoryFor('Calculation flow')).toBe('Calculation')
  })

  it('Step 17G.6F, item 8 — "Billing treatment" and "Invoice status" both group under Timing', () => {
    expect(ruleCategoryFor('Billing treatment')).toBe('Timing')
    expect(ruleCategoryFor('Invoice status')).toBe('Timing')
    expect(ruleCategoryFor('Current billing treatment')).toBeNull()
  })

  it('returns null (general bucket) for a label with no clear category — never forces a guess', () => {
    expect(ruleCategoryFor('Charging rule')).toBeNull()
    expect(ruleCategoryFor('Overage rule')).toBeNull()
    expect(ruleCategoryFor('Tier calculation method')).toBeNull()
    expect(ruleCategoryFor('Minimum commitment')).toBeNull()
    expect(ruleCategoryFor('Price escalation')).toBeNull()
    expect(ruleCategoryFor('Some Rebate Description')).toBeNull()
  })
})

describe('sectionizeRows — Step 17G.5B / 17G.6A', () => {
  it('the real Remembill Platform subscription shape sections correctly, general bucket first', () => {
    const rows = [
      { label: 'Pilot' }, { label: 'Discount' }, { label: 'Partial-period treatment' },
      { label: 'Recurring fixed-fee timing' }, { label: 'Volume adjustment' }, { label: 'Billing-period treatment' },
    ]
    const sections = sectionizeRows(rows)
    expect(sections.map(s => s.name)).toEqual(['Pricing / discount', 'Period rules', 'Timing', 'Pricing adjustment'])
  })

  it('an all-general group (usage rules) produces exactly one unnamed section', () => {
    const rows = [{ label: 'Charging rule' }, { label: 'Overage rule' }, { label: 'Measurement' }]
    const sections = sectionizeRows(rows)
    // Measurement IS categorized (Timing); Charging rule/Overage rule are
    // not — so this is two sections, general first.
    expect(sections.map(s => s.name)).toEqual([null, 'Timing'])
    expect(sections[0].rows.map(r => r.label)).toEqual(['Charging rule', 'Overage rule'])
  })

  it('the real Remembill Performance share shape (post-17G.6G): Calculation (incl. Calculation flow), Required inputs, Timing, in order', () => {
    const rows = [
      { label: 'Performance measure' }, { label: 'Calculation' }, { label: 'Charge basis' }, { label: 'Rate selection' },
      { label: 'Calculation flow' },
      { label: 'Paid invoice value', value: 'Source: Manual operational input' },
      { label: 'Total invoice value of issued requests', value: 'Source: Manual operational input' },
      { label: 'Measurement' }, { label: 'Invoice timing' },
    ]
    const sections = sectionizeRows(rows)
    expect(sections.map(s => s.name)).toEqual([null, 'Calculation', 'Required inputs', 'Timing'])
    expect(sections.find(s => s.name === 'Calculation')!.rows.map(r => r.label)).toEqual(['Calculation', 'Charge basis', 'Rate selection', 'Calculation flow'])
    expect(sections.find(s => s.name === 'Required inputs')!.rows.map(r => r.label)).toEqual(['Paid invoice value', 'Total invoice value of issued requests'])
  })

  it('the real Remembill Issued payment requests shape: Usage billing mapping, in order', () => {
    const rows = [
      { label: 'Charging rule' }, { label: 'Overage rule' },
      { label: 'Contract measure' }, { label: 'Billing metric' }, { label: 'Configured source' },
      { label: 'Used to calculate', value: '• SEK 0.38 per issued payment request' },
      { label: 'Measurement' }, { label: 'Current billing treatment' }, { label: 'Invoice composition' },
    ]
    const sections = sectionizeRows(rows)
    expect(sections.map(s => s.name)).toEqual([null, 'Usage billing mapping', 'Timing'])
    expect(sections.find(s => s.name === 'Usage billing mapping')!.rows.map(r => r.label))
      .toEqual(['Contract measure', 'Billing metric', 'Configured source', 'Used to calculate'])
  })

  it('never produces an empty section', () => {
    const rows = [{ label: 'Charging rule' }]
    const sections = sectionizeRows(rows)
    expect(sections.every(s => s.rows.length > 0)).toBe(true)
    expect(sections).toHaveLength(1)
  })

  it('the general bucket always renders first even when its rows appear later in the input', () => {
    const rows = [{ label: 'Pilot' }, { label: 'Price escalation' }]
    const sections = sectionizeRows(rows)
    expect(sections[0].name).toBeNull()
    expect(sections[0].rows.map(r => r.label)).toEqual(['Price escalation'])
  })

  it('handles an empty input', () => {
    expect(sectionizeRows([])).toEqual([])
  })
})

describe('describeComponentReadiness — Step 17G.6A (17G.6F\'s "Billing logic ready" rename reverted in 17G.6G)', () => {
  it('ready when nothing is blocked and no source/input gap exists', () => {
    expect(describeComponentReadiness({ blockedDecisions: 0 })).toEqual({ state: 'ready_for_billing_timeline', label: 'Ready for billing timeline' })
  })

  it('needs commercial decision(s), with a dynamic count', () => {
    expect(describeComponentReadiness({ blockedDecisions: 1 })).toEqual({ state: 'needs_commercial_decision', label: 'Needs 1 commercial decision' })
    expect(describeComponentReadiness({ blockedDecisions: 2 })).toEqual({ state: 'needs_commercial_decision', label: 'Needs 2 commercial decisions' })
  })

  it('needs input source when a usage source is unconfigured and rules are otherwise resolved', () => {
    expect(describeComponentReadiness({ blockedDecisions: 0, hasUnconfiguredSource: true }))
      .toEqual({ state: 'needs_input_source', label: 'Needs input source' })
  })

  it('needs operational input configuration when a required KPI has no input record at all', () => {
    expect(describeComponentReadiness({ blockedDecisions: 0, hasUnconfiguredOperationalInput: true }))
      .toEqual({ state: 'needs_operational_input_configuration', label: 'Needs operational input configuration' })
  })

  it('combines a commercial decision AND a missing source into one distinct state', () => {
    expect(describeComponentReadiness({ blockedDecisions: 1, hasUnconfiguredSource: true }))
      .toEqual({ state: 'needs_commercial_decision_and_input_source', label: 'Needs commercial decision + input source' })
  })

  it('never claims "Ready to bill" or "Invoice ready" — only setup completeness', () => {
    const { label } = describeComponentReadiness({ blockedDecisions: 0 })
    expect(label).not.toMatch(/invoice ready|ready to bill/i)
  })
})

describe('describeInvoiceStatus — Step 17G.6F, items 1/3/4/9', () => {
  it('blocked by an upstream decision', () => {
    expect(describeInvoiceStatus(true)).toEqual({ state: 'blocked_by_upstream_decision', label: 'Blocked by upstream decision' })
  })

  it('ready for invoice once no upstream blocker remains', () => {
    expect(describeInvoiceStatus(false)).toEqual({ state: 'ready_for_invoice', label: 'Ready for invoice' })
  })
})

describe('pluralizeUsageComponentTitle — Step 17G.6B', () => {
  it('the real Remembill case: "Issued payment request" -> "Issued payment requests"', () => {
    expect(pluralizeUsageComponentTitle('Issued payment request')).toBe('Issued payment requests')
  })

  it('leaves an already-plural title untouched', () => {
    expect(pluralizeUsageComponentTitle('Completed payments')).toBe('Completed payments')
  })

  it('pluralizes a trailing word ending in a sibilant with -es', () => {
    expect(pluralizeUsageComponentTitle('Extra charge')).toBe('Extra charges')
    expect(pluralizeUsageComponentTitle('Sms dispatch')).toBe('Sms dispatches')
  })

  it('pluralizes a trailing consonant+y with -ies', () => {
    expect(pluralizeUsageComponentTitle('Delivery')).toBe('Deliveries')
  })

  it('handles a single-word title', () => {
    expect(pluralizeUsageComponentTitle('Seat')).toBe('Seats')
  })

  it('Step 17G.6E, item 1 — the real Remembill case: strips a trailing "success" qualifier before pluralizing, "Completed payment success" -> "Completed payments"', () => {
    expect(pluralizeUsageComponentTitle('Completed payment success')).toBe('Completed payments')
  })

  it('never drops a qualifier word not on the narrow, explicit list — only "success" is recognized, never a generic last-adjective guess', () => {
    expect(pluralizeUsageComponentTitle('Annual support renewal')).toBe('Annual support renewals')
    expect(pluralizeUsageComponentTitle('Premium service')).toBe('Premium services')
  })

  it('a bare "success" alone (no leading words) is never truncated to nothing — the qualifier strip requires a leading word to remain', () => {
    expect(pluralizeUsageComponentTitle('Success')).toBe('Success')
  })
})

describe('splitComponentTitle — Step 17G.6B/17G.6C', () => {
  it('the real Remembill case: splits at the parenthetical, keeping the full original as secondary', () => {
    const title = 'Performance share (resultatdel) — value-weighted payment rate'
    expect(splitComponentTitle(title)).toEqual({ primary: 'Performance share', secondary: title })
  })

  it('leaves a title with no delimiter completely alone', () => {
    expect(splitComponentTitle('Issued payment requests')).toEqual({ primary: 'Issued payment requests', secondary: null })
  })

  it('never splits on a plain hyphen inside a compound word — only parenthesis/em/en-dash', () => {
    expect(splitComponentTitle('Value-added service')).toEqual({ primary: 'Value-added service', secondary: null })
  })

  it('never splits when fewer than two words lead the delimiter — avoids a near-empty primary', () => {
    expect(splitComponentTitle('Fee (see clause 4.2)')).toEqual({ primary: 'Fee (see clause 4.2)', secondary: null })
  })
})

describe('buildComponentMechanismSummary — Step 17H.4B0D4H1B4E7 §2', () => {
  it('joins pricingModelLabel and a lowercased cadence with "billing"', () => {
    expect(buildComponentMechanismSummary({ pricingModelLabel: 'Fixed recurring', billingCadence: 'Monthly' })).toBe('Fixed recurring · monthly billing')
  })

  it('a fixed component with a resolved band table already carries that in pricingModelLabel — never re-added separately', () => {
    expect(buildComponentMechanismSummary({ pricingModelLabel: 'Fixed recurring + volume-band pricing', billingCadence: 'Monthly' }))
      .toBe('Fixed recurring + volume-band pricing · monthly billing')
  })

  it('no cadence known — pricingModelLabel alone, no dangling separator', () => {
    expect(buildComponentMechanismSummary({ pricingModelLabel: 'Usage-based', billingCadence: null })).toBe('Usage-based')
  })

  it('generic across pricing models — usage and performance read the same way, no per-model special-casing', () => {
    expect(buildComponentMechanismSummary({ pricingModelLabel: 'Usage-based', billingCadence: 'Quarterly' })).toBe('Usage-based · quarterly billing')
    expect(buildComponentMechanismSummary({ pricingModelLabel: 'Performance-based', billingCadence: 'Annual' })).toBe('Performance-based · annual billing')
  })
})

describe('selectSnapshotRows — Step 17H.4B0D4H1B4E7 §3', () => {
  it('picks short, scalar-shaped rows as the snapshot and leaves the rest', () => {
    const rows = [
      { key: 'a', label: 'Contracted volume', value: '5,000' },
      { key: 'b', label: 'Selected band', value: '1,501–5,000' },
      { key: 'c', label: 'Charging rule', value: 'Charge each api_call' },
      { key: 'd', label: 'Overage rule', value: 'Additional charge applies above the contracted threshold of 5,000' },
    ]
    const { snapshot, remaining } = selectSnapshotRows(rows)
    expect(snapshot.map(r => r.key)).toEqual(['a', 'b', 'c'])
    expect(remaining.map(r => r.key)).toEqual(['d'])
  })

  it('never includes a decisionRequired row, however short its value text is', () => {
    const rows = [
      { key: 'a', label: 'Contracted volume', value: '5,000' },
      { key: 'b', label: 'Price escalation', value: 'Decision required', decisionRequired: true },
    ]
    const { snapshot, remaining } = selectSnapshotRows(rows)
    expect(snapshot.map(r => r.key)).toEqual(['a'])
    expect(remaining.map(r => r.key)).toEqual(['b'])
  })

  it('caps at max (default 4) even when more short rows are available', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, label: key, value: '100' }))
    const { snapshot, remaining } = selectSnapshotRows(rows)
    expect(snapshot).toHaveLength(4)
    expect(remaining.map(r => r.key)).toEqual(['e'])
  })

  it('never forces exactly four cells — zero, one, or any count of short rows is fine', () => {
    expect(selectSnapshotRows([]).snapshot).toHaveLength(0)
    expect(selectSnapshotRows([{ key: 'a', label: 'Rate selection', value: 'Contractual rate schedule' }]).snapshot).toHaveLength(1)
  })

  it('a row with no label is never a snapshot candidate', () => {
    const rows = [{ key: 'a', label: '', value: '5,000' }]
    const { snapshot, remaining } = selectSnapshotRows(rows)
    expect(snapshot).toHaveLength(0)
    expect(remaining).toHaveLength(1)
  })

  it('generic: the same structural rule applies regardless of topic (fixed-fee vs performance-fee facts)', () => {
    const fixedFeeRows = [{ key: 'a', label: 'Contracted volume', value: '5,000' }]
    const performanceRows = [{ key: 'b', label: 'Performance measure', value: 'Value weighted payment rate' }]
    expect(selectSnapshotRows(fixedFeeRows).snapshot).toHaveLength(1)
    expect(selectSnapshotRows(performanceRows).snapshot).toHaveLength(1)
  })
})

describe('looksLikeInternalTestLabel — Step 17H.4B0D4H1B4E7.1 §9 (reported: "Confirmed via E3.6 acceptance pass" leaking as a reviewer name)', () => {
  it('flags the exact reported shape: a step code followed by "acceptance pass"', () => {
    expect(looksLikeInternalTestLabel('E3.6 acceptance pass')).toBe(true)
  })

  it('flags a bare step-code-shaped prefix on its own', () => {
    expect(looksLikeInternalTestLabel('E5.1')).toBe(true)
    expect(looksLikeInternalTestLabel('E5.1 fixed-fee billing timing')).toBe(true)
  })

  it('flags "acceptance pass"/"acceptance run" even without a leading step code', () => {
    expect(looksLikeInternalTestLabel('acceptance run for discounts')).toBe(true)
    expect(looksLikeInternalTestLabel('final acceptance pass')).toBe(true)
  })

  it('never flags a real person\'s name', () => {
    expect(looksLikeInternalTestLabel('Bilal Zahoor')).toBe(false)
    expect(looksLikeInternalTestLabel('Anna Svensson')).toBe(false)
  })

  it('never flags a real email address', () => {
    expect(looksLikeInternalTestLabel('bilal@verdix.com')).toBe(false)
  })

  it('generic: the same structural rule applies to a hypothetical future step code, not just the reported one', () => {
    expect(looksLikeInternalTestLabel('Q7.2 rollout')).toBe(true)
    expect(looksLikeInternalTestLabel('7Q.2 rollout')).toBe(true)
  })
})
