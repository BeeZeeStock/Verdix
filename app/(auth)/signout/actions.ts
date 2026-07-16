'use server'
import { signOut } from '@/lib/auth'

export async function doSignOut() {
  await signOut({ redirectTo: '/' })
}
