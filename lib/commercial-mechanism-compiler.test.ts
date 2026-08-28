import { describe, it, expect } from 'vitest'
import {
  compilePercentageOfBasisFee,
  compileRollingBandMigration,
  compileExecutableCommercialMechanisms,
} from './commercial-mechanism-compiler'
import { applyExtractionSafetyNets } from './contract-extractor'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import type { AdditionalRecurringFee, ContractTerms, UnsupportedCommercialMechanism } from './types'

// A minimal, valid two-band schedule covering [0,100) plus an open-ended
// top band — deliberately small (not the real 21-row Remembill table) so
// these unit tests exercise the compiler's own logic, not
// validateRateSchedule's (already covered by lib/rate-schedule.test.ts).
const MINI_BANDS = [
  { from: 0, to: 50, rate_pct: 1 },
  { from: 50, to: null, rate_pct: 2 },
]

function performanceShareFee(overrides: Partial<AdditionalRecurringFee> = {}): AdditionalRecurringFee {
  return {
    fee_label: 'Performance share',
    amount: 0,
    description: null,
    unresolved_kind: 'unsupported_semantics',
    derived_metric: {
      metric_name: 'value_weighted_payment_rate',
      formula: 'paid_invoice_value / total_invoice_value_of_issued_requests',
      raw_inputs: ['paid_invoice_value', 'total_invoice_value_in_payment_requests'],
      operation: 'ratio',
      numerator_input_key: 'paid_invoice_value',
      denominator_input_key: 'total_invoice_value_in_payment_requests',
    },
    required_operational_inputs: ['total_invoice_value_of_payment_requests'],
    charge_basis_input_key: 'total_invoice_value_of_payment_requests',
    rate_schedule_bands: MINI_BANDS,
    ...overrides,
  }
}

