import type { Metadata } from 'next'
import { SessionProvider } from 'next-auth/react'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://www.lynoraai.com'),
  title: 'Verdix — Agreement-to-Billing for Complex B2B Contracts',
  description: 'Verdix turns signed B2B agreements and required usage into traceable billing instructions for the systems you already use — without replacing your billing stack.',
  twitter: {
    card: 'summary_large_image',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css"
        />
      </head>
      <body className="min-h-full">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}
