import { supabaseServer } from './supabase'

export type PlanId = 'trial' | 'core' | 'pro' | 'enterprise'

export interface VerdixPlan {
  id: PlanId
  name: string
  base_price_eur: number
  sync_limit: number | null
  overage_price_eur: number | null
  pii_addon_available: boolean
  stripe_product_id: string | null
  stripe_price_id: string | null
  sort_order: number
}

export interface OrgSubscription {
  org_id: string
  plan_id: PlanId
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  current_period_start: string | null
  current_period_end: string | null
  syncs_used: number
  usage_counters: Record<string, number>
  trial_sync_limit_override: number | null
  pii_addon_enabled: boolean
  pii_addon_enabled_at: string | null
  status: string
}

export interface BillingContext {
  plan: VerdixPlan
  subscription: OrgSubscription
  syncLimit: number | null       // resolved limit (null = unlimited)
  syncsRemaining: number | null  // null = unlimited
  isOverLimit: boolean
  isNearLimit: boolean           // >80% used
  warnPct: number
}

// ── Getters ───────────────────────────────────────────────────────────────────

export async function getGlobalSetting(key: string): Promise<number | null> {
  const { data } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  if (!data) return null
  return typeof data.value === 'number' ? data.value : Number(data.value)
}

export async function getAllPlans(): Promise<VerdixPlan[]> {
  const { data } = await supabaseServer
    .from('verdix_plans')
    .select('*')
    .order('sort_order')
  return (data ?? []) as VerdixPlan[]
}

export async function getPlan(planId: string): Promise<VerdixPlan | null> {
  const { data } = await supabaseServer
    .from('verdix_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle()
  return data as VerdixPlan | null
}

export async function getOrgSubscription(orgId: string): Promise<OrgSubscription> {
  const { data } = await supabaseServer
    .from('org_subscriptions')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle()

  if (data) return data as OrgSubscription

  // Auto-provision trial subscription on first access
  const fresh: Partial<OrgSubscription> = {
    org_id: orgId,
    plan_id: 'trial',
    syncs_used: 0,
    usage_counters: {},
    pii_addon_enabled: false,
    status: 'active',
  }
  await supabaseServer.from('org_subscriptions').upsert(fresh, { onConflict: 'org_id' })
  return fresh as OrgSubscription
}

export async function getBillingContext(orgId: string): Promise<BillingContext> {
  const [subscription, warnPct] = await Promise.all([
    getOrgSubscription(orgId),
    getGlobalSetting('trial_warn_pct'),
  ])

  const { data: planData } = await supabaseServer
    .from('verdix_plans')
    .select('*')
    .eq('id', subscription.plan_id)
    .maybeSingle()
  const plan = planData as VerdixPlan

  let syncLimit: number | null = plan.sync_limit

  // Trial plan: resolve limit (org override → global setting → default 3)
  if (subscription.plan_id === 'trial') {
    if (subscription.trial_sync_limit_override != null) {
      syncLimit = subscription.trial_sync_limit_override
    } else {
      const globalLimit = await getGlobalSetting('trial_sync_limit')
      syncLimit = globalLimit ?? 3
    }
  }

  const warn = warnPct ?? 80
  const syncsUsed = Number(subscription.usage_counters?.['sync'] ?? subscription.syncs_used ?? 0)
  const isOverLimit = syncLimit != null && syncsUsed >= syncLimit
  const isNearLimit = syncLimit != null && !isOverLimit && (syncsUsed / syncLimit) * 100 >= warn
  const syncsRemaining = syncLimit != null ? Math.max(0, syncLimit - syncsUsed) : null

  return { plan, subscription, syncLimit, syncsRemaining, isOverLimit, isNearLimit, warnPct: warn }
}

// ── Sync recording ────────────────────────────────────────────────────────────

export type SyncEventType = 'contract_configure' | 'billing_audit' | 'partner_recon'

export async function recordSync(orgId: string, jobId: string, eventType: SyncEventType): Promise<{
  syncsUsed: number
  syncLimit: number | null
  isOverLimit: boolean
  overageCount: number
}> {
  const sub = await getOrgSubscription(orgId)

  // Get current period start for the sync event record
  const periodStart = sub.current_period_start ?? new Date(new Date().setDate(1)).toISOString()

  // Insert sync event
  await supabaseServer.from('sync_events').insert({
    org_id: orgId,
    job_id: jobId,
    event_type: eventType,
    billing_period_start: periodStart,
  })

  // Write to counter cache + timestamped ledger in one call
  const currentCount = Number(sub.usage_counters?.['sync'] ?? sub.syncs_used ?? 0)
  const newCount = currentCount + 1
  await supabaseServer.rpc('record_usage', {
    org_id_param:      orgId,
    meter_key_param:   'sync',
    amount_param:      1,
    job_id_param:      jobId,
    occurred_at_param: new Date().toISOString(),
  })

  // Resolve limit
  let syncLimit: number | null = null
  if (sub.plan_id === 'trial') {
    syncLimit = sub.trial_sync_limit_override ?? (await getGlobalSetting('trial_sync_limit')) ?? 3
  } else {
    const plan = await getPlan(sub.plan_id)
    syncLimit = plan?.sync_limit ?? null
  }

  const isOverLimit = syncLimit != null && newCount > syncLimit
  const overageCount = syncLimit != null ? Math.max(0, newCount - syncLimit) : 0

  return { syncsUsed: newCount, syncLimit, isOverLimit, overageCount }
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

export async function getOrCreateStripeCustomer(orgId: string, orgName: string, email: string): Promise<string> {
  const sub = await getOrgSubscription(orgId)
  if (sub.stripe_customer_id) return sub.stripe_customer_id

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  const customer = await stripe.customers.create({ name: orgName, email, metadata: { verdix_org_id: orgId } })

  await supabaseServer
    .from('org_subscriptions')
    .update({ stripe_customer_id: customer.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)

  return customer.id
}

export async function resetPeriodSyncs(orgId: string, periodStart: string, periodEnd: string): Promise<void> {
  await supabaseServer
    .from('org_subscriptions')
    .update({ syncs_used: 0, current_period_start: periodStart, current_period_end: periodEnd, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
}
