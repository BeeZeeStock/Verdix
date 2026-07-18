'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

function norm(s: string) {
  return s.replace(/[€$£¥,\s\-–—]/g, '').toLowerCase()
}

interface Props {
  url: string
  /** Section heading to navigate to (e.g. "1.1 Base Platform Fee") */
  section?: string
}

export default function PDFViewer({ url, section }: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [numPages, setNumPages] = useState(0)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const wrapperMap = useRef<Map<number, HTMLDivElement>>(new Map())
  const sectionRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        const pdf = await pdfjs.getDocument(url).promise
        if (dead) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        setStatus('ready')
      } catch { if (!dead) setStatus('error') }
    })()
    return () => { dead = true }
  }, [url])

  // ── Draw section marker: green left bar + mint tint on heading ────────────
  const paintSection = useCallback((heading: string) => {
    document.querySelectorAll('.pdf-section-overlay').forEach(el => (el as HTMLElement).innerHTML = '')

    if (!heading) return
    const needle = norm(heading)

    for (const [, wrapper] of wrapperMap.current) {
      const textLayer = wrapper.querySelector('.pdf-text-layer')
      if (!textLayer) continue

      let overlay = wrapper.querySelector('.pdf-section-overlay') as HTMLDivElement | null
      if (!overlay) {
        overlay = document.createElement('div')
        overlay.className = 'pdf-section-overlay'
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;'
        wrapper.appendChild(overlay)
      }

      const wRect = wrapper.getBoundingClientRect()
      let found = false

      const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        const raw = node.textContent ?? ''
        if (!norm(raw).includes(needle)) continue

        try {
          const range = document.createRange()
          range.setStart(node, 0)
          range.setEnd(node, raw.length)
          const rects = [...range.getClientRects()]
          if (!rects.length) continue

          // Bounding box of the matching text
          const top  = Math.min(...rects.map(r => r.top))  - wRect.top - 4
          const bot  = Math.max(...rects.map(r => r.bottom)) - wRect.top + 4
          const h    = bot - top

          // Mint background tint across full row
          const bg = document.createElement('div')
          bg.style.cssText = `position:absolute;left:0;top:${top}px;width:100%;height:${h}px;background:rgba(212,234,217,0.45);`
          overlay.appendChild(bg)

          // 3 px green left bar (extends 60 px below heading to suggest section continues)
          const bar = document.createElement('div')
          bar.style.cssText = `position:absolute;left:0;top:${top}px;width:4px;height:${h + 60}px;background:#4A7C59;border-radius:0 2px 2px 0;`
          overlay.appendChild(bar)

          // Small "§" label at the bar top
          const pill = document.createElement('div')
          pill.textContent = '§'
          pill.style.cssText = `position:absolute;left:6px;top:${top}px;background:#4A7C59;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;line-height:${h}px;`
          overlay.appendChild(pill)

          if (!found) {
            found = true
            const firstRect = rects[0]
            const scrollTarget = wrapper.closest('.pdf-scroll-container') as HTMLElement | null
            if (scrollTarget) {
              // offsetTop is relative to scroll container (position:relative)
              // firstRect.top - wRect.top gives y-offset of text within the page
              const scrollTop = wrapper.offsetTop + (firstRect.top - wRect.top) + scrollTarget.scrollTop - 100
              scrollTarget.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
            } else {
              bg.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          }
        } catch { /* skip */ }
      }
    }
  }, [])

  useEffect(() => {
    sectionRef.current = section
    if (status === 'ready') paintSection(section ?? '')
  }, [section, status, paintSection])

  const mountPage = useCallback(async (wrapper: HTMLDivElement | null, pageNum: number) => {
    if (!wrapper || !pdfRef.current || wrapper.childElementCount > 0) return
    wrapperMap.current.set(pageNum, wrapper)

    const page = await pdfRef.current.getPage(pageNum)
    const cw = wrapper.parentElement?.clientWidth
      ? wrapper.parentElement.clientWidth - 32  // subtract container p-4 × 2
      : (wrapper.clientWidth || 680)
    const vp = page.getViewport({ scale: cw / page.getViewport({ scale: 1 }).width })

    // No explicit height — the canvas (display:block; height:auto) controls it
    wrapper.style.cssText = `position:relative;width:100%;overflow:hidden;`

    const canvas = document.createElement('canvas')
    canvas.width = vp.width; canvas.height = vp.height
    // height:auto causes the canvas to scale proportionally with width, preventing distortion
    canvas.style.cssText = 'display:block;width:100%;height:auto;'
    wrapper.appendChild(canvas)
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise

    const textDiv = document.createElement('div')
    textDiv.className = 'pdf-text-layer'
    textDiv.style.cssText = `position:absolute;top:0;left:0;width:${vp.width}px;height:${vp.height}px;overflow:hidden;line-height:1;`
    wrapper.appendChild(textDiv)

    const { TextLayer } = await import('pdfjs-dist')
    const tl = new TextLayer({ textContentSource: await page.getTextContent(), container: textDiv, viewport: vp })
    await tl.render()
    textDiv.querySelectorAll('span').forEach((s: HTMLElement) => { s.style.color = 'transparent' })

    if (sectionRef.current) paintSection(sectionRef.current)
  }, [paintSection])

  if (status === 'error') return (
    <div className="h-full flex items-center justify-center text-sm text-stone">
      <div className="text-center">
        <i className="ti ti-alert-circle text-danger/50 block mb-2" style={{ fontSize: 28 }} />Failed to load PDF
      </div>
    </div>
  )

  if (status === 'loading') return (
    <div className="h-full flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-forest border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="pdf-scroll-container h-full overflow-y-auto bg-stone/10 p-4 space-y-3" style={{ position: 'relative' }}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map(n => (
        <div
          key={n}
          ref={el => { mountPage(el as HTMLDivElement | null, n) }}
          style={{ display: 'block', width: '100%', boxShadow: '0 1px 6px rgba(0,0,0,0.18)', borderRadius: 2 }}
        />
      ))}
    </div>
  )
}
