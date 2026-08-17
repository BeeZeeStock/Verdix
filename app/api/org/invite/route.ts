import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { provisionAndInviteUser } from '@/lib/invite'

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { email, role = 'member' } = await req.json()
  if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  if (!['admin', 'member'].includes(role))
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })

  try {
    const result = await provisionAndInviteUser({
      orgId: org.orgId, orgName: org.orgName, email, role, invitedByEmail: org.userEmail,
    })
    return NextResponse.json({ ok: true, email, role, newAccount: result.newAccount })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to invite user' }, { status: 500 })
  }
}
