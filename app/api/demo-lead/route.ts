import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { Resend } from 'resend'

const NOTIFY_TO = process.env.DESIGN_PARTNER_NOTIFY_EMAIL ?? 'bilal@lynoraai.com'

async function sendNotification(params: { email: string; source: string; pagePath: string | null }) {
  const { email, source, pagePath } = params
  const resend = new Resend(process.env.RESEND_API_KEY)
  const result = await resend.emails.send({
    from:    'Verdix <noreply@lynoraai.com>',
    to:      NOTIFY_TO,
    subject: `New demo lead — ${email}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1C1917">
        <div style="background:#EAF3DE;border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <p style="margin:0;font-size:13px;color:#27500A;font-weight:600;letter-spacing:.05em;text-transform:uppercase">New Demo Lead</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#6B6660;width:120px">Email</td><td style="padding:8px 0"><a href="mailto:${email}" style="color:#1A3D2B">${email}</a></td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Source</td><td style="padding:8px 0">${source}</td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Page</td><td style="padding:8px 0">${pagePath ?? '—'}</td></tr>
        </table>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF">
          Captured via the Verdix demo walkthrough
        </div>
      </div>
    `,
  })
  if (result.error) console.error('[demo-lead] resend error', result.error)
  else console.log('[demo-lead] email sent', result.data?.id)
}

// In-memory, per-instance rate limit — a cheap deterrent against a single
// abusive client, not a distributed guarantee (serverless instances don't
// share this map, and it resets on cold start). Good enough for a low-
// traffic marketing form; revisit with a real store (e.g. Upstash) if this
// endpoint ever sees actual abuse.
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = 5
const hits = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > RATE_MAX
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { email, source, pagePath, website } = body as {
    email?: string; source?: string; pagePath?: string; website?: string
  }

  // Honeypot: a real visitor never sees or fills this field. Report success
  // without writing anything, so scripted submitters get no signal to adapt.
  if (typeof website === 'string' && website.trim().length > 0) {
    return NextResponse.json({ success: true }, { status: 201 })
  }

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const leadSource = typeof source === 'string' && source ? source : 'demo_walkthrough'
  const normalizedPath = typeof pagePath === 'string' ? pagePath.slice(0, 300) : null

  // Suppress an immediate re-submit (double-click, form re-post) without a
  // hard uniqueness constraint on email — a returning visitor should still
  // be able to submit again on a later visit.
  const { data: recent } = await supabaseServer
    .from('demo_leads')
    .select('id')
    .eq('email', normalizedEmail)
    .gte('created_at', new Date(Date.now() - RATE_WINDOW_MS).toISOString())
    .limit(1)
    .maybeSingle()

  if (recent) {
    return NextResponse.json({ success: true, leadId: recent.id }, { status: 200 })
  }

  const { data, error } = await supabaseServer
    .from('demo_leads')
    .insert({
      email:      normalizedEmail,
      source:     leadSource,
      page_path:  normalizedPath,
      status:     'new',
    })
    .select('id')
    .single()

  if (error) {
    return NextResponse.json({ error: 'Could not save your email. Please try again.' }, { status: 500 })
  }

  // The row write above is the source of truth for this lead — a
  // notification failure must never lose it or fail the request.
  sendNotification({ email: normalizedEmail, source: leadSource, pagePath: normalizedPath }).catch(err => {
    console.error('[demo-lead] notification failed', err)
  })

  return NextResponse.json({ success: true, leadId: data.id }, { status: 201 })
}
