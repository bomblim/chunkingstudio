import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, usePolling } from '../components/ui'
import type { ParseJob } from '../types'

export default function DocumentsPage() {
  const [filters, setFilters] = useState<{ parser_id?: number; source?: string; q?: string }>({})
  const [q, setQ] = useState('')
  const docs = useAsync(() => api.documents(filters), [JSON.stringify(filters)])
  const parsers = useAsync(() => api.parsers(), [])
  const [showUpload, setShowUpload] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const navigate = useNavigate()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>문서</h1>
          <p>운영 유입된 Parser 결과와 테스트 파싱 결과를 표준 스키마로 확인합니다.</p>
        </div>
        <div className="row">
          <button onClick={() => setShowImport(true)}>결과 JSON 가져오기</button>
          <button className="primary" onClick={() => setShowUpload(true)}>테스트 문서 업로드</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); setFilters((f) => ({ ...f, q })) }}>
            <input className="grow" placeholder="제목·본문 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="검색어" />
            <button type="submit">검색</button>
          </form>
          <select aria-label="Parser 필터" value={filters.parser_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, parser_id: e.target.value ? Number(e.target.value) : undefined }))}>
            <option value="">모든 Parser</option>
            {parsers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="유입 구분 필터" value={filters.source ?? ''} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value || undefined }))}>
            <option value="">전체 유입</option>
            <option value="runtime">운영</option>
            <option value="test">테스트</option>
          </select>
        </div>
        <ErrorBanner error={docs.error} />
        <table className="list">
          <thead>
            <tr><th>제목</th><th>Parser</th><th>유입</th><th>Element</th><th>페이지</th><th>표/그림</th><th>품질</th><th>등록</th><th /></tr>
          </thead>
          <tbody>
            {docs.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`)}>
                <td><b>{d.title}</b>{d.revision > 1 && <> <Badge>rev {d.revision}</Badge></>}{d.doc_type && <div className="small muted">{d.doc_type}</div>}</td>
                <td>{d.parser_name} <span className="muted small">{d.parser_version}</span></td>
                <td>{d.source === 'test' ? <Badge kind="warn">테스트</Badge> : <Badge kind="accent">운영</Badge>}</td>
                <td>{d.stats.element_count}</td>
                <td>{d.stats.page_count}</td>
                <td>{d.stats.table_count} / {d.stats.figure_count}</td>
                <td>
                  {d.stats.empty_pages.length > 0 && <Badge kind="warn">빈 페이지 {d.stats.empty_pages.length}</Badge>}{' '}
                  {d.stats.low_confidence_count > 0 && <Badge kind="warn">저신뢰 {d.stats.low_confidence_count}</Badge>}{' '}
                  {!d.stats.has_bbox && <Badge>bbox 없음</Badge>}
                </td>
                <td className="small muted">{fmtDate(d.created_at)}</td>
                <td onClick={(e) => e.stopPropagation()}><Link to={`/playground?doc=${d.id}`}>청킹 →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {docs.data?.length === 0 && <div className="empty">문서가 없습니다. 테스트 문서를 업로드하거나 Parser 결과를 가져오세요.</div>}
      </div>

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={() => void docs.reload()} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => void docs.reload()} />}
    </>
  )
}

/** IN-02: 테스트 문서 업로드 → Parser API 직접 호출 → 결과 확인 */
function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const parsers = useAsync(() => api.parsers(), [])
  const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [params, setParams] = useState('{}')
  const [docType, setDocType] = useState('')
  const [jobs, setJobs] = useState<ParseJob[]>([])
  const [error, setError] = useState('')
  const callable = parsers.data?.filter((p) => p.test_callable && p.enabled) ?? []
  const running = jobs.some((j) => !['done', 'failed'].includes(j.status))

  usePolling(async () => {
    const next = await api.parseJobs(jobs.map((j) => j.id))
    setJobs(next)
    if (next.every((j) => ['done', 'failed'].includes(j.status))) onDone()
  }, running)

  const submit = async () => {
    if (!file || !selected.length) return
    setError('')
    try {
      JSON.parse(params || '{}')
    } catch {
      setError('파라미터는 JSON이어야 합니다')
      return
    }
    const form = new FormData()
    form.append('file', file)
    form.append('parser_ids', selected.join(','))
    form.append('params', params || '{}')
    form.append('doc_type', docType)
    try {
      setJobs(await api.testParse(form))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="테스트 문서 업로드" onClose={onClose} footer={
      <>
        <button onClick={onClose}>닫기</button>
        <button className="primary" disabled={!file || !selected.length || running} onClick={() => void submit()}>Parser 호출</button>
      </>
    }>
      <p className="muted small">선택한 Parser의 API를 Studio가 직접 호출하고, 결과를 표준 스키마로 변환해 테스트 영역에 저장합니다. 여러 Parser를 고르면 결과를 비교할 수 있습니다.</p>
      <ErrorBanner error={error || parsers.error} />
      <div className="col">
        <label className="field">문서 파일<input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <div className="field">
          <span className="small muted">Parser (API 호출 가능한 Parser만 표시)</span>
          {callable.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} />
              {p.name} <span className="muted small">v{p.version} · {p.input_formats.join(', ')}</span>
            </label>
          ))}
          {parsers.data && !callable.length && <span className="muted">API가 등록된 Parser가 없습니다. Parser Registry에서 등록하세요.</span>}
        </div>
        <label className="field">문서 유형 (선택)<input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="예: 사내 규정" /></label>
        <label className="field">Parser 파라미터 (JSON)<textarea rows={3} value={params} onChange={(e) => setParams(e.target.value)} /></label>
      </div>
      {jobs.length > 0 && (
        <table className="list" style={{ marginTop: 12 }}>
          <thead><tr><th>Parser</th><th>상태</th><th>시간</th><th>결과</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.parser_name ?? j.parser_id}</td>
                <td><StatusBadge status={j.status} />{j.error_kind && <div className="small" style={{ color: 'var(--danger)' }}>{({ parser_error: 'Parser 오류', timeout: '타임아웃', adapter_error: '스키마 변환 실패', config_error: '설정 오류' } as Record<string, string>)[j.error_kind] ?? j.error_kind}: {j.error.slice(0, 200)}</div>}</td>
                <td>{j.elapsed_ms ? `${(j.elapsed_ms / 1000).toFixed(1)}초` : '-'}</td>
                <td>
                  {j.document_id && <Link to={`/documents/${j.document_id}`}>결과 보기</Link>}{' '}
                  {j.status !== 'queued' && j.status !== 'parsing' && <a href={api.parseJobRawUrl(j.id)} target="_blank" rel="noreferrer" className="small">원본 응답</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

/** IN-01: Parser 결과(JSON/JSONL) 배치 가져오기 */
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const parsers = useAsync(() => api.parsers(), [])
  const failures = useAsync(() => api.ingestFailures(), [])
  const [parserId, setParserId] = useState<number | ''>('')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<{ imported: number; failed: { title: string; reason: string }[] } | null>(null)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!file || !parserId) return
    const form = new FormData()
    form.append('parser_id', String(parserId))
    form.append('file', file)
    try {
      const r = await api.ingestBatch(form)
      setResult({ imported: r.imported.length, failed: r.failed })
      onDone()
      void failures.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="Parser 결과 가져오기" onClose={onClose} footer={
      <>
        <button onClick={onClose}>닫기</button>
        <button className="primary" disabled={!file || !parserId} onClick={() => void submit()}>가져오기</button>
      </>
    }>
      <p className="muted small">운영 Parser가 만든 결과 파일(JSON 1건/배열, JSONL)을 선택한 Parser의 어댑터로 변환해 저장합니다. API push는 <code>POST /api/ingest</code>를 사용하세요.</p>
      <ErrorBanner error={error} />
      <div className="col">
        <label className="field">Parser
          <select value={parserId} onChange={(e) => setParserId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">선택</option>
            {parsers.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.adapter})</option>)}
          </select>
        </label>
        <label className="field">결과 파일<input type="file" accept=".json,.jsonl" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      {result && (
        <div className={`banner ${result.failed.length ? 'warn' : 'info'}`} style={{ marginTop: 12 }}>
          {result.imported}건 저장, {result.failed.length}건 실패
          {result.failed.map((f) => <div key={f.title} className="small">{f.title}: {f.reason}</div>)}
        </div>
      )}
      {!!failures.data?.length && (
        <details style={{ marginTop: 12 }}>
          <summary>격리된 유입 실패 {failures.data.length}건</summary>
          <table className="list">
            <tbody>{failures.data.slice(0, 20).map((f) => <tr key={f.id}><td>{f.source_name}</td><td className="small">{f.reason}</td><td className="small muted">{fmtDate(f.created_at)}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </Modal>
  )
}
