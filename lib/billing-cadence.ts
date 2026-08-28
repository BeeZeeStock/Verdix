// Step 17F — extracted from app/api/jobs/[id]/meter-mappings/route.ts's
// own local normaliseCycle (previously the only copy of this logic in the
// codebase, not reusable). lib/billing-period-workspace.ts needs the exact
// same billing_frequency -> cadence normalization to derive period bounds
// via lib/tariff.ts's enumerateCadenceWindows/findCadenceWindowContaining
// — this is the shared, single source of truth both now read from, rather
// than a second, independently-maintained copy. Vocabulary matches
// OverageTier['measurement_period'] and lib/tariff.ts's CADENCE_MONTHS —
// 'annual', not 'yearly'; semi-annual checked before the generic "annual"
// substring match (a contract's own "semi-annual" would otherwise wrongly
// match "annual" first and get treated as a full year).
export type BillingCadence = 'monthly' | 'quarterly' | 'semi-annual' | 'annual'

export function normaliseCadence(freq: string | null | undefined): BillingCadence {
  if (!freq) return 'monthly'
  const f = freq.toLowerCase()
  if (f.includes('semi') || f.includes('half')) return 'semi-annual'
  if (f.includes('annual') || f.includes('year')) return 'annual'
  if (f.includes('quarter')) return 'quarterly'
  return 'monthly'
}
