import { NextResponse } from 'next/server'
import { getActiveOrg } from '@/lib/org'
import { getBillingContext, getAllPlans } from '@/lib/billing'

export async function GET() {
  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 401 })

  const [ctx, plans] = await Promise.all([
    getBillingContext(org.orgId),
    getAllPlans(),
  ])

  return NextResponse.json({ ...ctx, plans, orgId: org.orgId, orgName: org.orgName })
}
