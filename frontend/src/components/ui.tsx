import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fnRef.current())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}

/** cond가 true인 동안 interval마다 fn 실행 */
export function usePolling(fn: () => void | Promise<void>, cond: boolean, interval = 1000) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!cond) return
    const t = window.setInterval(() => void fnRef.current(), interval)
    return () => window.clearInterval(t)
  }, [cond, interval])
}

export function ErrorBanner({ error }: { error?: string }) {
  if (!error) return null
  return <div className="banner err">{error}</div>
}

export function Badge({ kind, children, title }: { kind?: 'ok' | 'warn' | 'err' | 'accent'; children: ReactNode; title?: string }) {
  return <span className={`badge ${kind ?? ''}`} title={title}>{children}</span>
}

export function StatusBadge({ status }: { status: string }) {
  const kind = ({ done: 'ok', production: 'ok', approved: 'accent', failed: 'err', running: 'warn', parsing: 'warn', converting: 'warn', queued: undefined, testing: 'warn' } as Record<string, 'ok' | 'warn' | 'err' | 'accent' | undefined>)[status]
  const label = ({ done: '완료', failed: '실패', running: '실행 중', queued: '대기', parsing: '파싱 중', converting: '변환 중' } as Record<string, string>)[status] ?? status
  return <Badge kind={kind}>{label}</Badge>
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(1000px, 100%)' } : undefined} role="dialog" aria-label={title}>
        <div className="row"><h2 className="grow">{title}</h2><button className="ghost" onClick={onClose} aria-label="닫기">✕</button></div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={`tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><b>{value}</b><span>{label}</span></div>
}

export function fmtDate(s?: string) {
  if (!s) return ''
  // SQLite는 타임존 없이 UTC를 돌려주므로 오프셋이 없으면 UTC로 해석
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
}

export function Histogram({ values, bins = 12 }: { values: number[]; bins?: number }) {
  if (!values.length) return <div className="muted small">데이터 없음</div>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const width = Math.max(1, Math.ceil((max - min + 1) / bins))
  const counts = Array.from({ length: bins }, () => 0)
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - min) / width))]++
  const peak = Math.max(...counts)
  return (
    <div>
      <div className="hist" aria-label="청크 토큰 분포">
        {counts.map((c, i) => (
          <div key={i} style={{ height: `${(c / peak) * 100}%` }} title={`${min + i * width}~${min + (i + 1) * width - 1} 토큰: ${c}개`} />
        ))}
      </div>
      <div className="hist-axis"><span>{min}</span><span>{max} 토큰</span></div>
    </div>
  )
}

/** UUID를 짧게 표시: 뒤 8자리(앞부분은 시각이라 비슷함). 전체 값은 마우스를 올리면 보인다 */
export const shortId = (id?: string | null) => (id ? `#${id.slice(-8)}` : '')
export function Sid({ id }: { id?: string | null }) {
  return <span className="mono" title={id ?? undefined}>{shortId(id)}</span>
}