describe('compilePercentageOfBasisFee — Step 17C.3a item B/C', () => {
  it('compiles a fully-shaped extracted fee (explicit operands) into an executable PercentageOfBasisConfig', () => {
    const config = compilePercentageOfBasisFee(performanceShareFee())
    expect(config).toEqual({
      derived_metric: {
        metric_key: 'value_weighted_payment_rate',
        operation: 'ratio',
        numerator_input_key: 'paid_invoice_value',
        denominator_input_key: 'total_invoice_value_of_issued_requests',
        output_unit: 'percentage',
        min_output_value: 0,
        max_output_value: 100,
      },
      rate_schedule: {
        schedule_key: 'value_weighted_payment_rate_schedule',
        bands: MINI_BANDS,
        min_selector_value: 0,
        max_selector_value: 100,
      },
      basis_input_key: 'total_invoice_value_of_issued_requests',
    })
  })

  it('fails closed when unresolved_kind is not unsupported_semantics (nothing to compile)', () => {
    expect(compilePercentageOfBasisFee(performanceShareFee({ unresolved_kind: null }))).toBeNull()
  })

  it('fails closed when derived_metric is missing', () => {
    expect(compilePercentageOfBasisFee(performanceShareFee({ derived_metric: null }))).toBeNull()
  })

  describe('item B — operand direction must be explicit, never inferred from raw_inputs order', () => {
    it('fails closed when operation is not explicitly "ratio"', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          raw_inputs: ['paid_invoice_value', 'total_invoice_value_in_payment_requests'],
          operation: null,
          numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_in_payment_requests',
        },
      }))).toBeNull()
    })

    it('fails closed when numerator_input_key is missing, even though raw_inputs[0] looks like the numerator', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          raw_inputs: ['paid_invoice_value', 'total_invoice_value_in_payment_requests'],
          operation: 'ratio',
          numerator_input_key: null, denominator_input_key: 'total_invoice_value_in_payment_requests',
        },
      }))).toBeNull()
    })

    it('fails closed when denominator_input_key is missing', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          raw_inputs: ['paid_invoice_value', 'total_invoice_value_in_payment_requests'],
          operation: 'ratio',
          numerator_input_key: 'paid_invoice_value', denominator_input_key: null,
        },
      }))).toBeNull()
    })

    it('compiles correctly regardless of raw_inputs array order, since order is never read as authority — only the explicit numerator/denominator fields are', () => {
      const config = compilePercentageOfBasisFee(performanceShareFee({
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          // Reversed order vs. the "expected" numerator-first convention.
          raw_inputs: ['total_invoice_value_in_payment_requests', 'paid_invoice_value'],
          operation: 'ratio',
          numerator_input_key: 'paid_invoice_value',
          denominator_input_key: 'total_invoice_value_in_payment_requests',
        },
      }))
      expect(config?.derived_metric.numerator_input_key).toBe('paid_invoice_value')
      expect(config?.derived_metric.denominator_input_key).toBe('total_invoice_value_of_issued_requests')
    })

    it('fails closed when numerator_input_key names something not present in raw_inputs at all (inconsistent extraction)', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          raw_inputs: ['total_invoice_value_in_payment_requests'], // paid_invoice_value not listed
          operation: 'ratio',
          numerator_input_key: 'paid_invoice_value',
          denominator_input_key: 'total_invoice_value_in_payment_requests',
        },
      }))).toBeNull()
    })
  })

  describe('item C — explicit charge basis and full rate-schedule validation', () => {
    it('fails closed when charge_basis_input_key is missing (never inferred from required_operational_inputs length)', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({ charge_basis_input_key: null }))).toBeNull()
    })

    it('fails closed when rate_schedule_bands is absent (no explicit numeric table extracted)', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({ rate_schedule_bands: null }))).toBeNull()
    })

    it('fails closed when rate_schedule_bands has a gap (fails validateRateSchedule)', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        rate_schedule_bands: [{ from: 0, to: 40, rate_pct: 1 }, { from: 50, to: null, rate_pct: 2 }],
      }))).toBeNull()
    })

    it('fails closed when rate_schedule_bands overlaps', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        rate_schedule_bands: [{ from: 0, to: 60, rate_pct: 1 }, { from: 50, to: null, rate_pct: 2 }],
      }))).toBeNull()
    })

    it('fails closed when rate_schedule_bands does not start at the 0% floor (bad selector bounds)', () => {
      expect(compilePercentageOfBasisFee(performanceShareFee({
        rate_schedule_bands: [{ from: 10, to: 50, rate_pct: 1 }, { from: 50, to: null, rate_pct: 2 }],
      }))).toBeNull()
    })
  })
})

function rollingMechanism(overrides: Partial<UnsupportedCommercialMechanism> = {}): UnsupportedCommercialMechanism {
  return {
    kind: 'rolling_volume_pricing_transition',
    description: 'Rolling three-month average band migration',
    execution_status: 'unsupported',
    required_operational_inputs: ['issued_payment_request_count'],
    rolling_input_key: 'issued_payment_request_count',
    rolling_window_count: 3,
    notice_required: true,
    ...overrides,
  }
}

