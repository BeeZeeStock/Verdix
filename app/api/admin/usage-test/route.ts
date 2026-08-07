import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

// GET /api/admin/usage-test
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [orgsRes, subsRes, jobsRes] = await Promise.all([
    supabaseServer.from('organizations').select('id, name').order('name'),
    supabaseServer.from('org_subscriptions').select('org_id, plan_id, usage_counters, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end'),
    // No limit — this backs the org list's job-count badge, so every org's
    // jobs must be counted, not just the most recently created 50 system-wide.
    supabaseServer.from('jobs').select('id, org_id, created_at').order('created_at', { ascending: false }),
  ])

  const orgMap = new Map((orgsRes.data ?? []).map((o: { id: string; name: string }) => [o.id, o.name]))
  const subMap = new Map((subsRes.data ?? []).map((s: Record<string, unknown>) => [s.org_id as string, s]))

  const orgs = (orgsRes.data ?? []).map((o: { id: string; name: string }) => ({
    org_id: o.id,
    org_name: o.name,
    ...((subMap.get(o.id) ?? { plan_id: 'trial', usage_counters: {}, stripe_customer_id: null, stripe_subscription_id: null }) as object),
  }))

  const jobs = (jobsRes.data ?? []).map((j: Record<string, unknown>) => ({
    id:         j.id,
    org_id:     j.org_id,
    org_name:   orgMap.get(j.org_id as string) ?? j.org_id,
    created_at: j.created_at,
  }))

  return NextResponse.json({ orgs, jobs })
}
