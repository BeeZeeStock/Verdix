import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { auth } from '@/lib/auth'

// One-time endpoint: assigns all unclaimed jobs (user_id IS NULL) to the calling user.
// Hit this once while logged in as the account owner to take ownership of existing data.
export async function POST() {
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
