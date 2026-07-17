import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { resolveStorageUrl } from '@/lib/storage'
import { getOrgSubscription } from '@/lib/billing'
import type { PIIEntity } from '@/lib/pii-detector'

const anthropicDirect = new Anthropic()

export const maxDuration = 120

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, contract_pdf_url, org_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.contract_pdf_url) return NextResponse.json({ error: 'No contract file uploaded' }, { status: 400 })

  // Verify PII masking is available: active addon OR trial plan (free preview).
  // For paid plans where pii_addon_enabled is stale (e.g. webhook missed),
  // do a live Stripe check and self-heal the Supabase flag.
  const sub = await getOrgSubscription(org.orgId)

  let piiAllowed = sub.pii_addon_enabled === true || sub.plan_id === 'trial'

  if (!piiAllowed && sub.stripe_subscription_id && ['core', 'pro', 'enterprise'].includes(sub.plan_id)) {
    try {
      const { data: piiPlan } = await supabaseServer
        .from('verdix_plans')
        .select('stripe_price_id')
        .eq('id', 'pii_addon')
        .maybeSingle()

      if (piiPlan?.stripe_price_id) {
        const { default: Stripe } = await import('stripe')
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)

        if (['active', 'trialing'].includes(stripeSub.status)) {
          const hasPii = stripeSub.items.data.some(i => i.price.id === piiPlan.stripe_price_id)
          if (hasPii) {
            await supabaseServer.from('org_subscriptions').update({
              pii_addon_enabled: true,
              updated_at: new Date().toISOString(),
            }).eq('org_id', org.orgId)
            piiAllowed = true
          }
        }
      }
    } catch { /* best-effort — fall through to the error below */ }
  }

  if (!piiAllowed) {
    return NextResponse.json({ error: 'Advanced PII Data Masking is not active on your plan.' }, { status: 403 })
  }

  await supabaseServer.from('jobs').update({ execute_status: 'DETECTING_PII' }).eq('id', id)

  try {
    // Extract text from PDF
    const resolvedUrl = await resolveStorageUrl(job.contract_pdf_url)
    const res = await fetch(resolvedUrl)
    if (!res.ok) throw new Error('Failed to download contract')
    const buffer = Buffer.from(await res.arrayBuffer())

    const contractText = await extractPDFText(buffer, resolvedUrl)

    // Run local PII detection (dynamic import keeps compromise out of module init)
    const { detectPII } = await import('@/lib/pii-detector')
    const { entities } = detectPII(contractText)

    // Save to DB and collect saved records
    const saved = await savePIIEntities(id, org.orgId, entities)

    await supabaseServer.from('jobs').update({ execute_status: 'PENDING_PII_REVIEW' }).eq('id', id)

    return NextResponse.json({ entities: saved })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: message,
    }).eq('id', id)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function extractPDFText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  if (pathname.endsWith('.pdf')) {
    const response = await anthropicDirect.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        }, {
          type: 'text',
          text: 'Extract all text from this contract. Output plain text, preserving section structure and all commercial terms, dates, and amounts.',
        }],
      }],
    })
    const c = response.content[0]
    return c.type === 'text' ? c.text : ''
  }
  return buffer.toString('utf-8')
}

async function savePIIEntities(jobId: string, orgId: string, entities: PIIEntity[]) {
  const results = []

  for (const entity of entities) {
    // If the entity already exists (e.g. approved from a previous contract), leave it untouched.
    // ignoreDuplicates: true skips the upsert on conflict, preserving the existing approved state.
    const { data: existing } = await supabaseServer
      .from('pii_entities')
      .select('id, entity_type, original_value, token, approved, ignored')
      .eq('org_id', orgId)
      .eq('original_value', entity.value)
      .maybeSingle()

    // Skip entities the user has permanently whitelisted as not-PII
    if (existing?.ignored) continue

    let saved = existing
    if (!existing) {
      // Generate a globally unique token for this org + entity type.
      // detectPII() resets its counter per run, so its token numbers can clash
      // across contracts. Count existing org-level entities of this type instead.
      const { count } = await supabaseServer
        .from('pii_entities')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('entity_type', entity.type)
      const token = `[${entity.type}_${(count ?? 0) + 1}]`

      const { data: inserted } = await supabaseServer
        .from('pii_entities')
        .insert({
          org_id:         orgId,
          entity_type:    entity.type,
          original_value: entity.value,
          token,
          approved:       false,
          source_job_id:  jobId,
        })
        .select('id, entity_type, original_value, token, approved, ignored')
        .single()
      saved = inserted
    }

    if (!saved) continue
    results.push({ ...saved, confidence: entity.confidence, source: entity.source })

    await supabaseServer
      .from('job_pii_occurrences')
      .upsert(
        {
          job_id:           jobId,
          pii_entity_id:    saved.id,
          detection_source: entity.source,
          confidence_pct:   entity.confidence,
          was_masked:       false, // not yet masked — pending review
        },
        { onConflict: 'job_id,pii_entity_id', ignoreDuplicates: true }
      )
  }

  return results
}
