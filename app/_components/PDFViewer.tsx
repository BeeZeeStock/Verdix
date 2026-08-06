'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const STRIP_RE = /[€$£¥,\s\-–—]/

function norm(s: string) {
  return s.replace(STRIP_RE, '').toLowerCase()
}

// Like norm(), but also returns a map from each normalized-string index back to
// the index in the raw (un-normalized) string it came from — needed to translate
// a match position found in normalized text back to a real DOM offset.
function normWithMap(raw: string): { normalized: string; rawIndex: number[] } {
  let normalized = ''
  const rawIndex: number[] = []
  for (let i = 0; i < raw.length; i++) {
    if (STRIP_RE.test(raw[i])) continue
    normalized += raw[i].toLowerCase()
    rawIndex.push(i)
  }
  return { normalized, rawIndex }
}

// Strips diacritics (e.g. "ö" → "o") by decomposing to NFD and dropping
// combining marks. Used only as a fallback match pass, to tolerate Unicode
// composition differences (NFC vs NFD) between the extracted heading text and
// however this specific PDF's font/encoding produced its text content.
function foldDiacritics(ch: string): string {
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function normLoose(s: string): string {
  let out = ''
  for (const ch of s) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue
    out += foldDiacritics(ch.toLowerCase())
  }
  return out
}

// Like normWithMap, but folds diacritics and drops all punctuation/symbols
// (not just the STRIP_RE set) — a looser fallback for when the exact heading
// text doesn't literally appear (different accent encoding, stray punctuation
// like a period after the section number, etc.).
function normWithMapLoose(raw: string): { normalized: string; rawIndex: number[] } {
  let normalized = ''
  const rawIndex: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (!/[\p{L}\p{N}]/u.test(ch)) continue
    const folded = foldDiacritics(ch.toLowerCase())
    for (const fc of folded) {
      normalized += fc
      rawIndex.push(i)
    }
  }
  return { normalized, rawIndex }
}

