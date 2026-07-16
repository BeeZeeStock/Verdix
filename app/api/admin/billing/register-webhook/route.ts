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

  const base = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'
  const url = `${base}/api/billing/webhook`

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  // Delete any existing webhooks pointing at this URL so we get a fresh secret
  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  const stale = existing.data.filter(w => w.url === url)
  await Promise.all(stale.map(w => stripe.webhookEndpoints.del(w.id).catch(() => null)))

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
