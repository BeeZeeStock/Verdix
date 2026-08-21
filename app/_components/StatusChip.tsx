// Reuses the exact palette already established on the Confirmed billing
// rules cards (configure/[id]/page.tsx's ConfirmedRuleCard/provenanceLabel:
// pale-sage/forest for "Clear from source", warm-sand/amber for "Reviewer
// policy") — promoted to a shared component so a new surface (Billing
// Summary KPI cards, invoice rows) reuses the same values instead of
// re-hardcoding them. Red is reserved for 'blocked' only — a pending
// figure (e.g. usage-dependent, not yet a genuine blocker) uses the same
// amber family as reviewer-policy, never red, per the explicit
// "muted red only for genuine blockers" rule.
export type StatusChipKind = 'confirmed' | 'sourceClear' | 'reviewerPolicy' | 'userProvided' | 'pending' | 'blocked'

const CHIP_STYLE: Record<StatusChipKind, { icon: string; label: string; bg: string; color: string }> = {
  confirmed:     { icon: 'ti-circle-check-filled', label: 'Confirmed',       bg: 'var(--color-state-confirmed-bg)', color: 'var(--color-state-confirmed)' },
  sourceClear:   { icon: 'ti-circle-check-filled', label: 'Clear from source', bg: 'var(--color-state-confirmed-bg)', color: 'var(--color-state-confirmed)' },
  reviewerPolicy:{ icon: 'ti-user-check',          label: 'Reviewer policy',  bg: 'var(--color-state-reviewer-bg)',  color: 'var(--color-state-reviewer)' },
  userProvided:  { icon: 'ti-user-check',          label: 'User provided',    bg: 'var(--color-state-reviewer-bg)',  color: 'var(--color-state-reviewer)' },
  pending:       { icon: 'ti-clock',               label: 'Pending',          bg: 'var(--color-state-reviewer-bg)',  color: 'var(--color-state-pending)' },
  blocked:       { icon: 'ti-alert-triangle',       label: 'Decision required', bg: 'var(--color-state-blocked-bg)',  color: 'var(--color-state-blocked)' },
}

export function StatusChip({ kind, label, className }: { kind: StatusChipKind; label?: string; className?: string }) {
  const s = CHIP_STYLE[kind]
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full ${className ?? ''}`}
      style={{ background: s.bg, color: s.color }}
    >
      <i className={`ti ${s.icon}`} style={{ fontSize: 12 }} />
      {label ?? s.label}
    </span>
  )
}

// Plain inline version (icon + text, no pill background) for tighter
// spots like a card footer — same colors, lighter visual weight.
export function StatusInline({ kind, label, className }: { kind: StatusChipKind; label?: string; className?: string }) {
  const s = CHIP_STYLE[kind]
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${className ?? ''}`} style={{ color: s.color }}>
      <i className={`ti ${s.icon}`} style={{ fontSize: 12 }} />
      {label ?? s.label}
    </span>
  )
}
