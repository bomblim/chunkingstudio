import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { TYPE_COLORS } from '../colors'
import { ElementDetail, TableView, TypeTag } from '../components/ElementViews'
import { PageCanvas, usePdf } from '../components/PageCanvas'
import { Badge, ErrorBanner, Stat, Tabs, fmtDate, useAsync } from '../components/ui'
import type { DocElement } from '../types'

type Tab = 'compare' | 'tree' | 'quality' | 'raw'

export default function DocumentViewerPage() {
  const id = useParams().id ?? ''
  const doc = useAsync(() => api.document(id), [id])
  const [tab, setTab] = useState<Tab>('compare')
  const d = doc.data

  if (doc.error) return <ErrorBanner error={doc.error} />
  if (!d) return <div className="empty">불러오는 중…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link to="/documents">문서</Link> /</div>
          <h1>{d.title}</h1>
          <p>
            {d.parser_name} {d.parser_version} · 유입 {d.source === 'test' ? 'Studio' : 'API'} · rev {d.revision} · {fmtDate(d.created_at)}
            {d.revisions.length > 1 && <> · 버전: {d.revisions.map((r) => <Link key={r.id} to={`/documents/${r.id}`} style={{ marginLeft: 4 }}>{r.id === d.id ? <b>r{r.revision}</b> : `r${r.revision}`}</Link>)}</>}
          </p>
        </div>
        <div className="row">
          <button className="danger" onClick={async () => { if (confirm('이 문서를 삭제할까요? 되돌릴 수 없습니다.')) { await api.deleteDocument(d.id); history.back() } }}>삭제</button>
          <Link className="btn" to={`/playground?doc=${d.id}`}>청킹 →</Link>
        </div>
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'compare', label: '원본 대조' }, { id: 'tree', label: '구조 트리' },
        { id: 'quality', label: '품질 지표' }, { id: 'raw', label: 'Raw JSON' },
      ]} />
      {tab === 'compare' && <CompareView elements={d.content.elements} pages={d.content.pages}
        fileUrl={d.source_kind === 'pdf' ? api.documentFileUrl(d.id) : null}
        pageImageUrl={d.source_kind === 'image' ? (n: number) => api.documentPageImageUrl(d.id, n) : null} />}
      {tab === 'tree' && <TreeView elements={d.content.elements} />}
      {tab === 'quality' && <QualityView stats={d.stats} />}
      {tab === 'raw' && <div className="card"><pre className="code-box" style={{ maxHeight: '70vh' }}>{JSON.stringify(d.content, null, 2)}</pre></div>}
    </>
  )
}

