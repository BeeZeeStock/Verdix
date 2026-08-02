/**
 * Verdix SaaS billing Stripe utility.
 *
 * Reads the `billing_mode` setting from verdix_settings to decide whether to
 * use the test or live Stripe account. This lets admins toggle between sandbox
 * and production via the Packages & Pricing admin page without a redeploy.
 *
 * Required env vars (set both in Vercel):
 *   STRIPE_SECRET_KEY_TEST   = sk_test_...
 *   STRIPE_SECRET_KEY_LIVE   = sk_live_...
 *   STRIPE_BILLING_WEBHOOK_SECRET_TEST  = whsec_... (test webhook)
 *   STRIPE_BILLING_WEBHOOK_SECRET_LIVE  = whsec_... (live webhook)
 */
import { supabaseServer } from './supabase'

export type BillingMode = 'test' | 'live'

export async function getBillingMode(): Promise<BillingMode> {
  const { data } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', 'billing_mode')
    .maybeSingle()
  return ((data?.value as string) === 'live' ? 'live' : 'test')
}

export async function getVerdixStripe() {
  const mode = await getBillingMode()
  const key = mode === 'live'
    ? (process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY)
    : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY)
  if (!key) throw new Error(`Missing Stripe key for billing_mode="${mode}". Set STRIPE_SECRET_KEY_${mode.toUpperCase()} in env.`)
  const { default: Stripe } = await import('stripe')
  return new Stripe(key, { apiVersion: '2026-06-24.dahlia' })
}

/**
 * Verify a Stripe webhook signature against both test and live secrets.
 * Returns the parsed event or throws if neither secret matches.
 * Safe because HMAC verification is local — wrong secret = exception.
 */
export async function constructVerdixWebhookEvent(rawBody: string, sig: string) {
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe('sk_test_dummy', { apiVersion: '2026-06-24.dahlia' })

  const secrets = [
    process.env.STRIPE_BILLING_WEBHOOK_SECRET_LIVE,
    process.env.STRIPE_BILLING_WEBHOOK_SECRET_TEST,
    process.env.STRIPE_BILLING_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET,
  ].filter(Boolean) as string[]

  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, sig, secret)
    } catch {
      // try next secret
    }
  }
  throw new Error('Invalid webhook signature')
}
