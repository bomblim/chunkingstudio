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
  /** 이미지 원본(PDF가 아닐 때): 해당 페이지 이미지 URL */
  imageUrl?: string | null
  width: number
  colorOf: (el: DocElement) => string
  selectedId?: string | null
  onSelect?: (id: string) => void
  showOrder?: boolean
}

/** PV-01/PV-05: 원본 페이지 위에 Element bbox를 색상 오버레이, reading_order 표시 */
export function PageCanvas({ page, elements, pdf, imageUrl, width, colorOf, selectedId, onSelect, showOrder }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pdfAspect, setPdfAspect] = useState<number | null>(null)
  const [imgState, setImgState] = useState<{ url: string; aspect: number | null; failed: boolean } | null>(null)
  const img = imageUrl && !pdf ? (imgState?.url === imageUrl ? imgState : { url: imageUrl, aspect: null, failed: false }) : null
  // 상대좌표(0~1, 예: Upstage): 페이지 크기가 1 이하로 기록되었거나, 크기 정보 없이 모든 좌표가 0~1 범위
  const maxCoord = Math.max(0, ...elements.map((e) => Math.max(e.bbox?.x1 ?? 0, e.bbox?.y1 ?? 0)))
  const relative = (page.width != null && page.width <= 1.5) || (page.width == null && maxCoord > 0 && maxCoord <= 1.0001)
  const pw = relative ? 1 : page.width ?? Math.max(612, ...elements.map((e) => e.bbox?.x1 ?? 0))
  const ph = relative ? 1 : page.height ?? Math.max(792, ...elements.map((e) => e.bbox?.y1 ?? 0))
  // 원본(PDF 페이지·이미지)이 있으면 그 비율을, 상대좌표인데 원본이 없으면 A4 세로 비율을 쓴다.
  // SVG는 preserveAspectRatio="none"이라 좌표계가 컨테이너에 맞춰 늘어난다.
  const height = width * ((pdf ? pdfAspect : img?.aspect) ?? (relative ? Math.SQRT2 : ph / pw))

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let task: { cancel: () => void } | null = null
    let cancelled = false
    void pdf.getPage(page.page_no).then((p) => {
      if (cancelled || !canvasRef.current) return
      const base = p.getViewport({ scale: 1 })
      setPdfAspect(base.height / base.width)
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
      {img && !img.failed && (
        <img src={img.url} alt={`p.${page.page_no} 원본`} draggable={false}
          onLoad={(e) => { const t = e.currentTarget; setImgState({ url: img.url, aspect: t.naturalHeight / t.naturalWidth, failed: false }) }}
          onError={() => setImgState({ url: img.url, aspect: null, failed: true })} />
      )}
      {!pdf && (!img || img.failed) && <span className="label">p.{page.page_no} ({img?.failed ? '원본 이미지를 불러오지 못함' : '원본 이미지 없음'})</span>}
      <svg viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
        {ordered.map((e) => {
          const b = e.bbox!
          const c = colorOf(e)
          const sel = e.element_id === selectedId
          return (
            <rect key={e.element_id} x={b.x0} y={b.y0} width={Math.max(pw * 0.002, b.x1 - b.x0)} height={Math.max(ph * 0.002, b.y1 - b.y0)}
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
          <text key={e.element_id} x={e.bbox!.x0 + pw * 0.004} y={e.bbox!.y0 + ph * 0.014} fontSize={pw / 70} fill="#e11d48" fontWeight={700}>{i + 1}</text>
        ))}
      </svg>
    </div>
  )
}
