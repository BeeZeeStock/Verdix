import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { auth } from '@/lib/auth'
import { requireAdmin } from '@/lib/admin'

// One-time migration utility from before the org-membership system existed:
// assigns all unclaimed jobs (user_id IS NULL) to the calling user. Restricted
// to Verdix staff — previously any logged-in customer could hit this and
// claim ownership of every unclaimed job across every org on the platform.
export async function POST() {
  try { await requireAdmin() } catch (res) { return res as Response }

  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseServer
    .from('jobs')
    .update({ user_id: session.user.id })
    .is('user_id', null)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    claimed: data?.length ?? 0,
    user_id: session.user.id,
  })
}
