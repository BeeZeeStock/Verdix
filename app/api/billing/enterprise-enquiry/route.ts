import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { Resend } from 'resend'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, company, message } = await req.json() as {
    name: string
    company: string
    message?: string
  }

  if (!name || !company) return NextResponse.json({ error: 'name and company required' }, { status: 400 })

  const resend = new Resend(process.env.RESEND_API_KEY)
  await resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to:   'bilal@lynoraai.com',
    subject: `Enterprise enquiry — ${company}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1C1917">
        <div style="background:#1A3D2B;padding:20px 24px;border-radius:12px 12px 0 0">
          <div style="color:#fff;font-size:16px;font-weight:600">Enterprise Enquiry</div>
        </div>
        <div style="background:#FAFAF8;padding:24px;border-radius:0 0 12px 12px;border:1px solid #E5E0D8;border-top:none">
          <table style="width:100%;font-size:14px;border-collapse:collapse">
            <tr><td style="color:#6B6660;padding:6px 0;width:100px">Name</td><td style="font-weight:500">${name}</td></tr>
            <tr><td style="color:#6B6660;padding:6px 0">Company</td><td style="font-weight:500">${company}</td></tr>
            <tr><td style="color:#6B6660;padding:6px 0">Email</td><td><a href="mailto:${session.user.email}" style="color:#1A3D2B">${session.user.email}</a></td></tr>
            ${message ? `<tr><td style="color:#6B6660;padding:6px 0;vertical-align:top">Message</td><td style="line-height:1.6">${message}</td></tr>` : ''}
          </table>
        </div>
      </div>
    `,
  }).catch(err => console.error('[enterprise-enquiry] email failed', err))

  return NextResponse.json({ ok: true })
}
