/**
 * Admin endpoint: sync webhook event list across all connected org Stripe accounts.
 *
 * Run this once after adding a new event type to the per-org webhook handler.
 * Orgs with webhook_endpoint_id (auto-registered) are updated in-place — no secret
 * rotation, no org action required. Orgs that connected manually (no endpoint_id) are
 * skipped and counted separately; they must reconnect to pick up the new events.
 *
 * POST /api/admin/billing/sync-org-webhooks
 * Response: { ok, updated, skipped, failed }
 */

import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireAdmin } from '@/lib/admin'

const ORG_WEBHOOK_EVENTS = [
  'invoice.created',
  'invoice.payment_succeeded',
] as const

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { data: orgs, error } = await supabaseServer
    .from('org_integrations')
    .select('org_id, config')
    .eq('connector_name', 'stripe')
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results = { updated: 0, skipped: 0, failed: 0 }

  await Promise.allSettled((orgs ?? []).map(async (integration) => {
    const cfg = (integration.config ?? {}) as Record<string, string>

    if (!cfg.webhook_endpoint_id || !cfg.secret_key) {
      results.skipped++
      return
    }

    try {
      const { default: Stripe } = await import('stripe')
      const stripe = new Stripe(cfg.secret_key, { apiVersion: '2026-06-24.dahlia' })
      await stripe.webhookEndpoints.update(cfg.webhook_endpoint_id, {
        enabled_events: [...ORG_WEBHOOK_EVENTS],
      })
      results.updated++
    } catch (err) {
      console.error(`[sync-org-webhooks] failed for org ${integration.org_id}:`, err)
      results.failed++
    }
  }))

  return NextResponse.json({ ok: true, ...results })
}
