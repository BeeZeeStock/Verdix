import { supabaseServer } from './supabase'
import { Resend } from 'resend'
import type { OrgRole } from './org'

const APP_URL = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'

function emailShell(bodyHtml: string): string {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1C1917;background:#FAFAF8;border-radius:16px;overflow:hidden">
      <div style="background:#1A3D2B;padding:24px 32px">
        <div style="font-size:18px;font-weight:600;color:#fff">Verdix</div>
      </div>
      <div style="padding:32px">
        ${bodyHtml}
        <p style="font-size:11px;color:#C4C4BE;margin-top:28px;padding-top:16px;border-top:1px solid #E5E7EB">
          Verdix / A product by Lynora AB · Org. nr 559516-1190 · Sweden
        </p>
      </div>
    </div>
  `
}

async function sendInviteEmail(params: { to: string; orgName: string; role: OrgRole; actionLink: string }) {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const { error } = await resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to: params.to,
    subject: "You're invited to Verdix",
    html: emailShell(`
      <p style="font-size:18px;font-weight:300;margin:0 0 12px">You've been invited to Verdix</p>
      <p style="font-size:14px;color:#6B6660;line-height:1.7;margin:0 0 8px">
        You've been invited to join <strong>${params.orgName}</strong> on Verdix as <strong>${params.role}</strong>.
      </p>
      <p style="font-size:14px;color:#6B6660;line-height:1.7;margin:0 0 24px">
        Verdix reads your signed contracts, extracts the commercial terms, and reconciles them against what was actually billed — so revenue leakage gets caught before it compounds.
      </p>
      <a href="${params.actionLink}"
         style="display:inline-block;background:#1A3D2B;color:#fff;font-size:14px;font-weight:500;padding:13px 24px;border-radius:10px;text-decoration:none">
        Set your password &amp; access Verdix →
      </a>
      <p style="font-size:12px;color:#9CA3AF;margin-top:28px">
        This invitation is intended for <strong>${params.to}</strong>. If you weren't expecting this, you can safely ignore this email.
      </p>
    `),
  })
  if (error) console.error('[invite] invite email failed:', error)
}

async function sendExistingUserAddedEmail(params: { to: string; orgName: string; role: OrgRole }) {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const { error } = await resend.emails.send({
    from: 'Verdix <noreply@lynoraai.com>',
    to: params.to,
    subject: `You've been added to ${params.orgName} on Verdix`,
    html: emailShell(`
      <p style="font-size:18px;font-weight:300;margin:0 0 12px">You've been added to a new organisation</p>
      <p style="font-size:14px;color:#6B6660;line-height:1.7;margin:0 0 24px">
        Your existing Verdix account now also has access to <strong>${params.orgName}</strong> as <strong>${params.role}</strong>. Sign in as usual to switch into it.
      </p>
      <a href="${APP_URL}/login"
         style="display:inline-block;background:#1A3D2B;color:#fff;font-size:14px;font-weight:500;padding:13px 24px;border-radius:10px;text-decoration:none">
        Sign in to Verdix →
      </a>
    `),
  })
  if (error) console.error('[invite] existing-user-added email failed:', error)
}

/**
 * Provisions membership + (if needed) a Supabase Auth identity for `email`,
 * and emails them a way in. Used for: admin creating a new org's initial
 * admin, admin inviting into an existing org, resending an invite, and the
 * tenant-scoped "invite a teammate" flow — one code path so all of them get
 * the same working password-set link instead of the old broken /signup link.
 */
export async function provisionAndInviteUser(params: {
  orgId: string
  orgName: string
  email: string
  role: OrgRole
  invitedByEmail: string
}): Promise<{ ok: true; newAccount: boolean }> {
  const email = params.email.toLowerCase().trim()

  // generateLink({ type: 'invite' }) creates the Supabase Auth user AND
  // returns a single-use action link in one call. If the user already
  // exists it errors instead — that's how we distinguish "brand new
  // invitee, needs to set a password" from "existing Verdix user, just
  // gained access to another org" without a separate createUser call.
  let newAccount = true
  let actionLink: string | null = null
  const { data: linkData, error: linkErr } = await supabaseServer.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: `${APP_URL}/reset-password` },
  })
  if (linkErr) {
    const alreadyExists = linkErr.message?.toLowerCase().includes('already registered')
      || (linkErr as { status?: number }).status === 422
    if (!alreadyExists) throw linkErr
    newAccount = false
  } else {
    actionLink = linkData.properties.action_link
  }

  const { error: memberErr } = await supabaseServer
    .from('org_memberships')
    .upsert(
      {
        org_id: params.orgId,
        user_email: email,
        role: params.role,
        status: 'invited',
        invited_by: params.invitedByEmail,
        invite_last_sent_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,user_email' },
    )
  if (memberErr) throw new Error(`Failed to create membership: ${memberErr.message}`)

  if (newAccount && actionLink) {
    await sendInviteEmail({ to: email, orgName: params.orgName, role: params.role, actionLink })
  } else {
    await sendExistingUserAddedEmail({ to: email, orgName: params.orgName, role: params.role })
  }

  return { ok: true, newAccount }
}
