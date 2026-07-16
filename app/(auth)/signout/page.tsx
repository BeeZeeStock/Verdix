'use client'

import { useEffect, useState } from 'react'
import { signOut } from 'next-auth/react'
import { VerdixLogo } from '@/components/VerdixLogo'

export default function SignOutPage() {
  const [done, setDone] = useState(false)

  useEffect(() => {
    signOut({ redirect: false }).then(() => {
      setDone(true)
      // Small delay so the cookie is fully cleared before navigating
      setTimeout(() => { window.location.replace('/') }, 300)
    })
  }, [])

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm text-center">
          <div className="flex flex-col items-center mb-6">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">
              {done ? 'Signed out' : 'Signing you out'}
            </h1>
            <p className="text-stone text-sm">You&apos;ll be redirected in a moment.</p>
          </div>

          {!done && (
            <div className="flex items-center justify-center gap-1.5 mt-2">
              {[0, 1, 2].map(i => (
                <span
                  key={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#1A3D2B',
                    display: 'inline-block',
                    opacity: 0.3,
                    animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
          )}

          <style>{`
            @keyframes pulse {
              0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
              40% { opacity: 1; transform: scale(1); }
            }
          `}</style>
        </div>
      </div>
    </div>
  )
}
