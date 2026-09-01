'use client'

// Step 17H.4B0D4H1B4E2.3 §18 — extracted verbatim from page.tsx (previously
// a local, non-exported function used at 10+ call sites there) so it can
// also be imported by RollingBandMigrationCard.tsx, which itself needed to
// move out of page.tsx to be reachable from Billing Timeline
// (BillingSummaryCard.tsx, a different file). Pure presentation, no
// behavior change.

export type SourceLocator = {
  exact_source_heading: string
  display_label?: string | null
}

export function SourceClauseLink({
  section, sections, onViewSource, hasClauseText,
}: {
  // Single-locator call sites (the common case, e.g. an escalator or the
  // base fee) still just pass a plain heading string here — wrapped into
  // one SourceLocator below so there's only one code path either way.
  section?: string
  sections?: SourceLocator[] | null
  onViewSource?: (section: string) => void
  hasClauseText?: boolean
}) {
  const list: SourceLocator[] = sections?.length ? sections : (section ? [{ exact_source_heading: section }] : [])
  if (list.length === 0) {
    if (hasClauseText) {
      return (
        <span
          className="text-[10px] text-stone/50 whitespace-nowrap flex-shrink-0"
          title="The clause text was preserved, but no navigable PDF location was captured for it."
        >
          Source text preserved — exact PDF location unavailable
        </span>
      )
    }
    return null
  }
  if (!onViewSource) return null
  if (list.length === 1) {
    return (
      <button
        // Step 17B0.4 — exact_source_heading only, NEVER display_label —
        // the viewer searches the original document's text layer for
        // exactly this string.
        onClick={() => onViewSource(list[0].exact_source_heading)}
        className="text-[10px] font-medium text-forest hover:underline whitespace-nowrap flex-shrink-0"
      >
        View source clause ↗
      </button>
    )
  }
  return (
    <span className="flex items-center gap-2 flex-wrap justify-end">
      {list.map((loc, i) => (
        <button
          key={i}
          onClick={() => onViewSource(loc.exact_source_heading)}
          className="text-[10px] font-medium text-forest hover:underline whitespace-nowrap flex-shrink-0"
        >
          {loc.display_label ?? `Source ${i + 1}`} ↗
        </button>
      ))}
    </span>
  )
}
