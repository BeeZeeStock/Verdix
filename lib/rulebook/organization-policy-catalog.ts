// Organization Rulebook — settings-page read model (customer-facing UX
// pass). Pure: no database, no React — safe to import from the client
// page component exactly like organization-rulebook-display.ts, which
// this module reuses rather than re-deriving (item 14: "do not create a
// second implementation of active/future/superseded just for the React
// page" — groupForDisplay already IS that logic).
//
// THREE distinct layers, never conflated:
//   A. Verdix Global Rulebook (lib/rulebook/rules.ts) — 9 product-wide
//      rules, automatically applied, not tenant-configurable, and NOT
//      represented anywhere in this module or the settings page.
//   B. Supported Organization Policy TYPES — production capabilities an
//      organization MAY configure. ORGANIZATION_POLICY_CATALOG below,
//      derived from the SAME PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST
//      the resolver itself gates on. A supported type is not itself a
//      policy — it carries no value, default, or treatment of its own
//      (see OrganizationPolicyDefinition's own comment).
//   C. Actual Organization Policies — tenant-owned rows in
//      organization_rulebook_rules. Zero by default for every
//      organization; created only through that organization's own
//      promotion/activation workflow. buildOrganizationPolicySettingsModel
//      below derives this layer from real rule rows.
import { PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST, type ProductionActivatedOrganizationField } from './organization-rulebook-production'
import { groupForDisplay } from './organization-rulebook-display'
import type { OrganizationRuleRecord } from './organization-rules'

export interface OrganizationPolicyDefinition {
  field: ProductionActivatedOrganizationField
  // Customer-facing — never the raw dotted field path (item 4).
  title: string
  description: string
  // Explains the actual product workflow (item 10) — organization
  // policies are created by promoting an approved reviewer decision, not
  // through a direct "create policy" form this product doesn't have.
  howCreated: string
  // Reserved for a future opt-in "Verdix suggests..." template feature
  // (item 14) — deliberately NOT populated today. A supported type on its
  // own has no value/default/treatment; when this is eventually used, the
  // organization must still explicitly choose and activate a template
  // through the normal draft -> activation workflow — a suggestion may
  // never silently become an active Organization Policy by itself.
  suggestedTemplates?: Array<{ label: string; value: unknown; rationale: string }>
}

// Add a policy type's customer-facing metadata here ONLY when its field is
// added to PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST — the Record type
// below requires an entry for every allowlisted field (and rejects one
// for any field that isn't), so the two can never silently drift apart.
// No entry here may assign a value/treatment — a supported type describes
// a CAPABILITY ("an organization may configure this"), never a policy
// ("this organization's carry-forward is true/false") — that distinction
// is the entire point of this file.
const POLICY_DEFINITIONS: Record<ProductionActivatedOrganizationField, Omit<OrganizationPolicyDefinition, 'field'>> = {
  'survival.carry_forward': {
    title: 'Unused credit balance',
    description: 'Defines how unused service credits, rebates and conditional credits are treated when an agreement does not specify what happens to the remaining balance.',
    howCreated: 'Create from contract review.',
  },
}

// Supported Organization Policy TYPES (layer B) — product-wide, identical
// for every organization. Never an actual policy value.
export const ORGANIZATION_POLICY_CATALOG: OrganizationPolicyDefinition[] =
  PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST.map(field => ({ field, ...POLICY_DEFINITIONS[field] }))

export type OrganizationPolicyCardState =
  | 'not_configured'
  | 'active'
  | 'scheduled'
  | 'draft'
  | 'active_with_scheduled_change'

export interface OrganizationPolicyCardModel extends OrganizationPolicyDefinition {
  state: OrganizationPolicyCardState
  activeRules: OrganizationRuleRecord[]
  scheduledRules: OrganizationRuleRecord[]
  draftRules: OrganizationRuleRecord[]
  // Superseded/disabled versions — secondary, disclosure-only (item 9/12).
  history: OrganizationRuleRecord[]
}

export interface OrganizationPolicySettingsModel {
  summary: {
    // Layer B count — how many policy TYPES Verdix's production resolver
    // currently supports. Identical for every organization; NOT a count
    // of anything this tenant has configured. Never named "available" —
    // that reads as "N policies already exist" (item 2).
    supportedTypes: number
    // Layer C count — how many of those types THIS organization has an
    // active or future-scheduled policy for. Never counts a bare draft
    // (no production effect yet) or superseded/disabled history (item 6).
    configuredPolicies: number
    drafts: number
  }
  // One entry per supported type (layer B), each carrying this
  // organization's own configuration state for it (layer C) — the page
  // partitions this same array into "Your organization policies" (state
  // !== 'not_configured') and "Supported policy types" (state ===
  // 'not_configured') rather than the read model pre-splitting it, so a
  // type's card can move between sections as its state changes with no
  // model-shape change.
  policyTypes: OrganizationPolicyCardModel[]
}

/**
 * The settings page's sole read model (item 15/16 of the prior round,
 * amended for terminology only — see this file's own header for the
 * three-layer model this now names correctly). Derives every card's
 * state from the organization's real rule rows via groupForDisplay's
 * existing active/future/draft/superseded/disabled split — never a
 * second temporal implementation. `rules` should be the org's FULL rule
 * set (any status, any target_field — e.g. listAllOrganizationRules) so
 * history/draft rows are available for their respective disclosures;
 * rows for a target_field outside the current catalog are silently
 * excluded from `policyTypes` (a rule targeting a shadow-only field is
 * never shown as an available production policy type) but are otherwise
 * harmless to pass in.
 *
 * Deliberately keeps activeRules/scheduledRules/draftRules as ARRAYS,
 * never a single collapsed value: the backend's own no-overlap exclusion
 * constraint is scoped to (organization, target_field, match_conditions),
 * not to target_field alone, so multiple simultaneously active rules for
 * the same field under different match_conditions are a real, reachable
 * shape (confirmed via organization-rulebook-promotion.ts, which scopes
 * every promoted rule's match_conditions to the specific credit_type it
 * came from) — the UI must render each one, not merge them.
 */
export function buildOrganizationPolicySettingsModel(
  rules: OrganizationRuleRecord[],
  asOf: Date = new Date(),
): OrganizationPolicySettingsModel {
  const policyTypes: OrganizationPolicyCardModel[] = ORGANIZATION_POLICY_CATALOG.map(def => {
    const fieldRules = rules.filter(r => r.targetField === def.field)
    const activeRules = fieldRules.filter(r => groupForDisplay(r, asOf) === 'active')
    const scheduledRules = fieldRules.filter(r => groupForDisplay(r, asOf) === 'future')
    const draftRules = fieldRules.filter(r => groupForDisplay(r, asOf) === 'draft')
    const history = fieldRules.filter(r => {
      const group = groupForDisplay(r, asOf)
      return group === 'superseded' || group === 'disabled'
    })

    let state: OrganizationPolicyCardState
    if (activeRules.length > 0 && scheduledRules.length > 0) state = 'active_with_scheduled_change'
    else if (activeRules.length > 0) state = 'active'
    else if (scheduledRules.length > 0) state = 'scheduled'
    else if (draftRules.length > 0) state = 'draft'
    else state = 'not_configured'

    return { ...def, state, activeRules, scheduledRules, draftRules, history }
  })

  const configuredPolicies = policyTypes.filter(p =>
    p.state === 'active' || p.state === 'scheduled' || p.state === 'active_with_scheduled_change',
  ).length
  const drafts = policyTypes.filter(p => p.draftRules.length > 0).length

  return { summary: { supportedTypes: policyTypes.length, configuredPolicies, drafts }, policyTypes }
}