function CompareView({ elements, pages, fileUrl, pageImageUrl }: { elements: DocElement[]; pages: { page_no: number; width: number | null; height: number | null; image_ref: string | null }[]; fileUrl: string | null; pageImageUrl: ((pageNo: number) => string) | null }) {
  const pdf = usePdf(fileUrl)
  const [selected, setSelected] = useState<string | null>(null)
  const [types, setTypes] = useState<string[]>([])
  const [showOrder, setShowOrder] = useState(false)
  const pageNos = pages.length ? pages.map((p) => p.page_no) : [...new Set(elements.map((e) => e.page ?? 1))]
  const [pageNo, setPageNo] = useState(pageNos[0] ?? 1)
  const hasBbox = elements.some((e) => e.bbox)
  const listRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const [pageWidth, setPageWidth] = useState(560)
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPageWidth(Math.max(240, Math.min(800, el.clientWidth - 30))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const sorted = useMemo(() => [...elements].sort((a, b) => a.reading_order - b.reading_order), [elements])
  const visible = sorted.filter((e) => (!types.length || types.includes(e.type)) && (!hasBbox || (e.page ?? 1) === pageNo))
  const sel = elements.find((e) => e.element_id === selected)
  const allTypes = [...new Set(elements.map((e) => e.type))]

  const select = (eid: string) => {
    setSelected(eid)
    const el = elements.find((e) => e.element_id === eid)
    if (el?.page && el.page !== pageNo && hasBbox) setPageNo(el.page)
  }
  useEffect(() => {
    if (selected) listRef.current?.querySelector(`[data-eid="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected, pageNo])

  const page = pages.find((p) => p.page_no === pageNo) ?? { page_no: pageNo, width: null, height: null, image_ref: null }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="small muted">타입</span>
        {allTypes.map((t) => (
          <label key={t} className="check small">
            <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes((s) => e.target.checked ? [...s, t] : s.filter((x) => x !== t))} />
            <span style={{ color: TYPE_COLORS[t] }}>■</span>{t}
          </label>
        ))}
        <span className="spacer" />
        {hasBbox && <label className="check small"><input type="checkbox" checked={showOrder} onChange={(e) => setShowOrder(e.target.checked)} />읽기 순서 표시</label>}
        {hasBbox && (
          <div className="row">
            <button className="sm" disabled={pageNos.indexOf(pageNo) <= 0} onClick={() => setPageNo(pageNos[pageNos.indexOf(pageNo) - 1])}>◀</button>
            <select aria-label="페이지" value={pageNo} onChange={(e) => setPageNo(Number(e.target.value))}>
              {pageNos.map((p) => <option key={p} value={p}>p.{p}</option>)}
            </select>
            <button className="sm" disabled={pageNos.indexOf(pageNo) >= pageNos.length - 1} onClick={() => setPageNo(pageNos[pageNos.indexOf(pageNo) + 1])}>▶</button>
          </div>
        )}
      </div>
      <div className="viewer">
        <div className="card scroll" style={{ maxHeight: '75vh' }} ref={paneRef}>
          {hasBbox ? (
            <PageCanvas page={page} elements={elements.filter((e) => (e.page ?? 1) === pageNo && (!types.length || types.includes(e.type)))} pdf={pdf} imageUrl={pageImageUrl?.(pageNo) ?? null} width={pageWidth}
              colorOf={(e) => TYPE_COLORS[e.type] ?? '#888'} selectedId={selected} onSelect={select} showOrder={showOrder} />
          ) : (
            <div className="banner info">이 Parser 결과에는 bbox 좌표가 없어 원본 페이지 오버레이를 표시할 수 없습니다. 오른쪽 텍스트 뷰로 확인하세요.</div>
          )}
          {sel && <div className="card"><ElementDetail el={sel} /></div>}
        </div>
        <div className="card scroll el-list" style={{ maxHeight: '75vh' }} ref={listRef}>
          {visible.map((e) => (
            <div key={e.element_id} data-eid={e.element_id} className={`el-row ${e.element_id === selected ? 'selected' : ''}`}
              style={{ borderLeftColor: TYPE_COLORS[e.type] ?? '#888', marginLeft: e.type === 'heading' ? 0 : 8 }}
              onClick={() => select(e.element_id)}>
              <div className="meta">{e.element_id} · {e.type}{e.level ? ` L${e.level}` : ''} · p.{e.page ?? '-'}{e.confidence !== null && e.confidence < 0.5 ? ' · ⚠ 저신뢰' : ''}</div>
              {e.type === 'table' ? <TableView el={e} /> : <div className="txt" style={e.type === 'heading' || e.type === 'title' ? { fontWeight: 700 } : undefined}>{e.text}</div>}
            </div>
          ))}
          {!visible.length && <div className="empty">표시할 Element가 없습니다</div>}
        </div>
      </div>
    </>
  )
}

interface TreeNode { el: DocElement; children: TreeNode[]; bodyCount: number }

function TreeView({ elements }: { elements: DocElement[] }) {
  const roots = useMemo(() => {
    const nodes = new Map<string, TreeNode>()
    const sorted = [...elements].sort((a, b) => a.reading_order - b.reading_order)
    for (const e of sorted) if (e.type === 'heading' || e.type === 'title') nodes.set(e.element_id, { el: e, children: [], bodyCount: 0 })
    const top: TreeNode[] = []
    let bodyTop = 0
    for (const e of sorted) {
      const node = nodes.get(e.element_id)
      const parent = e.parent_id ? nodes.get(e.parent_id) : undefined
      if (node) (parent ? parent.children : top).push(node)
      else if (parent) parent.bodyCount++
      else bodyTop++
    }
    return { top, bodyTop }
  }, [elements])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sel, setSel] = useState<DocElement | null>(null)

  const render = (nodes: TreeNode[]) => (
    <ul>
      {nodes.map((n) => {
        const closed = open[n.el.element_id] === false
        return (
          <li key={n.el.element_id}>
            <span className="node" onClick={() => setSel(n.el)}>
              {n.children.length > 0 && <button className="ghost sm" onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [n.el.element_id]: closed })) }} aria-label={closed ? '펼치기' : '접기'}>{closed ? '▸' : '▾'}</button>}
              <b>{n.el.text}</b> <span className="muted small mono">{n.el.element_id}</span> {n.bodyCount > 0 && <Badge>본문 {n.bodyCount}</Badge>}
            </span>
            {!closed && n.children.length > 0 && render(n.children)}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="grid-2">
      <div className="card tree">
        {roots.bodyTop > 0 && <div className="small muted">상위 heading이 없는 본문 {roots.bodyTop}개</div>}
        {roots.top.length ? render(roots.top) : <div className="empty">heading 구조가 없습니다 (parent_id 미제공)</div>}
      </div>
      <div className="card">
        {sel ? <ElementDetail el={sel} /> : <div className="muted">heading을 선택하면 상세가 표시됩니다</div>}
      </div>
    </div>
  )
}

function QualityView({ stats }: { stats: import('../types').DocStats }) {
  const perPage = Object.entries(stats.chars_per_page)
  const maxChars = Math.max(1, ...perPage.map(([, v]) => v))
  return (
    <div className="grid-2">
      <div className="card">
        <div className="grid-3">
          <Stat label="Element" value={stats.element_count} />
          <Stat label="페이지" value={stats.page_count} />
          <Stat label="문자 수" value={stats.char_count.toLocaleString()} />
          <Stat label="표" value={stats.table_count} />
          <Stat label="그림" value={stats.figure_count} />
          <Stat label="저신뢰 Element" value={stats.low_confidence_count} />
        </div>
        <h3 style={{ marginTop: 16 }}>타입 분포</h3>
        <div className="row">{Object.entries(stats.type_counts).map(([t, c]) => <span key={t} className="row" style={{ gap: 4 }}><TypeTag type={t} />{c}</span>)}</div>
        {stats.empty_pages.length > 0 && <div className="banner warn" style={{ marginTop: 12 }}>빈 페이지: {stats.empty_pages.join(', ')}</div>}
      </div>
      <div className="card">
        <h3>페이지별 텍스트량</h3>
        {perPage.map(([p, v]) => (
          <div key={p} className="row small" style={{ gap: 6 }}>
            <span className="mono" style={{ width: 40 }}>p.{p}</span>
            <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 3 }}><div style={{ width: `${(v / maxChars) * 100}%`, background: v ? 'var(--accent)' : 'var(--danger)', height: 10, borderRadius: 3 }} /></div>
            <span style={{ width: 60, textAlign: 'right' }}>{v.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
