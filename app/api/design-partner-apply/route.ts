import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { Resend } from 'resend'

const NOTIFY_TO = process.env.DESIGN_PARTNER_NOTIFY_EMAIL ?? 'bilal@lynoraai.com'

async function sendNotification(params: {
  name: string; company: string; email: string; role?: string
  platformStr: string; moduleList: string; pain?: string
}) {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const { name, company, email, role, platformStr, moduleList, pain } = params
  const result = await resend.emails.send({
    from:    'Verdix <noreply@lynoraai.com>',
    to:      NOTIFY_TO,
    subject: `New Design Partner application — ${company}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1C1917">
        <div style="background:#EAF3DE;border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <p style="margin:0;font-size:13px;color:#27500A;font-weight:600;letter-spacing:.05em;text-transform:uppercase">New Design Partner Application</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#6B6660;width:140px">Name</td><td style="padding:8px 0;font-weight:500">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Company</td><td style="padding:8px 0;font-weight:500">${company}</td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Email</td><td style="padding:8px 0"><a href="mailto:${email}" style="color:#1A3D2B">${email}</a></td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Role</td><td style="padding:8px 0">${role ?? '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Billing platform</td><td style="padding:8px 0">${platformStr}</td></tr>
          <tr><td style="padding:8px 0;color:#6B6660">Capabilities</td><td style="padding:8px 0">${moduleList}</td></tr>
          ${pain ? `<tr><td style="padding:8px 0;color:#6B6660;vertical-align:top">Pain point</td><td style="padding:8px 0;line-height:1.6">${pain}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF">
          Submitted via verdix.io/design-partner
        </div>
      </div>
    `,
  })
  if (result.error) console.error('[design-partner-apply] resend error', result.error)
  else console.log('[design-partner-apply] email sent', result.data?.id)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { company, name, email, role, size, pain, platform, modules, gdprConsent } = body

  if (!company || !name || !email) {
    return NextResponse.json(
      { error: 'company, name and email are required' },
      { status: 400 }
    )
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const moduleList = Array.isArray(modules) && modules.length > 0 ? modules.join(', ') : '—'
  const platformStr = platform ?? '—'

  const { data, error } = await supabaseServer
    .from('design_partner_applications')
    .insert({
      company,
      contact_name:  name,
      contact_email: email,
      contact_role:  role    ?? null,
      company_size:  size    ?? null,
      pain_point:    pain    ?? null,
      gdpr_consent:  gdprConsent ?? true,
      status: 'new',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      // Already registered — still notify so duplicate attempts are visible
      sendNotification({ name, company, email, role, platformStr, moduleList, pain }).catch(() => {})
      return NextResponse.json({ error: 'This email is already registered.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  sendNotification({ name, company, email, role, platformStr, moduleList, pain }).catch(() => {})

  return NextResponse.json({ success: true, applicationId: data.id }, { status: 201 })
}
