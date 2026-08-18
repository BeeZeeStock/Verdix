import type { NextConfig } from "next";

// Verified against what the app actually loads (2026-08-19 security audit):
// no client-side Stripe.js, no iframes/embeds, no third-party analytics, and
// the only external browser-initiated calls are to Supabase (used from the
// client-side reset-password page) and Google Fonts (the static demo page
// under /public/demos, not the Next.js app itself — the app uses next/font).
// script-src keeps 'unsafe-inline' because Next.js injects an inline
// hydration bootstrap script with no nonce wiring in this app yet; a
// nonce-based CSP would be stricter but requires middleware changes this
// audit pass didn't want to risk shipping unverified.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://uctcodlhojeoestyamcj.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        ],
      },
    ]
  },
};

export default nextConfig;
