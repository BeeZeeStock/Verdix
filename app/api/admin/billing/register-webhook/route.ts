import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'

const BILLING_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
] as const

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const base = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? 'https://app.lynoraai.com'
  const url = `${base}/api/billing/webhook`

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  // Check if a webhook pointing at this URL already exists
  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  const alreadyRegistered = existing.data.find(w => w.url === url && w.status === 'enabled')
  if (alreadyRegistered) {
    return NextResponse.json({
      ok: true,
      url,
      id: alreadyRegistered.id,
      note: 'Webhook already registered. To get the signing secret, delete it in Stripe and re-register here.',
    })
  }

  const webhook = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...BILLING_WEBHOOK_EVENTS],
    description: 'Verdix SaaS billing webhook',
  })

  return NextResponse.json({
    ok: true,
    url: webhook.url,
    id: webhook.id,
    secret: webhook.secret,
  })
}
