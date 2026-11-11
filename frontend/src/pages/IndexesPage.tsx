import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, vapi } from '../api'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, usePolling } from '../components/ui'
import type { QueryResult, VectorIndex } from '../types'

export default function IndexesPage() {
  const [sp, setSp] = useSearchParams()
  const presetRun = Number(sp.get('run')) || undefined
  const indexes = useAsync(() => vapi.indexes(), [])
  const [selId, setSelId] = useState<number>()
  const [creating, setCreating] = useState<boolean>(!!presetRun)
  const [appendFor, setAppendFor] = useState<VectorIndex | null>(null)
  const running = indexes.data?.some((i) => i.status === 'queued' || i.status === 'running') ?? false
  usePolling(() => indexes.reload(), running, 1000)

  const sel = indexes.data?.find((i) => i.id === selId) ?? indexes.data?.find((i) => i.status === 'done')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>벡터 인덱스 · 질의 테스트</h1>
          <p>청킹 실행 결과를 임베딩해 Milvus에 적재하고, 질의로 어떤 청크가 검색되는지 확인합니다. 청크 원문은 <code>text</code> 필드에 함께 저장됩니다.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>청크 적재</button>
      </div>
      <ErrorBanner error={indexes.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>인덱스 / 컬렉션</th><th>저장소</th><th>임베딩</th><th>적재 실행</th><th>청크</th><th>상태</th><th>소요</th><th>생성</th><th /></tr></thead>
          <tbody>
            {indexes.data?.map((ix) => (
              <tr key={ix.id} className="clickable" onClick={() => setSelId(ix.id)} style={ix.id === sel?.id ? { background: 'var(--accent-soft)' } : undefined}>
                <td><b>{ix.name}</b><div className="mono small muted">{ix.collection}</div></td>
                <td>{ix.store_name}</td>
                <td>{ix.embedding_model_name}<div className="small muted">{ix.dimension ? `${ix.dimension}차원 · ` : ''}{ix.metric}</div></td>
                <td className="small">{ix.run_ids.map((r) => <span key={r} style={{ marginRight: 4 }}>#{r}</span>)}</td>
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
                  <button className="sm" onClick={() => setAppendFor(ix)}>실행 추가</button>
                  <button className="sm danger" onClick={async () => {
                    const drop = confirm(`'${ix.collection}' 컬렉션을 저장소에서도 삭제할까요?\n확인: 컬렉션까지 삭제(되돌릴 수 없음) / 취소: 다음 단계에서 기록만 삭제 여부 선택`)
                    if (!drop && !confirm('컬렉션은 남기고 Studio의 인덱스 기록만 삭제할까요?')) return
                    await vapi.deleteIndex(ix.id, drop)
                    void indexes.reload()
                  }}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {indexes.data?.length === 0 && <div className="empty">인덱스가 없습니다. 청킹 실행 결과를 적재하세요.</div>}
      </div>

      {sel && <QueryPanel key={sel.id} index={sel} />}

      {creating && (
        <CreateIndexModal presetRun={presetRun} onClose={() => { setCreating(false); if (presetRun) setSp({}, { replace: true }) }}
          onCreated={(ix) => { setCreating(false); setSelId(ix.id); setSp({}, { replace: true }); void indexes.reload() }} />
      )}
      {appendFor && <AppendModal index={appendFor} onClose={() => setAppendFor(null)} onDone={() => { setAppendFor(null); void indexes.reload() }} />}
    </>
  )
}

function useRunPicker(presetRun?: number) {
  const docs = useAsync(() => api.documents(), [])
  const [docId, setDocId] = useState<number>()
  const [runId, setRunId] = useState<number | undefined>(presetRun)
  const runs = useAsync(() => (docId ? api.runs(docId) : Promise.resolve([])), [docId])
  useEffect(() => {
    if (presetRun && !docId) void api.run(presetRun).then((r) => setDocId(r.document_id))
  }, [presetRun, docId])
  useEffect(() => {
    if (!docId && !presetRun && docs.data?.length) setDocId(docs.data[0].id)
  }, [docs.data, docId, presetRun])
  const doneRuns = runs.data?.filter((r) => r.status === 'done' && (r.totals.chunk_count ?? 0) > 0) ?? []
  useEffect(() => {
    if (runs.data && !doneRuns.some((r) => r.id === runId)) setRunId(doneRuns[0]?.id)
  }, [runs.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = doneRuns.find((r) => r.id === runId)
  const picker = (
    <div className="grid-2">
      <label className="field">문서
        <select value={docId ?? ''} onChange={(e) => { setDocId(Number(e.target.value)); setRunId(undefined) }}>
          {docs.data?.map((d) => <option key={d.id} value={d.id}>{d.title} (#{d.id})</option>)}
        </select>
      </label>
      <label className="field">청킹 실행 (완료된 것만)
        <select value={runId ?? ''} onChange={(e) => setRunId(Number(e.target.value))}>
          {doneRuns.map((r) => <option key={r.id} value={r.id}>#{r.id} · {r.method === 'llm' ? `LLM ${r.prompt_label} · ${r.model_name}` : '규칙 baseline'} · 청크 {r.totals.chunk_count}개 · {fmtDate(r.created_at)}</option>)}
        </select>
        {runs.data && !doneRuns.length && <span className="small" style={{ color: 'var(--warn)' }}>완료된 청킹 실행이 없습니다. <Link to={`/playground?doc=${docId}`}>Playground에서 실행 →</Link></span>}
      </label>
    </div>
  )
  return { docId, runId, run, picker }
}

function CreateIndexModal({ presetRun, onClose, onCreated }: { presetRun?: number; onClose: () => void; onCreated: (ix: VectorIndex) => void }) {
  const { docId, runId, run, picker } = useRunPicker(presetRun)
  const meta = useAsync(() => vapi.indexMeta(), [])
  const models = useAsync(() => vapi.embeddingModels(true), [])
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [modelId, setModelId] = useState<number>()
  const [storeId, setStoreId] = useState<number>()
  const [collection, setCollection] = useState('')
  const [touched, setTouched] = useState(false)
  const [template, setTemplate] = useState('{text}')
  const [metric, setMetric] = useState('COSINE')
  const [mode, setMode] = useState('create')
  const [error, setError] = useState('')

  useEffect(() => { if (!modelId && models.data?.length) setModelId(models.data[0].id) }, [models.data, modelId])
  useEffect(() => {
    if (!storeId && stores.data?.length) setStoreId((stores.data.find((s) => s.kind === 'milvus' && s.enabled) ?? stores.data[0]).id)
  }, [stores.data, storeId])
  useEffect(() => { if (!touched && docId && runId) setCollection(`cs_doc${docId}_run${runId}`) }, [docId, runId, touched])

  const model = models.data?.find((m) => m.id === modelId)
  const store = stores.data?.find((s) => s.id === storeId)
  const tooLong = model && run?.totals.max_tokens && run.totals.max_tokens > model.max_input_tokens

  const submit = async () => {
    if (!runId || !modelId || !storeId) return
    setError('')
    try {
      onCreated(await vapi.createIndex({ run_id: runId, store_id: storeId, embedding_model_id: modelId, collection, embed_template: template, metric, mode }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title="청크 적재 (임베딩 → 벡터 저장소)" onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!runId || !modelId || !storeId || !collection} onClick={() => void submit()}>적재 시작</button></>}>
      <ErrorBanner error={error} />
      {picker}
      <div className="grid-3" style={{ marginTop: 8 }}>
        <label className="field">임베딩 모델
          <select value={modelId ?? ''} onChange={(e) => setModelId(Number(e.target.value))}>
            {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.dimension ? ` (${m.dimension}d)` : ''}</option>)}
          </select>
        </label>
        <label className="field">벡터 저장소
          <select value={storeId ?? ''} onChange={(e) => setStoreId(Number(e.target.value))}>
            {stores.data?.filter((s) => s.enabled).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">컬렉션 이름<input value={collection} onChange={(e) => { setTouched(true); setCollection(e.target.value) }} className="mono" /></label>
        <label className="field">유사도
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>{meta.data?.metrics.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="field">컬렉션이 이미 있으면
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="create">실패 (새로 만들 때만)</option>
            <option value="append">추가 (같은 실행은 교체)</option>
            <option value="recreate">삭제 후 다시 만들기</option>
          </select>
        </label>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <span className="small muted">임베딩 텍스트 템플릿 — 원문(text)은 그대로 저장하고, 벡터는 이 템플릿으로 만든 텍스트로 계산합니다</span>
        <div className="row">{meta.data?.templates.map((t) => <button key={t.label} className={`sm ${template === t.template ? 'primary' : ''}`} onClick={() => setTemplate(t.template)}>{t.label}</button>)}</div>
        <textarea rows={3} value={template} onChange={(e) => setTemplate(e.target.value)} />
        <span className="small muted">사용 가능: {meta.data?.template_fields.map((f) => <code key={f} style={{ marginRight: 6 }}>{`{${f}}`}</code>)}</span>
      </div>
      {tooLong && <div className="banner warn" style={{ marginTop: 8 }}>가장 큰 청크(~{run?.totals.max_tokens} 토큰)가 임베딩 모델 최대 입력({model?.max_input_tokens} 토큰)을 넘습니다. 잘리거나 실패할 수 있습니다.</div>}
      {store?.kind === 'memory' && <div className="banner info small" style={{ marginTop: 8 }}>메모리 저장소는 개발용입니다. 필터 검색은 지원하지 않습니다.</div>}
    </Modal>
  )
}

function AppendModal({ index, onClose, onDone }: { index: VectorIndex; onClose: () => void; onDone: () => void }) {
  const { runId, picker } = useRunPicker()
  const [error, setError] = useState('')
  return (
    <Modal wide title={`'${index.collection}'에 실행 추가`} onClose={onClose} footer={<><button onClick={onClose}>취소</button>
      <button className="primary" disabled={!runId} onClick={async () => { try { await vapi.appendRun(index.id, runId!); onDone() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }}>추가</button></>}>
      <ErrorBanner error={error} />
      <p className="small muted">같은 임베딩 모델({index.embedding_model_name})과 템플릿으로 임베딩해 추가합니다. 이미 들어 있는 실행이면 교체됩니다.</p>
      {picker}
    </Modal>
  )
}

function QueryPanel({ index }: { index: VectorIndex }) {
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(5)
  const [filter, setFilter] = useState('')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<string[]>([])

  const run = async (q = query) => {
    if (!q.trim()) return
    setLoading(true)
    setError('')
    try {
      setResult(await vapi.query(index.id, { query: q, top_k: topK, filter }))
      setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 8))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  const maxScore = Math.max(...(result?.hits.map((h) => Math.abs(h.score)) ?? [1]), 1e-9)

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>질의 테스트 — {index.name} <span className="small muted mono">{index.collection}</span></h2>
      {index.status !== 'done' && <div className="banner warn">적재가 끝나지 않은 인덱스입니다 ({index.status})</div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run() }}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="예: 원격근무는 일주일에 며칠까지 가능한가요?" aria-label="질의" />
        <label className="row small">Top-K<input type="number" min={1} max={100} value={topK} onChange={(e) => setTopK(Number(e.target.value))} style={{ width: 64 }} /></label>
        <button className="primary" type="submit" disabled={loading || !query.trim()}>{loading ? '검색 중…' : '검색'}</button>
      </form>
      {index.store_kind === 'milvus' && (
        <input style={{ marginTop: 6, width: '100%' }} className="mono" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder='Milvus 필터 (선택) — 예: run_id == 3  /  document_id in [1, 2]  /  metadata["doc_type"] == "사내 규정"' aria-label="필터" />
      )}
      {history.length > 0 && <div className="row small" style={{ marginTop: 6 }}>최근:{history.map((h) => <button key={h} className="sm ghost" onClick={() => { setQuery(h); void run(h) }}>{h}</button>)}</div>}
      <ErrorBanner error={error} />
      {result && (
        <div className="col" style={{ marginTop: 10 }}>
          <div className="small muted">결과 {result.hits.length}건 · 질의 임베딩 {result.embed_ms}ms · 검색 {result.search_ms}ms · {result.metric}{result.metric === 'L2' ? ' (작을수록 유사)' : ' (클수록 유사)'}</div>
          {result.warnings.map((w, i) => <div key={i} className="banner warn small" style={{ margin: 0 }}>{w}</div>)}
          {result.hits.map((h, i) => (
            <div key={h.id} className="card" style={{ padding: 10, margin: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <b>#{i + 1}</b>
                <span className="mono" style={{ minWidth: 64 }}>{h.score.toFixed(4)}</span>
                <div style={{ width: 80, height: 6, background: 'var(--surface-2)', borderRadius: 3 }}><div style={{ width: `${(Math.abs(h.score) / maxScore) * 100}%`, height: 6, background: 'var(--accent)', borderRadius: 3 }} /></div>
                <b className="grow">{h.title || h.section_path || h.chunk_id}</b>
                <Badge>{h.chunk_id}</Badge>
                {h.metadata.tokens ? <Badge>{h.metadata.tokens}t</Badge> : null}
              </div>
              <div className="small muted" style={{ margin: '2px 0 6px' }}>
                {h.metadata.document_title} · {h.section_path} · p.{h.metadata.pages?.join(',') || '-'} · {h.metadata.element_ids?.[0]}~{h.metadata.element_ids?.at(-1)}
                {' · '}<Link to={`/playground?doc=${h.document_id}&run=${h.run_id}`}>실행 #{h.run_id}에서 보기</Link>
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
