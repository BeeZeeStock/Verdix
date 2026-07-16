import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'
import { Resend } from 'resend'

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { email, role = 'member' } = await req.json()
  if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  if (!['admin', 'member'].includes(role))
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })

  // Upsert membership (invited status — user activates on first login)
  const { error } = await supabaseServer
    .from('org_memberships')
    .upsert(
      {
        org_id: org.orgId,
        user_email: email.toLowerCase().trim(),
        role,
        status: 'invited',
        invited_by: org.userEmail,
      },
      { onConflict: 'org_id,user_email' }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Send invite email
  const resend = new Resend(process.env.RESEND_API_KEY)
  const appUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'

  const { error: emailError } = await resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to: email,
    subject: `You've been invited to ${org.orgName} on Verdix`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1C1917;background:#FAFAF8;border-radius:16px;overflow:hidden">
        <div style="background:#1A3D2B;padding:24px 32px">
          <div style="font-size:18px;font-weight:600;color:#fff">Verdix</div>
        </div>
        <div style="padding:32px">
          <p style="font-size:18px;font-weight:300;margin:0 0 12px">You've been invited</p>
          <p style="font-size:14px;color:#6B6660;line-height:1.7;margin:0 0 24px">
            <strong>${org.userEmail}</strong> has invited you to join <strong>${org.orgName}</strong> on Verdix as a <strong>${role}</strong>.
          </p>
          <a href="${appUrl}/signup"
             style="display:inline-block;background:#1A3D2B;color:#fff;font-size:14px;font-weight:500;padding:13px 24px;border-radius:10px;text-decoration:none">
            Accept invitation →
          </a>
          <p style="font-size:12px;color:#9CA3AF;margin-top:28px">
            Sign up with this email address to join the organization automatically.
          </p>
          <p style="font-size:11px;color:#C4C4BE;margin-top:16px;padding-top:16px;border-top:1px solid #E5E7EB">
            Verdix is a product by Lynora AB · Org. nr 559516-1190 · Vallentuna, Sweden
          </p>
        </div>
      </div>
    `,
  })

  if (emailError) {
    console.error('[invite] email failed:', emailError)
    return NextResponse.json({ error: `Membership created but invite email failed: ${emailError.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, email, role })
}