describe('compileRollingBandMigration — Step 17C.3a item D', () => {
  it('compiles a fully-shaped extracted mechanism into an executable RollingBandMigrationConfig', () => {
    expect(compileRollingBandMigration(rollingMechanism())).toEqual({
      aggregate: {
        input_key: 'issued_payment_request_count',
        window_count: 3,
        window_unit: 'billing_period',
        operation: 'mean',
        require_complete_windows: true,
      },
      trigger_comparator: 'greater_than',
      compared_to: 'contracted_volume',
      notice_required: true,
    })
  })

  it('never sets effective_rule or volume_transition_rule', () => {
    const config = compileRollingBandMigration(rollingMechanism())!
    expect(config).not.toHaveProperty('effective_rule')
    expect(config).not.toHaveProperty('volume_transition_rule')
  })

  it('fails closed when already executable (nothing to do)', () => {
    expect(compileRollingBandMigration(rollingMechanism({ execution_status: 'executable' }))).toBeNull()
  })

  it('does NOT compile merely because `kind` looks like a rolling-average mechanism — explicit fields are still required', () => {
    expect(compileRollingBandMigration(rollingMechanism({
      kind: 'rolling_volume_pricing_transition',
      rolling_input_key: null,
      rolling_window_count: null,
      notice_required: null,
    }))).toBeNull()
  })

  it('an unrelated/misleading `kind` string does not block compilation when the explicit fields are all present', () => {
    expect(compileRollingBandMigration(rollingMechanism({ kind: 'some_other_label' }))).not.toBeNull()
  })

  it('fails closed when rolling_input_key is missing (never inferred from required_operational_inputs)', () => {
    expect(compileRollingBandMigration(rollingMechanism({ rolling_input_key: null }))).toBeNull()
  })

  it('fails closed when rolling_window_count is missing or not a positive integer', () => {
    expect(compileRollingBandMigration(rollingMechanism({ rolling_window_count: null }))).toBeNull()
    expect(compileRollingBandMigration(rollingMechanism({ rolling_window_count: 0 }))).toBeNull()
    expect(compileRollingBandMigration(rollingMechanism({ rolling_window_count: 2.5 }))).toBeNull()
  })

  it('fails closed when notice_required is not stated', () => {
    expect(compileRollingBandMigration(rollingMechanism({ notice_required: null }))).toBeNull()
  })
})

describe('compileExecutableCommercialMechanisms — full pass', () => {
  it('leaves an already-compiled fixture (percentage_of_basis + rolling_band_migration already present) unchanged', () => {
    const fixture = buildRemembillFixtureTerms()
    const out = compileExecutableCommercialMechanisms(fixture)
    expect(out).toEqual(fixture)
  })

  it('compiles both mechanisms on a fresh raw extraction and clears the Unsupported-card gates', () => {
    const terms = { ...buildRemembillFixtureTerms() } as ContractTerms

    terms.additional_recurring_fees = [performanceShareFee({ percentage_of_basis: null })]
    terms.unsupported_commercial_mechanisms = [rollingMechanism({ rolling_band_migration: null })]

    const out = compileExecutableCommercialMechanisms(terms)

    const fee = out.additional_recurring_fees![0]
    expect(fee.unresolved_kind).toBeNull()
    expect(fee.percentage_of_basis).toBeTruthy()

    const mechanism = out.unsupported_commercial_mechanisms![0]
    expect(mechanism.execution_status).toBe('executable')
    expect(mechanism.rolling_band_migration).toBeTruthy()
  })
})

