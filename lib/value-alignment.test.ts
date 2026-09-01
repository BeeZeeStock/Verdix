import { describe, it, expect } from 'vitest'
import { isLongFormValue } from './value-alignment'

describe('isLongFormValue — Step 17H.4B0D4H1B4E6.4 (Commercial Logic alignment correction)', () => {
  describe('right-align: numeric amounts, percentages, quantities, dates, short scalar/status values, badges', () => {
    it('a formatted quantity', () => {
      expect(isLongFormValue('1,234')).toBe(false)
    })
    it('a unit range', () => {
      expect(isLongFormValue('0–1,000')).toBe(false)
    })
    it('a percentage', () => {
      expect(isLongFormValue('3.5% annually')).toBe(false)
    })
    it('a date range', () => {
      expect(isLongFormValue('1 Jan 2026 – 31 Dec 2026')).toBe(false)
    })
    it('a short status phrase', () => {
      expect(isLongFormValue('Blocked by upstream decision')).toBe(false)
    })
    it('a short status phrase, alternate', () => {
      expect(isLongFormValue('Ready for invoice')).toBe(false)
    })
    it('a compact rule label with no terminal punctuation', () => {
      expect(isLongFormValue('Charge each api_call')).toBe(false)
    })
    it('a compact formula-style calculation value', () => {
      expect(isLongFormValue('Paid invoice value ÷ Total invoice value')).toBe(false)
    })
    it('a short source-method label', () => {
      expect(isLongFormValue('Source: Manual operational input')).toBe(false)
    })
    it('a badge-length word', () => {
      expect(isLongFormValue('Monthly')).toBe(false)
    })
  })

  describe('left-align: sentences, explanatory copy, calculation descriptions, rule descriptions, provenance text, multi-line values', () => {
    it('a full descriptive sentence', () => {
      expect(isLongFormValue('Average exceeds the contracted volume for this agreement.')).toBe(true)
    })
    it('a short-but-genuine sentence the length check alone would miss', () => {
      expect(isLongFormValue('Calculated after the billing period closes.')).toBe(true)
    })
    it('a rule description with no terminal punctuation but real length', () => {
      expect(isLongFormValue('Additional charge applies above the contracted threshold of 1,000')).toBe(true)
    })
    it('a long calculation/explanatory description', () => {
      expect(isLongFormValue('Usage is measured for the billing period and finalized after the period closes.')).toBe(true)
    })
    it('two sentences of explanatory copy', () => {
      expect(isLongFormValue('Pending recurring fixed-fee timing decision. Invoice transmission remains on hold until this decision is resolved.')).toBe(true)
    })
    it('a multi-line value regardless of per-line length', () => {
      expect(isLongFormValue('Line one\nLine two')).toBe(true)
    })
    it('quoted source/provenance text', () => {
      expect(isLongFormValue('the Customer shall receive a reduction equal to the amount by which actual usage falls short of the committed volume for that period')).toBe(true)
    })
  })

  describe('generic — no per-string special-casing: same structural rule regardless of topic', () => {
    it('two completely different topics with the same shape classify the same way', () => {
      const escalatorRuleDescription = 'The escalation applies at each contract anniversary based on the published index.'
      const creditRuleDescription = 'The credit applies against future invoices until the balance is fully consumed.'
      expect(isLongFormValue(escalatorRuleDescription)).toBe(true)
      expect(isLongFormValue(creditRuleDescription)).toBe(true)
    })
    it('two short scalar values on different topics both stay right-aligned', () => {
      expect(isLongFormValue('SEK 12,000')).toBe(false)
      expect(isLongFormValue('2.0%')).toBe(false)
    })
  })
})
