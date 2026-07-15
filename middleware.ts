import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const session = req.auth
  const { pathname } = req.nextUrl

  // Redirect Google users who haven't accepted the privacy policy yet
  if (session?.user?.needsConsent && pathname !== '/consent') {
    return NextResponse.redirect(new URL('/consent', req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/configure/:path*',
    '/verify/:path*',
    '/partner/:path*',
    '/setup/:path*',
    '/consent',
  ],
}
