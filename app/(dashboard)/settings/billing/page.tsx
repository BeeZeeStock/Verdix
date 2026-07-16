import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import BillingPage from './billing-client'

const ADMIN_EMAILS = ['bilal@lynoraai.com', 'bilal.zahoor@yahoo.com']

export default async function Page() {
  const session = await auth()
  if (session?.user?.email && ADMIN_EMAILS.includes(session.user.email)) {
    redirect('/admin/billing')
  }
  return <BillingPage />
}
