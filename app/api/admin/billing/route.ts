import { NextRequest, NextResponse } from 'next/server'
import { getVerdixStripe, getBillingMode } from '@/lib/stripe-verdix'
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
    const [stripe, mode] = await Promise.all([getVerdixStripe(), getBillingMode()])

    // Column names are environment-specific so sandbox and live don't overwrite each other
    const productCol     = mode === 'live' ? 'stripe_product_id_live'    : 'stripe_product_id_test'
    const priceCol       = mode === 'live' ? 'stripe_price_id_live'      : 'stripe_price_id_test'
    const cyclePricesCol = mode === 'live' ? 'stripe_cycle_prices_live'  : 'stripe_cycle_prices_test'

    const { data: current } = await supabaseServer
      .from('verdix_plans')
      .select(`${productCol}, ${priceCol}, ${cyclePricesCol}, name`)
      .eq('id', id)
      .maybeSingle()

    const currentData = current as Record<string, unknown> | null

    // Ensure product exists in the active Stripe environment
    let productId = currentData?.[productCol] as string | undefined
    const planName = (fields.name ?? (currentData?.name as string) ?? id)
    if (!productId) {
      const product = await stripe.products.create({ name: planName, metadata: { verdix_plan_id: id } })
      productId = product.id
    } else if (fields.name) {
      await stripe.products.update(productId, { name: planName })
    }
    updatePayload[productCol] = productId

    // Helper: map cycle → Stripe recurring params
    const cycleInterval = (cycle: string): { interval: 'month' | 'year'; interval_count: number } => {
      if (cycle === 'yearly')    return { interval: 'year',  interval_count: 1 }
      if (cycle === 'quarterly') return { interval: 'month', interval_count: 3 }
      return                            { interval: 'month', interval_count: 1 }
    }

    const existingCyclePrices = ((currentData?.[cyclePricesCol] ?? {}) as Record<string, string>)

    if (pushCycle) {
      const cycles: Array<{ cycle: string; price_eur: number }> = fields.billing_cycles ?? []
      const entry = cycles.find(c => c.cycle === pushCycle)
      if (entry) {
        const oldPriceId = existingCyclePrices[pushCycle]
        const price = await stripe.prices.create({
          product:     productId,
          unit_amount: Math.round(entry.price_eur * 100),
          currency:    'eur',
          recurring:   cycleInterval(pushCycle),
          metadata:    { verdix_plan_id: id, billing_cycle: pushCycle },
        })
        if (oldPriceId && oldPriceId !== price.id) {
          await stripe.prices.update(oldPriceId, { active: false }).catch(() => null)
        }
        if (pushCycle === 'monthly') updatePayload[priceCol] = price.id
        updatePayload[cyclePricesCol] = { ...existingCyclePrices, [pushCycle]: price.id }
      }
    } else if (pushToStripe && fields.base_price_eur != null) {
      const oldPriceId = currentData?.[priceCol] as string | undefined
      const price = await stripe.prices.create({
        product:     productId,
        unit_amount: Math.round(fields.base_price_eur * 100),
        currency:    'eur',
        recurring:   { interval: 'month' },
        metadata:    { verdix_plan_id: id, billing_cycle: 'monthly' },
      })
      if (oldPriceId && oldPriceId !== price.id) {
        await stripe.prices.update(oldPriceId, { active: false }).catch(() => null)
      }
      updatePayload[priceCol] = price.id
      updatePayload[cyclePricesCol] = { ...existingCyclePrices, monthly: price.id }
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
