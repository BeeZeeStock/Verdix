export function VerdixLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Container */}
      <rect width="28" height="28" rx="7" fill="#1A3D2B" />
      {/* V mark — even 2.5px stroke width on both arms */}
      <path
        d="M7.5 7 L11 7 L14 18.5 L17 7 L20.5 7 L14 22 Z"
        fill="#FFFFFF"
      />
      {/* Accent bar — soft green, bottom centre */}
      <rect x="11" y="24" width="6" height="1.5" rx="0.75" fill="#73C99B" />
    </svg>
  )
}
