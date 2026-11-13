import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { vapi } from '../api'
import { Badge, ErrorBanner, Modal, Sid, useAsync, useRefreshOnFocus } from '../components/ui'
import type { CollectionContents, StoredChunk } from '../types'

const PAGE = 30

/** 저장소: 컬렉션에 실제로 적재된 문서·청크를 훑어본다 (질의 없이) */
export default function StoragePage() {
  const [sp, setSp] = useSearchParams()
  const stores = useAsync(() => vapi.vectorStores(), [])
  const collId = sp.get('collection') ?? ''
  const docId = sp.get('doc') ?? ''
  const [offset, setOffset] = useState(0)
  const setParam = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })

  const all = stores.data?.flatMap((s) => s.collections.map((c) => ({ store: s, coll: c }))) ?? []
  useEffect(() => {
    // 처음 들어오면 적재된 청크가 있는 첫 컬렉션(없으면 기본 컬렉션)을 고른다
    if (!collId && all.length) {
      const pick = all.find((x) => x.coll.chunk_count) ?? all.find((x) => x.coll.is_default) ?? all[0]
      setParam('collection', pick.coll.id)
    }
  }, [stores.data]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setOffset(0), [collId, docId])

  const contents = useAsync<CollectionContents | null>(
    () => (collId ? vapi.collectionContents(collId, { document_id: docId || undefined, limit: PAGE, offset }) : Promise.resolve(null)),
    [collId, docId, offset],
  )
  const c = contents.data
  // 컬렉션 목록의 청크 수와 내용을 함께 최신으로 (다른 화면에서 비우기·적재한 뒤 돌아와도 맞게)
  useEffect(() => { void stores.reload() }, [collId]) // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshOnFocus(() => { void stores.reload(); void contents.reload() })
  const docTitle = c?.documents.find((d) => d.document_id === docId)?.title

  return (
    <>
      <div className="page-head">
        <div>
          <h1>저장소</h1>
          <p>벡터 저장소의 컬렉션에 적재된 문서와 청크를 그대로 확인합니다. 검색 결과를 보려면 <Link to="/indexes">질의 테스트</Link>를 쓰세요.</p>
        </div>
        <label className="field" style={{ minWidth: 320 }}>컬렉션
          <select value={collId} onChange={(e) => { setParam('doc', ''); setParam('collection', e.target.value) }}>
            {stores.data?.filter((s) => s.collections.length).map((s) => (
              <optgroup key={s.id} label={s.name}>
                {s.collections.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}{col.is_default ? ' (기본)' : ''} — 청크 {col.chunk_count ?? 0}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <ErrorBanner error={stores.error || contents.error || c?.error} />

      {c && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 14 }}>
            <span><b>{c.store.name}</b> / <span className="mono">{c.collection.name}</span>{c.collection.is_default && <> <Badge kind="accent">기본</Badge></>}</span>
            <span>청크 <b>{c.total}</b>개{docId && ' (선택한 문서)'}</span>
            <span>문서 <b>{c.documents.length}</b>개</span>
            {c.embedding_model && <span className="small muted">임베딩 {c.embedding_model}{c.index?.dimension ? ` · ${c.index.dimension}차원` : ''} · {c.index?.metric}</span>}
            {!c.exists && <Badge kind="warn">벡터 저장소에 아직 없음 (적재 전)</Badge>}
          </div>
          {c.index?.embed_template && <div className="small muted" style={{ marginTop: 4 }}>임베딩 텍스트 템플릿: <code>{c.index.embed_template.replace(/\n/g, '⏎')}</code></div>}
          {c.index?.warnings?.map((w, i) => <div key={i} className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>⚠ {w}</div>)}
        </div>
      )}

      {c && (
        <div className="storage-layout">
          <div className="card scroll" style={{ maxHeight: '75vh' }}>
            <h3 style={{ marginTop: 0 }}>문서</h3>
            <div className={`ptree-row ${!docId ? 'selected' : ''}`} onClick={() => setParam('doc', '')} role="button">
              <span className="grow">전체</span><span className="ptree-count">{c.documents.reduce((n, d) => n + (d.chunk_count ?? 0), 0)}</span>
            </div>
            {c.documents.map((d) => (
              <div key={d.document_id} className={`ptree-row ${docId === d.document_id ? 'selected' : ''}`} onClick={() => setParam('doc', d.document_id)} role="button" title={d.title}>
                <span className="grow ptree-label">{d.title}{d.project_path.length > 0 && <div className="small muted">{d.project_path.join(' / ')}</div>}</span>
                <span className="ptree-count">{d.chunk_count ?? '-'}</span>
              </div>
            ))}
            {c.documents.length === 0 && <div className="empty small">Studio에서 적재한 문서 기록이 없습니다.</div>}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="small muted grow">
                {docTitle ? <>문서 <b>{docTitle}</b>의 청크</> : '전체 청크'} · {c.total ? `${offset + 1}–${Math.min(offset + PAGE, c.total)} / ${c.total}` : '0건'}
              </span>
              <button className="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>◀ 이전</button>
              <button className="sm" disabled={offset + PAGE >= c.total} onClick={() => setOffset(offset + PAGE)}>다음 ▶</button>
            </div>
            {contents.loading && <div className="small muted">불러오는 중…</div>}
            {c.items.map((it) => <ChunkCard key={it.id} item={it} />)}
            {c.exists && c.items.length === 0 && !contents.loading && <div className="empty">적재된 청크가 없습니다.</div>}
            {!c.exists && <div className="empty">이 컬렉션은 아직 만들어지지 않았습니다. 문서를 적재하면 생깁니다.</div>}
          </div>
        </div>
      )}
      {stores.data && !all.length && <div className="empty">등록된 컬렉션이 없습니다. 관리 → 벡터 저장소에서 컬렉션을 추가하세요.</div>}
    </>
  )
}

