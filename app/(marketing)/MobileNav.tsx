'use client'

import { useState } from 'react'
import styles from './landing.module.css'

// The desktop nav links (styles.navLinks) are hidden entirely below 720px —
// this is the mobile replacement: a hamburger toggle + slide-down panel.
// Takes the same link markup as children (built once in page.tsx's Nav())
// rather than duplicating it, so the two nav surfaces can never drift apart.
export function MobileNav({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className={styles.navToggle}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className={open ? `${styles.navToggleBar} ${styles.open1}` : styles.navToggleBar} />
        <span className={open ? `${styles.navToggleBar} ${styles.open2}` : styles.navToggleBar} />
        <span className={open ? `${styles.navToggleBar} ${styles.open3}` : styles.navToggleBar} />
      </button>
      {open && (
        // Closes on any click inside — including a link tap — via bubbling,
        // without needing an onClick on every individual link.
        <div className={styles.navMobilePanel} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </>
  )
}
