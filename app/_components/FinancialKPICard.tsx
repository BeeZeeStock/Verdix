// Shared shell for the Billing Summary KPI cards (Fixed fees / Minimum
// charges before credits/rebates / Billed to date) — enforces identical
// height, padding, icon size, label size, and border radius across all
// three so nothing drifts into "one card grey, one bigger, one centered"
// (the exact complaint this design pass exists to fix). Content is
// left-aligned throughout, per the explicit "do not center the values"
// instruction — numbers are easier to compare in a scanning column when
// they share a left edge.
export function FinancialKPICard({
  icon, label, metaChip, sage, children,
}: {
  icon: string
  label: string
  metaChip?: React.ReactNode
  // Very subtle pale-sage tint — reserved for the one "aggregate" card
  // (Minimum charges before credits/rebates) per the explicit instruction;
  // every other card stays plain white so the section doesn't turn green.
  sage?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-2xl p-6 flex flex-col"
      style={{
        background: sage ? '#F4F9F5' : '#FFFFFF',
        border: `1px solid ${sage ? 'rgba(74,124,89,0.25)' : 'rgba(26,61,43,0.1)'}`,
        minHeight: 188,
      }}
    >
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-mint-soft">
          <i className={`ti ${icon} text-forest`} style={{ fontSize: 18 }} />
        </div>
        <div className="min-w-0 pt-0.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone/60 leading-tight">{label}</p>
          {metaChip && <div className="mt-1">{metaChip}</div>}
        </div>
      </div>
      <div className="flex-1 flex flex-col justify-end">
        {children}
      </div>
    </div>
  )
}
