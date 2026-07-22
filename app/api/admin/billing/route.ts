import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

// GET /api/admin/billing — list all plans + global settings
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [{ data: plans }, { data: settings }] = await Promise.all([
    supabaseServer.from('verdix_plans').select('*').order('sort_order'),
    supabaseServer.from('verdix_settings').select('*'),
  ])

  return NextResponse.json({ plans: plans ?? [], settings: settings ?? [] })
}

// PATCH /api/admin/billing — update a plan and optionally push to Stripe
export async function PATCH(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const body = await req.json()
  const { id, pushToStripe, pushCycle, ...fields } = body as {
    id: string
    pushToStripe?: boolean
    pushCycle?: 'monthly' | 'quarterly' | 'yearly'
    name?: string
    base_price_eur?: number
    sync_limit?: number | null
    overage_price_eur?: number | null
    pii_addon_available?: boolean
    billing_cycles?: Array<{ cycle: string; price_eur: number }>
  }

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const updatePayload: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() }

  const canPushStripe = id !== 'trial' && id !== 'enterprise'

  if (canPushStripe && (pushToStripe || pushCycle)) {
    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

    const { data: current } = await supabaseServer
      .from('verdix_plans')
      .select('stripe_product_id, stripe_price_id, stripe_cycle_prices, name')
      .eq('id', id)
      .maybeSingle()

    // Ensure product exists
    let productId = current?.stripe_product_id as string | undefined
    const planName = (fields.name ?? (current?.name as string) ?? id)
    if (!productId) {
      const product = await stripe.products.create({ name: planName, metadata: { verdix_plan_id: id } })
      productId = product.id
    } else if (fields.name) {
      await stripe.products.update(productId, { name: planName })
    }
    updatePayload.stripe_product_id = productId

    // Helper: map cycle → Stripe recurring params
    const cycleInterval = (cycle: string): { interval: 'month' | 'year'; interval_count: number } => {
      if (cycle === 'yearly')   return { interval: 'year',  interval_count: 1 }
      if (cycle === 'quarterly') return { interval: 'month', interval_count: 3 }
      return                           { interval: 'month', interval_count: 1 }
    }

    const existingCyclePrices = ((current?.stripe_cycle_prices ?? {}) as Record<string, string>)

    if (pushCycle) {
      // Push a single billing cycle price
      const cycles: Array<{ cycle: string; price_eur: number }> = fields.billing_cycles ?? []
      const entry = cycles.find(c => c.cycle === pushCycle)
      if (entry) {
        const oldPriceId = existingCyclePrices[pushCycle]
        const price = await stripe.prices.create({
          product:    productId,
          unit_amount: Math.round(entry.price_eur * 100),
          currency:   'eur',
          recurring:  cycleInterval(pushCycle),
          metadata:   { verdix_plan_id: id, billing_cycle: pushCycle },
        })
        if (oldPriceId && oldPriceId !== price.id) {
          await stripe.prices.update(oldPriceId, { active: false }).catch(() => null)
        }
        // If this is the monthly cycle, also update the legacy stripe_price_id
        if (pushCycle === 'monthly') updatePayload.stripe_price_id = price.id
        updatePayload.stripe_cycle_prices = { ...existingCyclePrices, [pushCycle]: price.id }
      }
    } else if (pushToStripe && fields.base_price_eur != null) {
      // Legacy: push just the monthly price (backward compat)
      const oldPriceId = current?.stripe_price_id as string | undefined
      const price = await stripe.prices.create({
        product:    productId,
        unit_amount: Math.round(fields.base_price_eur * 100),
        currency:   'eur',
        recurring:  { interval: 'month' },
        metadata:   { verdix_plan_id: id, billing_cycle: 'monthly' },
      })
      if (oldPriceId && oldPriceId !== price.id) {
        await stripe.prices.update(oldPriceId, { active: false }).catch(() => null)
      }
      updatePayload.stripe_price_id = price.id
      updatePayload.stripe_cycle_prices = { ...existingCyclePrices, monthly: price.id }
    }
  }

  const { error } = await supabaseServer.from('verdix_plans').update(updatePayload).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: updated } = await supabaseServer.from('verdix_plans').select('*').eq('id', id).maybeSingle()
  return NextResponse.json({ plan: updated })
}

// PUT /api/admin/billing?type=setting — update a global setting
export async function PUT(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { key, value } = await req.json()
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

  const { error } = await supabaseServer
    .from('verdix_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
