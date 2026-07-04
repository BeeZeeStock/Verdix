import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'

export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { fullName, currentPassword, newPassword } = await req.json()
  const email = session.user!.email!

  // Look up Supabase user ID once
  const { data: listData } = await supabaseServer.auth.admin.listUsers()
  const supaUser = listData?.users?.find(u => u.email === email)
  if (!supaUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (fullName !== undefined) {
    const { error } = await supabaseServer.auth.admin.updateUserById(supaUser.id, {
      user_metadata: { full_name: fullName.trim() },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (newPassword) {
    if (!currentPassword) {
      return NextResponse.json({ error: 'Current password is required' }, { status: 400 })
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
    }

    // Verify current password before changing it
    const { error: signInErr } = await supabaseServer.auth.signInWithPassword({
      email,
      password: currentPassword,
    })
    if (signInErr) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 })

    const { error: updateErr } = await supabaseServer.auth.admin.updateUserById(supaUser.id, {
      password: newPassword,
    })
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
