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
  const { id, pushToStripe, ...fields } = body as {
    id: string
    pushToStripe?: boolean
    name?: string
    base_price_eur?: number
    sync_limit?: number | null
    overage_price_eur?: number | null
    pii_addon_available?: boolean
  }

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const updatePayload: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() }

  if (pushToStripe && fields.base_price_eur != null && fields.name && id !== 'trial' && id !== 'enterprise') {
    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

    // Fetch current plan to check if product already exists
    const { data: current } = await supabaseServer.from('verdix_plans').select('stripe_product_id, stripe_price_id').eq('id', id).maybeSingle()

    let productId = current?.stripe_product_id
    if (!productId) {
      const product = await stripe.products.create({
        name: fields.name,
        metadata: { verdix_plan_id: id },
      })
      productId = product.id
    } else {
      await stripe.products.update(productId, { name: fields.name })
    }

    // Always create a new price (Stripe prices are immutable)
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: Math.round((fields.base_price_eur ?? 0) * 100),
      currency: 'eur',
      recurring: { interval: 'month' },
      metadata: { verdix_plan_id: id },
    })

    // Archive old price if it existed
    if (current?.stripe_price_id && current.stripe_price_id !== price.id) {
      await stripe.prices.update(current.stripe_price_id, { active: false }).catch(() => null)
    }

    updatePayload.stripe_product_id = productId
    updatePayload.stripe_price_id = price.id
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
