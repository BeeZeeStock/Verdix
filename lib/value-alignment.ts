// Step 17H.4B0D4H1B4E6.4 — CommercialLogicRow's alignment decision, driven
// entirely by the VALUE's own structural shape, never by which row/label/
// contract it came from (no per-string special-casing anywhere in this
// function or its callers). Three purely structural signals, each
// sufficient on its own:
//  1. A newline present at all — a multi-line value (bullet-style
//     "Used to calculate" lists, etc.) reads as a block, never a
//     right-aligned single line.
//  2. Length past a "this no longer fits a compact right-aligned column"
//     threshold — a real discriminator across every row this component
//     actually renders (lib/commercial-components.ts, page.tsx's Discount/
//     Credit row construction): numbers/percentages/dates/short statuses/
//     badges ("Blocked by upstream decision," "Contractual rate schedule,"
//     a formatted amount) all stay well under it; full sentences and rule/
//     calculation descriptions ("Additional charge applies above the
//     contracted threshold of...", "Prior-period usage is combined with
//     the current period's recurring fixed fee...") run well past it.
//  3. Ends in terminal sentence punctuation AND has several words — catches
//     a genuine short sentence that the length check alone would miss
//     (e.g. "Calculated after the billing period closes.") without
//     mis-flagging a short label that merely happens to run long, or a
//     symbolic value with no sentence shape at all.
export function isLongFormValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.includes('\n')) return true
  if (trimmed.length > 48) return true
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  return /[.!?]$/.test(trimmed) && wordCount >= 3
}
