import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { createOrg } from '@/lib/org'
import { Resend } from 'resend'

const NOTIFY_TO = process.env.DESIGN_PARTNER_NOTIFY_EMAIL ?? 'bilal@lynoraai.com'

export async function POST(req: NextRequest) {
  const { fullName, email, company, password } = await req.json()

  if (!fullName || !email || !company || !password) {
    return NextResponse.json({ error: 'All fields are required.' }, { status: 400 })
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  const { data, error } = await supabaseServer.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, company },
  })

  if (error) {
    const isDuplicate = error.message?.toLowerCase().includes('already registered')
      || (error as { status?: number }).status === 422
    if (isDuplicate) {
      return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })
    }
    console.error('[signup] supabase error', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Create org for the new user (company name → org name, user is owner)
  try {
    await createOrg(company, email)
  } catch (err) {
    console.error('[signup] org creation failed', err)
    // Non-fatal — user is created, org can be created later
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  const firstName = fullName.split(' ')[0]

  resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to: email,
    subject: 'Welcome to Verdix',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1C1917;background:#FAFAF8;border-radius:16px;overflow:hidden">
        <div style="background:#1A3D2B;padding:28px 32px">
          <div style="font-size:18px;font-weight:600;color:#fff;letter-spacing:.02em">Verdix</div>
          <div style="font-size:11px;color:#A7C5A0;letter-spacing:.05em;text-transform:uppercase;margin-top:2px">Revenue intelligence for B2B SaaS</div>
        </div>
        <div style="padding:32px">
          <p style="font-size:20px;font-weight:300;color:#1C1917;margin:0 0 16px">Welcome, ${firstName}.</p>
          <p style="font-size:14px;color:#6B6660;line-height:1.7;margin:0 0 24px">
            Your Verdix account is ready. Start by uploading a contract and running your first billing verification — most teams find their first discrepancy within minutes.
          </p>
          <a href="${process.env.NEXTAUTH_URL ?? 'https://verdix.io'}/dashboard"
             style="display:inline-block;background:#1A3D2B;color:#fff;font-size:14px;font-weight:500;padding:13px 24px;border-radius:10px;text-decoration:none">
            Open dashboard →
          </a>
          <div style="margin-top:32px;padding-top:24px;border-top:1px solid #E5E7EB">
            <p style="font-size:13px;color:#6B6660;margin:0 0 12px">What you can do right now:</p>
            <table style="width:100%;border-collapse:collapse">
              ${[
                ['Upload a contract', 'Auto-configure → Upload contract'],
                ['Run a billing verification', 'Billing checks → New verification'],
                ['Check partner invoices', 'Partner Recon → New reconciliation'],
              ].map(([action, path]) => `
              <tr>
                <td style="padding:8px 0;vertical-align:top">
                  <span style="display:inline-block;width:6px;height:6px;background:#1A3D2B;border-radius:50%;margin-right:10px;margin-top:5px;vertical-align:top"></span>
                </td>
                <td style="padding:8px 0;font-size:13px;color:#1C1917;line-height:1.5">
                  <strong>${action}</strong><br>
                  <span style="color:#9CA3AF;font-size:12px">${path}</span>
                </td>
              </tr>`).join('')}
            </table>
          </div>
          <p style="font-size:12px;color:#9CA3AF;margin-top:28px">
            Any questions? <a href="mailto:bilal@lynoraai.com" style="color:#1A3D2B">bilal@lynoraai.com</a>
          </p>
          <p style="font-size:11px;color:#C4C4BE;margin-top:16px;padding-top:16px;border-top:1px solid #E5E7EB">
            Verdix is a product by Lynora AB · Org. nr 559516-1190 · Vallentuna, Sweden
          </p>
        </div>
      </div>
    `,
  }).catch(err => console.error('[signup] welcome email failed', err))

  resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to: NOTIFY_TO,
    subject: `New signup — ${fullName} (${company})`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#1C1917">
        <div style="background:#EAF3DE;border-radius:12px;padding:16px 20px;margin-bottom:20px">
          <p style="margin:0;font-size:12px;color:#27500A;font-weight:600;letter-spacing:.05em;text-transform:uppercase">New Verdix Signup</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:7px 0;color:#6B6660;width:120px">Name</td><td style="padding:7px 0;font-weight:500">${fullName}</td></tr>
          <tr><td style="padding:7px 0;color:#6B6660">Company</td><td style="padding:7px 0;font-weight:500">${company}</td></tr>
          <tr><td style="padding:7px 0;color:#6B6660">Email</td><td style="padding:7px 0"><a href="mailto:${email}" style="color:#1A3D2B">${email}</a></td></tr>
        </table>
      </div>
    `,
  }).catch(err => console.error('[signup] admin notification failed', err))

  return NextResponse.json({ success: true, userId: data.user.id })
}
