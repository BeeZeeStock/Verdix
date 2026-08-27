// Step 17A hardening (review pass 7), item 2 — extracted from
// app/api/jobs/[id]/confirm-rule/route.ts so the "what should this
// discount's typed component targeting become once a reviewer confirms"
// logic is unit-testable without mocking supabaseServer (no precedent for
// that in this codebase — pure logic lives in lib/, route files consume
// it, same convention lib/line-items.ts already established).
//
// When a reviewer resolves discount scope (whether via /interpret-rule's
// natural-language translation or a direct structured-option selection),
// the CONFIRMED payload (approvedInterpretation) is what updates
// affected_components/possibly_affected_components going forward — never
// only the human-readable interpretation/applies_to. When the confirmed
// payload doesn't carry these fields at all (e.g. a legacy client), the
// discount's existing typed state is preserved rather than silently
// cleared — clearing it would reopen the exact fail-closed gap typed
// targeting exists to close.
export interface DiscountComponentTargetingInput {
  affected_components?: unknown
  possibly_affected_components?: unknown
  [k: string]: unknown
}

export interface DiscountComponentTargetingExisting {
  affected_components?: string[] | null
  possibly_affected_components?: string[] | null
}

export interface ResolvedDiscountComponents {
  affected_components: string[] | null
  possibly_affected_components: string[] | null
}

export function resolveConfirmedDiscountComponents(
  approvedInterpretation: DiscountComponentTargetingInput,
  existing: DiscountComponentTargetingExisting | undefined,
): ResolvedDiscountComponents {
  const affected_components = Array.isArray(approvedInterpretation.affected_components)
    ? (approvedInterpretation.affected_components as string[])
    : (existing?.affected_components ?? null)
  const possibly_affected_components = Array.isArray(approvedInterpretation.possibly_affected_components)
    ? (approvedInterpretation.possibly_affected_components as string[])
    : (existing?.possibly_affected_components ?? null)
  return { affected_components, possibly_affected_components }
}