describe('applyExtractionSafetyNets — Step 17C.3a end-to-end, item E fresh-upload regression', () => {
  it('a fresh raw extraction (including the literal total_invoice_value_in_payment_requests paraphrase) compiles both mechanisms and the Unsupported card is absent for both', () => {
    const base = buildRemembillFixtureTerms()
    const terms: ContractTerms = {
      ...base,
      additional_recurring_fees: [
        base.additional_recurring_fees![0], // Per payment request fee (unchanged, ordinary per-unit shape)
        base.additional_recurring_fees![1], // Success fee (unchanged, ordinary per-unit shape)
        performanceShareFee({ percentage_of_basis: null }),
      ],
      unsupported_commercial_mechanisms: [rollingMechanism({ rolling_band_migration: null })],
    }

    const out = applyExtractionSafetyNets(terms)

    const fee = out.additional_recurring_fees!.find(f => f.fee_label === 'Performance share')!
    // Mirrors app/(dashboard)/configure/[id]/page.tsx's own filter:
    // unsupportedFees = fees.filter(f => f.unresolved_kind === 'unsupported_semantics')
    expect(fee.unresolved_kind).not.toBe('unsupported_semantics')
    expect(fee.percentage_of_basis).toBeTruthy()
    expect(fee.percentage_of_basis!.basis_input_key).toBe('total_invoice_value_of_issued_requests')
    expect(fee.percentage_of_basis!.derived_metric.numerator_input_key).toBe('paid_invoice_value')
    expect(fee.percentage_of_basis!.derived_metric.denominator_input_key).toBe('total_invoice_value_of_issued_requests')
    // Original extracted wording is preserved, unrewritten, for display/provenance.
    expect(fee.required_operational_inputs).toEqual(['total_invoice_value_of_payment_requests'])
    expect(fee.derived_metric!.raw_inputs).toEqual(['paid_invoice_value', 'total_invoice_value_in_payment_requests'])

    const mechanism = out.unsupported_commercial_mechanisms![0]
    // Mirrors page.tsx's own filter:
    // unsupportedMechanisms = mechanisms.filter(m => m.execution_status !== 'executable')
    expect(mechanism.execution_status).toBe('executable')
    expect(mechanism.rolling_band_migration).toBeTruthy()
    expect(mechanism.rolling_band_migration!.aggregate.input_key).toBe('issued_payment_request_count')
  })

  it('reversed/missing operands keep the fee Unsupported', () => {
    const terms = {
      ...buildRemembillFixtureTerms(),
      additional_recurring_fees: [performanceShareFee({
        percentage_of_basis: null,
        derived_metric: {
          metric_name: 'value_weighted_payment_rate', formula: 'a / b',
          raw_inputs: ['paid_invoice_value', 'total_invoice_value_in_payment_requests'],
          operation: 'ratio',
          numerator_input_key: null, // missing — direction not stated
          denominator_input_key: 'total_invoice_value_in_payment_requests',
        },
      })],
    } as ContractTerms

    const out = applyExtractionSafetyNets(terms)
    const fee = out.additional_recurring_fees![0]
    expect(fee.unresolved_kind).toBe('unsupported_semantics')
    expect(fee.percentage_of_basis).toBeFalsy()
  })

  it('an incomplete/invalid rate table keeps the fee Unsupported', () => {
    const terms = {
      ...buildRemembillFixtureTerms(),
      additional_recurring_fees: [performanceShareFee({
        percentage_of_basis: null,
        rate_schedule_bands: [{ from: 0, to: 40, rate_pct: 1 }, { from: 50, to: null, rate_pct: 2 }], // gap
      })],
    } as ContractTerms

    const out = applyExtractionSafetyNets(terms)
    const fee = out.additional_recurring_fees![0]
    expect(fee.unresolved_kind).toBe('unsupported_semantics')
    expect(fee.percentage_of_basis).toBeFalsy()
  })

  it('incomplete rolling semantics keep the mechanism Unsupported', () => {
    const terms = {
      ...buildRemembillFixtureTerms(),
      unsupported_commercial_mechanisms: [rollingMechanism({ rolling_band_migration: null, rolling_window_count: null })],
    } as ContractTerms

    const out = applyExtractionSafetyNets(terms)
    const mechanism = out.unsupported_commercial_mechanisms![0]
    expect(mechanism.execution_status).toBe('unsupported')
    expect(mechanism.rolling_band_migration).toBeFalsy()
  })

  it('preserves the Unsupported fallback exactly when a required structured field was never extracted at all (fail closed)', () => {
    const base = buildRemembillFixtureTerms()
    const terms: ContractTerms = {
      ...base,
      additional_recurring_fees: [performanceShareFee({ percentage_of_basis: null, rate_schedule_bands: null })],
      unsupported_commercial_mechanisms: [rollingMechanism({ rolling_band_migration: null, rolling_window_count: null })],
    }

    const out = applyExtractionSafetyNets(terms)

    const fee = out.additional_recurring_fees![0]
    expect(fee.unresolved_kind).toBe('unsupported_semantics')
    expect(fee.percentage_of_basis).toBeFalsy()

    const mechanism = out.unsupported_commercial_mechanisms![0]
    expect(mechanism.execution_status).toBe('unsupported')
    expect(mechanism.rolling_band_migration).toBeFalsy()
  })
})
