import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

// GET /api/admin/customers — all orgs with subscription details
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { data: orgs } = await supabaseServer
    .from('organizations')
    .select('id, name, slug, created_at')
    .order('created_at', { ascending: false })

  if (!orgs?.length) return NextResponse.json([])

  const { data: subs } = await supabaseServer
    .from('org_subscriptions')
    .select('*')
    .in('org_id', orgs.map(o => o.id))

  const subMap = Object.fromEntries((subs ?? []).map(s => [s.org_id, s]))

  const { data: memberCounts } = await supabaseServer
    .from('org_memberships')
    .select('org_id')
    .in('org_id', orgs.map(o => o.id))
    .eq('status', 'active')

  const memberMap: Record<string, number> = {}
  for (const m of memberCounts ?? []) memberMap[m.org_id] = (memberMap[m.org_id] ?? 0) + 1

  return NextResponse.json(orgs.map(o => ({
    ...o,
    subscription: subMap[o.id] ?? { plan_id: 'trial', syncs_used: 0, status: 'active' },
    member_count: memberMap[o.id] ?? 0,
  })))
}

// PATCH /api/admin/customers — update org subscription (plan, trial limit override)
export async function PATCH(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { org_id, plan_id, trial_sync_limit_override } = await req.json()
  if (!org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (plan_id !== undefined) update.plan_id = plan_id
  if (trial_sync_limit_override !== undefined) update.trial_sync_limit_override = trial_sync_limit_override

  const { error } = await supabaseServer
    .from('org_subscriptions')
    .upsert({ org_id, ...update }, { onConflict: 'org_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
