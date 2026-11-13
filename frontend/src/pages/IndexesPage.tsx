import { useState } from 'react'
import { Link } from 'react-router-dom'
import { vapi } from '../api'
import { Badge, ConfirmModal, ErrorBanner, StatusBadge, fmtDate, useAsync, usePolling, Sid } from '../components/ui'
import type { QueryResult, VectorIndex } from '../types'

export default function IndexesPage() {
  const indexes = useAsync(() => vapi.indexes(), [])
  const [selId, setSelId] = useState<string>()
  const [removing, setRemoving] = useState<VectorIndex | null>(null)
  const [error, setError] = useState('')
  const running = indexes.data?.some((i) => i.status === 'queued' || i.status === 'running') ?? false
  usePolling(() => indexes.reload(), running, 1000)

  const sel = indexes.data?.find((i) => i.id === selId) ?? indexes.data?.find((i) => i.status === 'done')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>질의 테스트</h1>
          <p>
            적재된 컬렉션을 골라 질의로 어떤 청크가 검색되는지 확인합니다. 적재는 <Link to="/playground">청킹</Link> 화면(실행 하나)이나
            <Link to="/documents"> 문서 및 파싱</Link>의 일괄 적재(프로젝트 전체)에서, 비우기는 <Link to="/vector-stores">벡터 저장소</Link>에서 합니다.
          </p>
        </div>
      </div>
      <ErrorBanner error={error || indexes.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>인덱스 / 컬렉션</th><th>저장소</th><th>임베딩</th><th>적재 실행</th><th>청크</th><th>상태</th><th>소요</th><th>생성</th><th /></tr></thead>
          <tbody>
            {indexes.data?.map((ix) => (
              <tr key={ix.id} className="clickable" onClick={() => setSelId(ix.id)} style={ix.id === sel?.id ? { background: 'var(--accent-soft)' } : undefined}>
                <td><b>{ix.name}</b><div className="mono small muted">{ix.collection}</div></td>
                <td>{ix.store_name}</td>
                <td>{ix.embedding_model_name}<div className="small muted">{ix.dimension ? `${ix.dimension}차원 · ` : ''}{ix.metric}</div></td>
                <td className="small">{ix.run_ids.map((r) => <span key={r} style={{ marginRight: 4 }}><Sid id={r} /></span>)}</td>
                <td>{ix.chunk_count}</td>
                <td>
                  <StatusBadge status={ix.status} />
                  {(ix.status === 'running' || ix.status === 'queued') && ix.progress.total ? <div className="small muted">{ix.progress.phase === 'inserting' ? '적재' : '임베딩'} {ix.progress.done}/{ix.progress.total}</div> : null}
                  {ix.status === 'failed' && <div className="small" style={{ color: 'var(--danger)', maxWidth: 320 }}>{ix.error.slice(0, 300)}</div>}
                  {ix.warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--warn)' }}>⚠ {w}</div>)}
                </td>
                <td className="small">{ix.stats.embed_ms !== undefined ? <>임베딩 {ix.stats.embed_ms}ms<br />적재 {ix.stats.insert_ms}ms</> : '-'}</td>
                <td className="small muted">{fmtDate(ix.created_at)}</td>
                <td onClick={(e) => e.stopPropagation()} className="row">
                  <button className="sm" disabled={ix.status === 'queued' || ix.status === 'running'} onClick={() => setRemoving(ix)}>기록 삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {indexes.data?.length === 0 && <div className="empty">적재된 컬렉션이 없습니다. 청킹 화면이나 문서 및 파싱의 일괄 적재에서 적재하세요.</div>}
      </div>

      {sel && <QueryPanel key={sel.id} index={sel} />}

      {removing && (
        <ConfirmModal title="적재 기록 삭제" confirmLabel="기록 삭제" onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const ix = removing
            setRemoving(null)
            setError('')
            try { await vapi.deleteIndex(ix.id, false); if (selId === ix.id) setSelId(undefined); void indexes.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          }}>
          <p style={{ marginTop: 0 }}><b>{removing.name}</b> (<span className="mono">{removing.collection}</span>)의 Studio 적재 기록을 삭제할까요?</p>
          <p className="small">벡터 저장소의 실제 데이터는 <b>지우지 않습니다</b>. 이 목록과 질의 테스트에서만 사라집니다.</p>
          <p className="small muted" style={{ marginBottom: 0 }}>데이터까지 지우려면 <b>벡터 저장소 → 비우기</b>를 쓰세요(등록된 컬렉션). 예전 버전에서 만든 미등록 컬렉션의 기록을 정리할 때 이 버튼을 씁니다.</p>
        </ConfirmModal>
      )}
    </>
  )
}

function QueryPanel({ index }: { index: VectorIndex }) {
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(5)
  const [filter, setFilter] = useState('')
  const [useAcl, setUseAcl] = useState(false)
  const [principals, setPrincipals] = useState('')
  const principalList = principals.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const rerankers = useAsync(() => vapi.rerankModels(true), [])
  const [rerankId, setRerankId] = useState<string | ''>('')
  const [candidates, setCandidates] = useState<number | ''>('')
  const defaultCandidates = Math.min(200, Math.max(20, topK * 4))

  const run = async (q = query) => {
    if (!q.trim()) return
    setLoading(true)
    setError('')
    try {
      setResult(await vapi.query(index.id, {
        query: q, top_k: topK, filter, principals: useAcl ? principalList : null,
        rerank_model_id: rerankId === '' ? null : rerankId,
        rerank_candidates: rerankId === '' || candidates === '' ? null : candidates,
      }))
      setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 8))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  const maxScore = Math.max(...(result?.hits.map((h) => Math.abs(h.rerank_score ?? h.score)) ?? [1]), 1e-9)

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>질의 — {index.name} <span className="small muted mono">{index.collection}</span></h2>
      {index.status !== 'done' && <div className="banner warn">적재가 끝나지 않은 인덱스입니다 ({index.status})</div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run() }}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="예: 원격근무는 일주일에 며칠까지 가능한가요?" aria-label="질의" />
        <label className="row small">Top-K<input type="number" min={1} max={100} value={topK} onChange={(e) => setTopK(Number(e.target.value))} style={{ width: 64 }} /></label>
        <button className="primary" type="submit" disabled={loading || !query.trim()}>{loading ? '검색 중…' : '검색'}</button>
      </form>
      <div className="row small" style={{ marginTop: 6, flexWrap: 'nowrap' }}>
        <label className="check" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" checked={useAcl} onChange={(e) => setUseAcl(e.target.checked)} />권한 필터</label>
        <input className="grow mono" disabled={!useAcl} value={principals} onChange={(e) => setPrincipals(e.target.value)}
          placeholder="사용자의 권한 주체 — 예: user:hong, group:인사팀 (비우면 공개 청크만)" aria-label="사용자 권한 주체" />
      </div>
      {useAcl && <div className="small muted">공개(권한 목록 없음) 청크와, 권한 목록에 위 주체가 하나라도 있는 청크만 검색합니다. 이 기능 이전에 적재한 청크는 권한 정보가 없어 제외되니 다시 적재하세요.</div>}
      <div className="row small" style={{ marginTop: 6, flexWrap: 'nowrap' }}>
        <span style={{ whiteSpace: 'nowrap' }}>리랭크</span>
        <select aria-label="리랭크 모델" value={rerankId} onChange={(e) => setRerankId(e.target.value ? e.target.value : '')}>
          <option value="">사용 안 함 (벡터 점수 순)</option>
          {rerankers.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <label className="row" style={{ whiteSpace: 'nowrap' }}>후보 수
          <input type="number" min={1} max={200} disabled={rerankId === ''} value={candidates} placeholder={String(defaultCandidates)}
            onChange={(e) => setCandidates(e.target.value ? Number(e.target.value) : '')} style={{ width: 72 }} aria-label="리랭크 후보 수" />
        </label>
        {rerankId !== '' && <span className="muted">벡터 검색으로 후보 {candidates === '' ? defaultCandidates : candidates}개를 가져와 리랭크한 뒤 상위 {topK}개를 보여 줍니다</span>}
        {rerankers.data?.length === 0 && <span className="muted">사용 가능한 리랭크 모델이 없습니다 — <Link to="/rerank-models">리랭크 모델</Link>에서 등록·활성화하세요</span>}
      </div>
      {index.store_kind === 'milvus' && (
        <input style={{ marginTop: 6, width: '100%' }} className="mono" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder='Milvus 필터 (선택) — 예: document_id == "0193…"  /  metadata["doc_type"] == "사내 규정"  /  metadata["pages"][0] > 3' aria-label="필터" />
      )}
      {history.length > 0 && <div className="row small" style={{ marginTop: 6 }}>최근:{history.map((h) => <button key={h} className="sm ghost" onClick={() => { setQuery(h); void run(h) }}>{h}</button>)}</div>}
      <ErrorBanner error={error} />
      {result && (
        <div className="col" style={{ marginTop: 10 }}>
          {result.applied_filter && <div className="small muted mono">적용 필터: {result.applied_filter}</div>}
          {result.principals && !result.applied_filter && <div className="small muted">권한 필터: {result.principals.length ? result.principals.join(', ') : '공개 청크만'}</div>}
          <div className="small muted">
            결과 {result.hits.length}건 · 질의 임베딩 {result.embed_ms}ms · 검색 {result.search_ms}ms · {result.metric}{result.metric === 'L2' ? ' (작을수록 유사)' : ' (클수록 유사)'}
            {result.rerank && <> · 리랭크 <b>{result.rerank.model_name}</b> 후보 {result.rerank.candidates}개 {result.rerank.latency_ms}ms</>}
          </div>
          {result.warnings.map((w, i) => <div key={i} className="banner warn small" style={{ margin: 0 }}>{w}</div>)}
          {result.hits.map((h, i) => (
            <div key={h.id} className="card" style={{ padding: 10, margin: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <b>#{i + 1}</b>
                {h.rerank_score !== undefined ? (
                  <>
                    <span className="mono" style={{ minWidth: 64 }} title="리랭크 점수">{h.rerank_score.toFixed(4)}</span>
                    <div style={{ width: 80, height: 6, background: 'var(--surface-2)', borderRadius: 3 }}><div style={{ width: `${(Math.abs(h.rerank_score) / maxScore) * 100}%`, height: 6, background: 'var(--accent)', borderRadius: 3 }} /></div>
                    <span className="small muted mono" title="벡터 유사도 점수와 리랭크 전 순위">
                      벡터 {h.score.toFixed(4)} · #{h.vector_rank}
                      {h.vector_rank !== i + 1 && <span style={{ color: h.vector_rank > i + 1 ? 'var(--ok)' : 'var(--warn)' }}> {h.vector_rank > i + 1 ? '▲' : '▼'}{Math.abs(h.vector_rank - (i + 1))}</span>}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="mono" style={{ minWidth: 64 }}>{h.score.toFixed(4)}</span>
                    <div style={{ width: 80, height: 6, background: 'var(--surface-2)', borderRadius: 3 }}><div style={{ width: `${(Math.abs(h.score) / maxScore) * 100}%`, height: 6, background: 'var(--accent)', borderRadius: 3 }} /></div>
                  </>
                )}
                <b className="grow">{h.title || h.section_path || h.chunk_id}</b>
                <Badge>{h.chunk_id}</Badge>
                {h.metadata.tokens ? <Badge>{h.metadata.tokens}t</Badge> : null}
              </div>
              <div className="small muted" style={{ margin: '2px 0 6px' }}>
                {h.metadata.project_path?.length ? <span className="badge" style={{ marginRight: 4 }}>{h.metadata.project_path.join(' / ')}</span> : null}
                {h.metadata.public === false ? h.metadata.permissions?.map((p) => <span key={p} className="badge accent" style={{ marginRight: 4 }}>🔒 {p}</span>) : h.metadata.public ? <span className="badge ok" style={{ marginRight: 4 }}>공개</span> : null}
                {Object.entries(h.metadata.project_meta ?? {}).map(([k, v]) => <span key={k} className="badge" style={{ marginRight: 4 }}>{k}={Array.isArray(v) ? v.join(', ') : String(v)}</span>)}
                {h.metadata.document_title} · {h.section_path} · p.{h.metadata.pages?.join(',') || '-'} · {h.metadata.element_ids?.[0]}~{h.metadata.element_ids?.at(-1)}
                {' · '}<Link to={`/playground?doc=${h.document_id}&run=${h.run_id}`}>실행 <Sid id={h.run_id} />에서 보기</Link>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{h.text}</div>
              {h.metadata.text_truncated && <div className="small" style={{ color: 'var(--warn)' }}>⚠ 원문이 저장 한도로 잘렸습니다</div>}
              {h.embed_text !== h.text && <details><summary className="small muted">임베딩에 사용한 텍스트</summary><pre className="code-box">{h.embed_text}</pre></details>}
            </div>
          ))}
          {result.hits.length === 0 && <div className="empty">결과가 없습니다</div>}
        </div>
      )}
    </div>
  )
}
