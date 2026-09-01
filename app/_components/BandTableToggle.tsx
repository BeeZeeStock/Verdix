'use client'

// Step 17H.3C1 — extracted out of app/(dashboard)/configure/[id]/page.tsx
// (where it originated, Step 17G.4A, for Products, Services & Pricing's
// CommercialComponentCard) so it can be reused, unmodified in its
// original behavior, as Commercial Logic & Billing Setup's own "View full
// band table" affordance for the fixed component's Platform subscription
// row — the same table, not a second implementation. The retired
// standalone "Fixed platform fee — band selection" card is the only
// thing this migration removes; the table itself just gets a second,
// optional capability (selectedBand highlighting) neither prior call
// site needed until now.
import { useState } from 'react'
import type { FixedFeeBand } from '@/lib/types'

function fmt(n: number | null | undefined, cur: string) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

export function BandTableToggle({ bandTable, cur, selectedBand }: {
  bandTable: FixedFeeBand[]
  cur: string
  // Step 17H.3C1 — the resolved band (lib/fixed-fee-band.ts's
  // resolveFixedFeeBand output, when status === 'resolved'), so the
  // schedule can highlight which row currently applies — matched by
  // from_unit, the same comparison the retired standalone "Fixed
  // platform fee — band selection" card used, never array position,
  // display text, or price equality (two bands can share a price, and a
  // 'Price required' band has no price to compare at all). Omit or pass
  // null when resolution didn't succeed — the table then highlights
  // nothing, rather than guessing.
  selectedBand?: FixedFeeBand | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pt-3">
      <button onClick={() => setOpen(o => !o)} className="text-[11px] font-medium text-forest hover:text-sage transition-colors">
        {open ? 'Hide' : 'View'} full band table {open ? '▴' : '▾'}
      </button>
      {open && (
        <table className="w-full mt-2">
          <tbody>
            {bandTable.map((b, i) => {
              const isSelected = !!selectedBand && selectedBand.from_unit === b.from_unit
              return (
                <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.05)', background: isSelected ? 'rgba(11,92,54,0.06)' : undefined }}>
                  <td className={`py-1.5 text-[11px] ${isSelected ? 'text-ink font-medium' : 'text-stone'}`}>
                    {b.from_unit.toLocaleString()}–{b.to_unit != null ? b.to_unit.toLocaleString() : '∞'}
                    {isSelected && ' (selected)'}
                  </td>
                  <td className="py-1.5 text-[11px] font-medium text-ink text-right tabular-nums">{b.monthly_fee != null ? fmt(b.monthly_fee, cur) : 'Price required'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
