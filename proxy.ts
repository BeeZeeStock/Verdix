import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const { pathname } = req.nextUrl
  const isLoggedIn = !!req.auth

  const isDashboardRoute =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/configure') ||
    pathname.startsWith('/partner') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/admin')

  if (isDashboardRoute && !isLoggedIn) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (isLoggedIn && (pathname === '/login' || pathname === '/signup')) {
    return NextResponse.redirect(new URL('/dashboard', req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon|.*\\.svg).*)'],
}