// Returns true if the match looks like a Table of Contents entry:
// the text immediately after the needle consists only of dots/ellipsis
// followed by a short page number (e.g. "...... 15" or "… 23").
function isTocLike(normalizedCombined: string, needle: string): boolean {
  const idx = normalizedCombined.indexOf(needle)
  if (idx < 0) return false
  const after = normalizedCombined.slice(idx + needle.length).replace(/[.…]/g, '').trim()
  return after.length > 0 && after.length <= 4 && /^\d+$/.test(after)
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

// Map a character offset in a window's raw `combined` string to the specific
// text node (and offset within it) that character actually belongs to.
function locateInWindow(
  window: { nodes: { node: Text; raw: string }[] },
  rawOffset: number,
): { node: Text; offset: number } {
  let pos = 0
  for (const { node, raw } of window.nodes) {
    if (rawOffset < pos + raw.length) return { node, offset: rawOffset - pos }
    pos += raw.length
  }
  const last = window.nodes[window.nodes.length - 1]
  return { node: last.node, offset: Math.max(0, last.raw.length - 1) }
}

// Cascading match strictness: prefer windows where the needle starts at idx=0
// (the section number is at the very beginning of the combined text), then
// allow idx<5, then fall back to idx<20. This prevents false-positives such
// as addresses containing "2.2" (e.g. norm("Strandvägen 2.2") = "strandvägen2.2",
// idx≈10) from shadowing the real heading whose window starts with "2.2".
function pickMatch<T extends { normalized: string }>(
  windows: T[],
  needle: string,
): { matchWindow: T; tier: number } | null {
  if (!needle) return null
  const makeCheck = (maxIdx: number) => (w: T) => {
    const c = w.normalized
    if (!c.includes(needle)) return false
    if (isTocLike(c, needle)) return false
    if (/^\d/.test(needle)) {
      const idx = c.indexOf(needle)
      if (idx > maxIdx) return false
      // Reject matches where the needle is actually the tail of a longer number,
      // e.g. "45.2" or "125.2" containing "5.2" — a price like "€1,245.20" could
      // otherwise shadow the real "5.2" heading.
      const charBefore = idx > 0 ? c[idx - 1] : undefined
      if (charBefore !== undefined && /\d/.test(charBefore)) return false
      const charAfter = c[idx + needle.length]
      if (charAfter !== undefined && /[\d%]/.test(charAfter)) return false
    }
    return true
  }
  for (const maxIdx of [0, 4, 19]) {
    const w = windows.find(makeCheck(maxIdx))
    if (w) return { matchWindow: w, tier: maxIdx }
  }
  return null
}

interface Props {
  url: string
  /** Section heading to navigate to (e.g. "1.1 Base Platform Fee") */
  section?: string
}

// Fixed render width in px — pages don't rescale after mount (see mountPage).
const PAGE_WIDTH = 720

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

  // ── Draw section marker: Verdix logo pin at clause start ─────────────────
  const paintSection = useCallback((heading: string) => {
    document.querySelectorAll('.pdf-section-overlay').forEach(el => (el as HTMLElement).innerHTML = '')
    if (!heading) return

    // Finds the heading in a page's text layer and draws the marker there.
    // Returns true as soon as one page matches (only one marker is ever drawn).
    const attemptMatch = (
      buildMap: (raw: string) => { normalized: string; rawIndex: number[] },
      searchNeedle: string,
    ): boolean => {
      if (!searchNeedle) return false

      for (const [, wrapper] of wrapperMap.current) {
        const textLayer = wrapper.querySelector('.pdf-text-layer')
        if (!textLayer) continue

        const windows = buildWindowedText(textLayer).map(w => ({ ...w, ...buildMap(w.combined) }))
        const picked = pickMatch(windows, searchNeedle)
        if (!picked) continue

        try {
          const { matchWindow } = picked
          // Translate the match position (found in normalized text, which can start
          // anywhere up to 19 chars into the window per the cascade above) back to the
          // exact raw text node + offset it corresponds to — using the window's own
          // first node here would anchor the marker to the wrong line whenever the
          // match wasn't a clean idx=0 hit.
          const matchIdx = matchWindow.normalized.indexOf(searchNeedle)
          const rawOffset = matchWindow.rawIndex[matchIdx]
          const { node: firstNode, offset: startOffset } = locateInWindow(matchWindow, rawOffset)

          let overlay = wrapper.querySelector('.pdf-section-overlay') as HTMLDivElement | null
          if (!overlay) {
            overlay = document.createElement('div')
            overlay.className = 'pdf-section-overlay'
            overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;'
            wrapper.appendChild(overlay)
          }

          const wRect = wrapper.getBoundingClientRect()
          let topPx = 0
          let lineHeightPx = 16

          // Range on the first character gives the most reliable visual position —
          // it accounts for all CSS transforms that pdfjs-dist v5 applies to text
          // spans. The page is a fixed size (see mountPage), so wrapper/canvas/text
          // layer share one pixel coordinate frame — use raw px directly.
          const range = document.createRange()
          range.setStart(firstNode, startOffset)
          range.setEnd(firstNode, Math.min(firstNode.textContent?.length ?? startOffset + 1, startOffset + 1))
          const rects = Array.from(range.getClientRects())
          if (rects.length) {
            topPx = rects[0].top - wRect.top
            lineHeightPx = Math.max(rects[0].bottom - rects[0].top, 4)
          } else {
            const span = firstNode.parentElement as HTMLElement | null
            if (!span) continue
            const spanRect = span.getBoundingClientRect()
            topPx = spanRect.top - wRect.top
            lineHeightPx = Math.max(spanRect.bottom - spanRect.top, 4)
          }

          // Verdix logo marker — SVG matches components/VerdixLogo.tsx exactly
          const markerCenterPx = topPx + lineHeightPx * 0.5
          const marker = document.createElement('div')
          marker.style.cssText = `position:absolute;left:2px;top:${markerCenterPx}px;transform:translateY(-50%);width:32px;height:32px;filter:drop-shadow(0 1px 5px rgba(0,0,0,0.28));`
          marker.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none" width="32" height="32"><rect width="28" height="28" rx="7" fill="#1A3D2B"/><path d="M7.5 7 L11 7 L14 18.5 L17 7 L20.5 7 L14 22 Z" fill="#FFFFFF"/><rect x="11" y="24" width="6" height="1.5" rx="0.75" fill="#73C99B"/></svg>`
          overlay.appendChild(marker)

          const scrollTarget = wrapper.closest('.pdf-scroll-container') as HTMLElement | null
          if (scrollTarget) {
            scrollTarget.scrollTo({ top: Math.max(0, wrapper.offsetTop + topPx - 120), behavior: 'auto' })
          } else {
            marker.scrollIntoView({ behavior: 'auto', block: 'center' })
          }
          return true
        } catch { continue }
      }
      return false
    }

    const found = attemptMatch(normWithMap, norm(heading)) || attemptMatch(normWithMapLoose, normLoose(heading))
    if (!found) console.warn('[PDFViewer] could not locate heading in PDF text:', heading)
  }, [])

  useEffect(() => {
    sectionRef.current = section
    if (status === 'ready') paintSection(section ?? '')
  }, [section, status, paintSection])

  const mountPage = useCallback(async (wrapper: HTMLDivElement | null, pageNum: number) => {
    if (!wrapper || !pdfRef.current || wrapper.childElementCount > 0) return
    wrapperMap.current.set(pageNum, wrapper)

    const page = await pdfRef.current.getPage(pageNum)
    // Fixed render width — the page never rescales after mount, so the canvas
    // and text layer stay pixel-for-pixel in sync by construction. No resize
    // tracking needed.
    const vp = page.getViewport({ scale: PAGE_WIDTH / page.getViewport({ scale: 1 }).width })

    wrapper.style.cssText = `position:relative;width:${vp.width}px;height:${vp.height}px;margin:0 auto;overflow:hidden;`

    // pdfjs-dist's TextLayer positions each text span using
    // viewport.scale * devicePixelRatio internally (it assumes the canvas is
    // rendered at native device-pixel resolution). Our canvas must match that
    // assumption — raster at devicePixelRatio, displayed at the CSS size — or
    // the text layer's positions drift from the canvas by roughly that ratio.
    const outputScale = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * outputScale)
    canvas.height = Math.floor(vp.height * outputScale)
    canvas.style.cssText = `display:block;width:${vp.width}px;height:${vp.height}px;`
    wrapper.appendChild(canvas)
    const renderTransform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp, transform: renderTransform }).promise

    const textDiv = document.createElement('div')
    textDiv.className = 'pdf-text-layer'
    textDiv.style.cssText = `position:absolute;top:0;left:0;width:${vp.width}px;height:${vp.height}px;overflow:hidden;line-height:1;transform-origin:0 0;`
    // Text inside a PDF "marked content" group gets positioned via a calc()
    // that references these two custom properties (see pdfjs-dist's own
    // web/pdf_viewer.css) — set them so that calc() resolves instead of
    // silently falling back to `auto`.
    textDiv.style.setProperty('--scale-factor', String(vp.scale))
    textDiv.style.setProperty('--user-unit', String(vp.userUnit ?? 1))
    wrapper.appendChild(textDiv)

    const { TextLayer } = await import('pdfjs-dist')
    const tl = new TextLayer({ textContentSource: await page.getTextContent(), container: textDiv, viewport: vp })
    await tl.render()
    // TextLayer's constructor also tries to size `textDiv` itself via the same
    // calc() chain — re-assert the fixed pixel size defensively regardless.
    textDiv.style.width = `${vp.width}px`
    textDiv.style.height = `${vp.height}px`
    // TextLayer sets each span's position via inline `top`/`left` percentages,
    // but never sets `position` on the spans themselves — that's expected to
    // come from pdfjs-dist's own web/pdf_viewer.css, which we don't load since
    // we use the raw TextLayer API directly. Without `position`, `top`/`left`
    // have no effect at all and spans just stack in normal document flow.
    textDiv.querySelectorAll('span, br').forEach((el) => {
      const s = el as HTMLElement
      s.style.position = 'absolute'
      s.style.whiteSpace = 'pre'
      s.style.cursor = 'text'
      s.style.transformOrigin = '0% 0%'
      s.style.color = 'transparent'
    })

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