function ChunkCard({ item }: { item: StoredChunk }) {
  const [open, setOpen] = useState(false)
  const [metaOpen, setMetaOpen] = useState(false)
  const m = item.metadata ?? {}
  const long = (item.text ?? '').length > 600
  return (
    <div className="card" style={{ padding: 10, margin: '0 0 8px' }}>
      <div className="row" style={{ gap: 8 }}>
        <Badge>{item.chunk_id}</Badge>
        <b className="grow">{item.title || item.section_path || '(제목 없음)'}</b>
        {m.tokens ? <Badge>{m.tokens}t</Badge> : null}
        <button className="sm" onClick={() => setMetaOpen(true)}>메타데이터</button>
        {m.public === false
          ? (m.permissions ?? []).map((p) => <span key={p} className="badge accent">🔒 {p}</span>)
          : m.public ? <span className="badge ok">공개</span> : null}
      </div>
      <div className="small muted" style={{ margin: '2px 0 6px' }}>
        {m.document_title} · {item.section_path || '-'} · p.{m.pages?.join(',') || '-'} · {m.element_ids?.[0]}~{m.element_ids?.at(-1)}
        {m.project_path?.length ? <> · {m.project_path.join(' / ')}</> : null}
        {' · '}<Link to={`/playground?doc=${item.document_id}&run=${item.run_id}`}>실행 <Sid id={String(item.run_id)} /></Link>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', maxHeight: open ? undefined : 160, overflow: 'hidden' }}>{item.text}</div>
      {(long || item.embed_text !== item.text) && (
        <div className="row small" style={{ marginTop: 4, gap: 10 }}>
          {long && <button className="sm ghost" onClick={() => setOpen(!open)}>{open ? '접기' : '전체 보기'}</button>}
          {item.embed_text !== item.text && <details><summary className="muted">임베딩에 사용한 텍스트</summary><pre className="code-box">{item.embed_text}</pre></details>}
        </div>
      )}
      {metaOpen && <MetadataModal item={item} onClose={() => setMetaOpen(false)} />}
    </div>
  )
}

/** 청크 메타데이터 보기 (레이어 팝업): 주요 필드 표 + 저장된 값 전체(JSON) */
function MetadataModal({ item, onClose }: { item: StoredChunk; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const m = (item.metadata ?? {}) as Record<string, unknown>
  const fields: [string, unknown][] = [
    ['id', item.id], ['chunk_id', item.chunk_id], ['run_id', item.run_id], ['document_id', item.document_id],
    ['title', item.title], ['section_path', item.section_path],
  ]
  const json = JSON.stringify({ ...item, text: undefined, embed_text: undefined, metadata: m }, null, 2)
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? <span className="muted">-</span>
    : typeof v === 'object' ? <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(v)}</code>
    : <span style={{ wordBreak: 'break-all' }}>{String(v)}</span>)
  const copy = async () => { try { await navigator.clipboard.writeText(json); setCopied(true) } catch { /* 클립보드 권한 없음 */ } }
  return (
    <Modal wide title={`메타데이터 — ${item.chunk_id}${item.title ? ` · ${item.title}` : ''}`} onClose={onClose}
      footer={<><button onClick={() => void copy()}>{copied ? '복사됨' : 'JSON 복사'}</button><button className="primary" onClick={onClose}>닫기</button></>}>
      <h3 style={{ marginTop: 0 }}>필드</h3>
      <table className="list">
        <tbody>{fields.map(([k, v]) => <tr key={k}><td className="mono small" style={{ width: 160 }}>{k}</td><td className="small">{show(v)}</td></tr>)}</tbody>
      </table>
      <h3>metadata</h3>
      <table className="list">
        <tbody>
          {Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
            <tr key={k}><td className="mono small" style={{ width: 160 }}>{k}</td><td className="small">{show(v)}</td></tr>
          ))}
        </tbody>
      </table>
      {Object.keys(m).length === 0 && <div className="empty small">metadata가 비어 있습니다.</div>}
      <details style={{ marginTop: 10 }}>
        <summary className="small muted">저장된 값 전체 (JSON, 원문 제외)</summary>
        <pre className="code-box" style={{ maxHeight: 320, overflow: 'auto' }}>{json}</pre>
      </details>
    </Modal>
  )
}
