import { formatCurrency } from '@/lib/currency-format'

// The single place a monetary figure's color/weight/decimal treatment is
// decided — see globals.css's "Financial number semantics" tokens. `basis`
// carries the color; `status` never does (see the 'confirmed' case below) —
// a confirmed net figure stays net-green, it does not turn a different
// color just because it's confirmed. Confirmation is expressed elsewhere
// (a check icon, a status chip, a pale card border — see StatusChip),
// never by recoloring the number itself. The one status that DOES change
// treatment is 'pending': an amount that depends on not-yet-known usage
// (e.g. "at least SEK 66,000, pending usage") is a genuinely different
// kind of number from a settled one, and already had its own established
// color/italic treatment elsewhere in the app before this component existed.
export type FinancialBasis = 'net' | 'vat' | 'gross' | 'credit'
export type FinancialStatus = 'default' | 'confirmed' | 'pending'
export type FinancialSize = 'sm' | 'md' | 'lg' | 'xl'

const BASIS_COLOR: Record<FinancialBasis, string> = {
  net: 'var(--color-financial-net)',
  vat: 'var(--color-financial-vat)',
  gross: 'var(--color-financial-gross)',
  credit: 'var(--color-financial-credit)',
}

const SIZE_CLASS: Record<FinancialSize, string> = {
  sm: 'text-[13px] font-semibold',
  md: 'text-[18px] font-semibold',
  lg: 'text-[24px] font-semibold',
  xl: 'text-[32px] font-semibold',
}

export function FinancialAmount({
  amount, currency, basis, status = 'default', size = 'md', negative = false, className,
}: {
  amount: number
  currency: string
  basis: FinancialBasis
  status?: FinancialStatus
  size?: FinancialSize
  // Credits/rebates render with a leading minus sign when true — the
  // caller still passes the amount as a positive magnitude; this never
  // silently negates a number the caller already signed.
  negative?: boolean
  className?: string
}) {
  const color = status === 'pending' ? 'var(--color-state-pending)' : BASIS_COLOR[basis]
  return (
    <span
      className={`${SIZE_CLASS[size]} ${status === 'pending' ? 'italic' : ''} ${className ?? ''}`}
      style={{ color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em', lineHeight: 1 }}
    >
      {negative ? '− ' : ''}{formatCurrency(amount, currency)}
    </span>
  )
}

// Small uppercase metadata tag under a label — "NET · EXCL. VAT" /
// "GROSS · INCL. VAT" — deliberately muted/neutral, never colored to
// match its basis (color lives on the number itself; the tag is plain
// secondary text, consistent with "subdued grey for secondary
// information" in the design direction).
export function FinancialMetaTag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-[9px] font-semibold uppercase tracking-wider text-stone/50 ${className ?? ''}`}>
      {children}
    </span>
  )
}
