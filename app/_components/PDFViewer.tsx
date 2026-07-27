'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

function norm(s: string) {
  return s.replace(/[€$£¥,\s\-–—]/g, '').toLowerCase()
}

// Build a flat list of { node, text, parentEl } entries from a text layer,
// then for each position produce a "window" string spanning up to N characters
// across adjacent nodes within the same line-block. Returns [{combined, nodes[]}].
function buildWindowedText(textLayer: Element): { combined: string; nodes: { node: Text; raw: string }[] }[] {
  const entries: { node: Text; raw: string; parentEl: Element }[] = []
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
  let n: Text | null
  while ((n = walker.nextNode() as Text | null)) {
    const raw = n.textContent ?? ''
    if (!raw.trim()) continue
    entries.push({ node: n, raw, parentEl: (n.parentElement ?? textLayer) as Element })
  }
  // Produce windows: for each starting node, accumulate adjacent nodes (up to 120 chars)
  const windows: { combined: string; nodes: { node: Text; raw: string }[] }[] = []
  for (let i = 0; i < entries.length; i++) {
    let combined = ''
    const nodeList: { node: Text; raw: string }[] = []
    for (let j = i; j < entries.length && combined.length < 120; j++) {
      combined += entries[j].raw
      nodeList.push({ node: entries[j].node, raw: entries[j].raw })
    }
    windows.push({ combined, nodes: nodeList })
  }
  return windows
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
    if (!needle) return

    // Track the first match across all pages so we only auto-scroll once
    let globalFirstScrollDone = false

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

      // Build windowed text entries for this page
      const windows = buildWindowedText(textLayer)

      // Find the first window whose combined normalized text contains the needle.
      // Prefer exact section-number-prefix matches (e.g. "6.6" at the start) to
      // avoid matching the table of contents before the actual section body.
      let matchWindow = windows.find(w => {
        const c = norm(w.combined)
        if (!c.includes(needle)) return false
        // If the needle starts with digits (section number), require it to appear
        // near the beginning of the combined string (within first 20 chars) so TOC
        // links with trailing dots/pages don't win over the actual heading.
        const sectionNumMatch = /^\d/.test(needle)
        if (sectionNumMatch) return c.indexOf(needle) < 20
        return true
      })
      // Fallback: accept any window that contains the needle anywhere
      if (!matchWindow) {
        matchWindow = windows.find(w => norm(w.combined).includes(needle))
      }
      if (!matchWindow) continue

      // Get bounding rects from all nodes in the matching window
      try {
        const allRects: DOMRect[] = []
        for (const { node, raw } of matchWindow.nodes) {
          const range = document.createRange()
          range.setStart(node, 0)
          range.setEnd(node, raw.length)
          allRects.push(...range.getClientRects())
        }
        if (!allRects.length) continue

        // Canvas renders at vp.width intrinsic pixels but CSS width:100% scales it to
        // the container. The text layer stays at fixed vp.width px and does NOT scale.
        // Multiply text-layer coordinates by this factor to hit the right visual line.
        const canvas = wrapper.querySelector('canvas') as HTMLCanvasElement | null
        const scale = canvas && canvas.width > 0 ? wrapper.clientWidth / canvas.width : 1

        const rawTop = Math.min(...allRects.map(r => r.top)) - wRect.top - 4
        const rawBot = Math.max(...allRects.map(r => r.bottom)) - wRect.top + 4
        const top = rawTop * scale
        const bot = rawBot * scale
        const h   = bot - top

        const bg = document.createElement('div')
        bg.style.cssText = `position:absolute;left:0;top:${top}px;width:100%;height:${h}px;background:rgba(212,234,217,0.45);`
        overlay.appendChild(bg)

        const bar = document.createElement('div')
        bar.style.cssText = `position:absolute;left:0;top:${top}px;width:4px;height:${h + 60}px;background:#4A7C59;border-radius:0 2px 2px 0;`
        overlay.appendChild(bar)

        const pill = document.createElement('div')
        pill.textContent = '§'
        pill.style.cssText = `position:absolute;left:6px;top:${top}px;background:#4A7C59;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;line-height:${h}px;`
        overlay.appendChild(pill)

        if (!globalFirstScrollDone) {
          globalFirstScrollDone = true
          const scrollTarget = wrapper.closest('.pdf-scroll-container') as HTMLElement | null
          if (scrollTarget) {
            const scrollTop = wrapper.offsetTop + top + scrollTarget.scrollTop - 100
            scrollTarget.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
          } else {
            bg.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }
        // Only highlight the first match per document (stop after this page)
        break
      } catch { /* skip */ }
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
