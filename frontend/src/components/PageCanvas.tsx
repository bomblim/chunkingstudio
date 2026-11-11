import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { DocElement, DocPage } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 원본 PDF 로드 (없거나 PDF가 아니면 null) */
export function usePdf(url: string | null) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  useEffect(() => {
    if (!url) {
      setPdf(null)
      return
    }
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    pdfjs.getDocument(url).promise.then(
      (d) => {
        doc = d
        if (!cancelled) setPdf(d)
      },
      () => !cancelled && setPdf(null),
    )
    return () => {
      cancelled = true
      void doc?.destroy()
    }
  }, [url])
  return pdf
}

interface Props {
  page: DocPage
  elements: DocElement[]
  pdf: PDFDocumentProxy | null
  width: number
  colorOf: (el: DocElement) => string
  selectedId?: string | null
  onSelect?: (id: string) => void
  showOrder?: boolean
}

/** PV-01/PV-05: 원본 페이지 위에 Element bbox를 색상 오버레이, reading_order 표시 */
export function PageCanvas({ page, elements, pdf, width, colorOf, selectedId, onSelect, showOrder }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pw = page.width ?? Math.max(612, ...elements.map((e) => e.bbox?.x1 ?? 0))
  const ph = page.height ?? Math.max(792, ...elements.map((e) => e.bbox?.y1 ?? 0))
  const height = (width * ph) / pw

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let task: { cancel: () => void } | null = null
    let cancelled = false
    void pdf.getPage(page.page_no).then((p) => {
      if (cancelled || !canvasRef.current) return
      const base = p.getViewport({ scale: 1 })
      const scale = (width / base.width) * window.devicePixelRatio
      const vp = p.getViewport({ scale })
      const canvas = canvasRef.current
      canvas.width = vp.width
      canvas.height = vp.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const t = p.render({ canvasContext: ctx, viewport: vp })
      task = t
      t.promise.catch(() => undefined)
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, page.page_no, width])

  const ordered = elements.filter((e) => e.bbox).sort((a, b) => a.reading_order - b.reading_order)
  const centers = ordered.map((e) => [((e.bbox!.x0 + e.bbox!.x1) / 2), ((e.bbox!.y0 + e.bbox!.y1) / 2)] as const)

  return (
    <div className="page-canvas" style={{ width, height }}>
      {pdf && <canvas ref={canvasRef} />}
      {!pdf && <span className="label">p.{page.page_no} (원본 이미지 없음)</span>}
      <svg viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
        {ordered.map((e) => {
          const b = e.bbox!
          const c = colorOf(e)
          const sel = e.element_id === selectedId
          return (
            <rect key={e.element_id} x={b.x0} y={b.y0} width={Math.max(1, b.x1 - b.x0)} height={Math.max(1, b.y1 - b.y0)}
              fill={c} fillOpacity={sel ? 0.35 : 0.15} stroke={c} strokeWidth={sel ? 2.5 : 1} vectorEffect="non-scaling-stroke"
              style={{ cursor: 'pointer' }} onClick={() => onSelect?.(e.element_id)}>
              <title>{`${e.element_id} [${e.type}] ${e.text.slice(0, 80)}`}</title>
            </rect>
          )
        })}
        {showOrder && centers.length > 1 && (
          <polyline points={centers.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="#e11d48" strokeWidth={1.2}
            vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />
        )}
        {showOrder && ordered.map((e, i) => (
          <text key={e.element_id} x={e.bbox!.x0 + 2} y={e.bbox!.y0 + 10} fontSize={Math.max(8, pw / 70)} fill="#e11d48" fontWeight={700}>{i + 1}</text>
        ))}
      </svg>
    </div>
  )
}
