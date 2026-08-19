import { ImageResponse } from 'next/og'

export const OG_ALT = 'Verdix — Agreement-to-billing for complex B2B contracts'
export const OG_SIZE = { width: 1200, height: 630 }
export const OG_CONTENT_TYPE = 'image/png'

// Same mark as components/VerdixLogo.tsx, inlined as an SVG data URI —
// next/og (Satori) reliably supports <img src>, not arbitrary nested <svg>.
const LOGO_SVG = '<svg width="168" height="168" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="7" fill="#1A3D2B"/><path d="M7.5 7 L11 7 L14 18.5 L17 7 L20.5 7 L14 22 Z" fill="#FFFFFF"/><rect x="11" y="24" width="6" height="1.5" rx="0.75" fill="#73C99B"/></svg>'
const LOGO_SRC = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString('base64')}`

// Kept centered on every axis, nothing near the edges — different apps
// (WhatsApp, iMessage, Slack, Twitter/X) crop this 1200x630 source to very
// different thumbnail shapes, and a left-aligned headline was getting cut
// mid-sentence. A centered logo lockup survives any of those crops.
export function renderVerdixOG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FAF8F4',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO_SRC} width={140} height={140} alt="" />
        <span style={{ display: 'flex', marginTop: 28, fontSize: 64, fontWeight: 600, color: '#1A3D2B', letterSpacing: '-0.01em' }}>Verdix</span>
        <span style={{ display: 'flex', marginTop: 14, fontSize: 26, color: '#6B6660' }}>Agreement-to-billing for complex B2B contracts</span>
      </div>
    ),
    { ...OG_SIZE }
  )
}
