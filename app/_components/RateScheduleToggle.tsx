'use client'

// Step 17H.3C2 — extracted out of app/(dashboard)/configure/[id]/page.tsx
// (where it originated, Step 17G.4A, for Products, Services & Pricing's
// CommercialComponentCard) so it can be reused, unmodified, as Commercial
// Logic & Billing Setup's own "View rate schedule" affordance for a
// performance/percentage-of-basis component's "Rate selection" row — the
// same table, not a second implementation. Unlike BandTableToggle (Step
// 17H.3C1), this table takes no selectedBand-equivalent prop: the
// applicable rate for a percentage_of_basis fee depends on a real
// period's derived metric value (numerator/denominator, resolved from
// live operational inputs) — state this agreement-level contractual
// schedule has no access to and never should (Billing Timeline alone
// owns period execution/results). This stays a reference table.
import { useState } from 'react'

export function RateScheduleToggle({ rateSchedule }: { rateSchedule: { from: number; to: number | null; rate_pct: number }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pt-3">
      <button onClick={() => setOpen(o => !o)} className="text-[11px] font-medium text-forest hover:text-sage transition-colors">
        {open ? 'Hide' : 'View'} rate schedule {open ? '▴' : '▾'}
      </button>
      {open && (
        <table className="w-full mt-2">
          <tbody>
            {rateSchedule.map((b, i) => (
              <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.05)' }}>
                <td className="py-1.5 text-[11px] text-stone">{b.from}–{b.to != null ? b.to : '∞'}%</td>
                <td className="py-1.5 text-[11px] font-medium text-ink text-right tabular-nums">{b.rate_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
