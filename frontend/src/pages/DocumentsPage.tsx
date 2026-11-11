import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, papi } from '../api'
import { ProjectSettingsModal } from '../components/ProjectSettings'
import { ProjectTreeView, projectOptions, type ProjectSelection } from '../components/ProjectTree'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, usePolling } from '../components/ui'
import type { ParseJob, Project } from '../types'

function parseSelection(v: string | null): ProjectSelection {
  if (v === 'unassigned') return 'unassigned'
  const n = Number(v)
  return n > 0 ? n : 'all'
}

export default function DocumentsPage() {
  const [sp, setSp] = useSearchParams()
  const selection = parseSelection(sp.get('project'))
  const setSelection = (v: ProjectSelection) => setSp((p) => { const n = new URLSearchParams(p); if (v === 'all') n.delete('project'); else n.set('project', String(v)); return n }, { replace: true })

  const [filters, setFilters] = useState<{ parser_id?: number; source?: string; q?: string }>({})
  const [q, setQ] = useState('')
  const tree = useAsync(() => papi.projects(), [])
  const docQuery = { ...filters, ...(selection === 'unassigned' ? { unassigned: true } : selection === 'all' ? {} : { project_id: selection }) }
  const docs = useAsync(() => api.documents(docQuery), [JSON.stringify(docQuery)])
  const parsers = useAsync(() => api.parsers(), [])
  const [showUpload, setShowUpload] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editing, setEditing] = useState<{ project?: Project; parentId?: number | null } | null>(null)
  const [checked, setChecked] = useState<number[]>([])
  const [moveTarget, setMoveTarget] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const projects = tree.data?.projects ?? []
  const current = typeof selection === 'number' ? projects.find((p) => p.id === selection) : undefined
  const currentProjectId = current?.id
  const reloadAll = () => { void tree.reload(); void docs.reload() }
  const running = docs.data?.some((d) => d.last_run && (d.last_run.status === 'queued' || d.last_run.status === 'running')) ?? false
  usePolling(() => docs.reload(), running, 1500)

  const act = async (fn: () => Promise<void>) => {
    setError('')
    setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const moveChecked = () => act(async () => {
    const target = moveTarget === 'none' ? null : Number(moveTarget)
    const r = await papi.moveDocuments(checked, target)
    setNotice(`${r.moved}개 문서를 ${target ? projects.find((p) => p.id === target)?.path.join(' / ') : '미분류'}(으)로 옮겼습니다`)
    setChecked([])
    setMoveTarget('')
    reloadAll()
  })

  const runAll = () => act(async () => {
    if (!current) return
    const eff = current.effective
    const desc = eff.method === 'rule_structure' ? '규칙 baseline' : `${eff.resolved_prompt_label ?? '?'} · ${eff.model_name ?? '?'}`
    if (!confirm(`'${current.path.join(' / ')}'의 문서 ${current.total_doc_count}개를 청킹합니다 (하위 포함).\n프로파일: ${desc}\nLLM 호출 비용이 발생할 수 있습니다. 진행할까요?`)) return
    const r = await papi.runAll(current.id, { include_descendants: true, only_without_run: false })
    setNotice(`${r.document_count}개 문서 청킹을 시작했습니다 (순차 실행). 진행 상황은 아래 "최근 청킹" 열에서 확인하세요.`)
    void docs.reload()
  })

  const deleteProject = () => act(async () => {
    if (!current) return
    const hasContent = current.total_doc_count > 0 || projects.some((p) => p.parent_id === current.id)
    if (hasContent) {
      if (!confirm(`'${current.name}'에 하위 프로젝트나 문서가 있습니다.\n하위 프로젝트와 문서를 상위로 옮기고 이 프로젝트만 삭제할까요? (문서는 삭제되지 않습니다)`)) return
    } else if (!confirm(`'${current.name}' 프로젝트를 삭제할까요?`)) return
    await papi.deleteProject(current.id, hasContent)
    setSelection(current.parent_id ?? 'all')
    reloadAll()
  })

  const eff = current?.effective
  const allChecked = !!docs.data?.length && docs.data.every((d) => checked.includes(d.id))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>문서</h1>
          <p>프로젝트(문서 분류) 단위로 문서를 관리합니다. 같은 프로젝트의 문서는 같은 청킹 프로파일을 씁니다.</p>
        </div>
        <div className="row">
          <button onClick={() => setShowImport(true)}>결과 JSON 가져오기</button>
          <button className="primary" onClick={() => setShowUpload(true)}>테스트 문서 업로드</button>
        </div>
      </div>
      <ErrorBanner error={error || tree.error} />
      {notice && <div className="banner info">{notice}</div>}

      <div className="docs-layout">
        <aside className="card" style={{ padding: 8 }}>
          {tree.data && <ProjectTreeView tree={tree.data} value={selection} onChange={(v) => { setSelection(v); setChecked([]) }} onAddChild={(parentId) => setEditing({ parentId })} />}
        </aside>

        <section style={{ minWidth: 0 }}>
          {current && eff && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row">
                <div className="grow">
                  <div className="small muted">{current.path.slice(0, -1).join(' / ')}</div>
                  <h2 style={{ margin: 0 }}>{current.name} <span className="small muted">문서 {current.total_doc_count}개{current.total_doc_count !== current.doc_count ? ` (직속 ${current.doc_count})` : ''}</span></h2>
                  {current.description && <div className="small muted">{current.description}</div>}
                </div>
                <button onClick={() => setEditing({ project: current })}>설정</button>
                <button onClick={() => setEditing({ parentId: current.id })}>하위 추가</button>
                <button className="danger" onClick={() => void deleteProject()}>삭제</button>
                <button className="primary" disabled={!current.total_doc_count || !eff.method && !(eff.prompt_id && eff.model_id)} onClick={() => void runAll()}>일괄 청킹</button>
              </div>
              <div className="row small" style={{ marginTop: 8, gap: 12 }}>
                <span>청킹 프로파일:</span>
                {!eff.method && !(eff.prompt_id && eff.model_id) ? <Badge kind="warn">미설정 — "설정"에서 지정하세요</Badge> : (
                  <>
                    <Badge kind="accent">{eff.method === 'rule_structure' ? '규칙 baseline' : 'LLM 시멘틱'}</Badge>
                    {(eff.method ?? 'llm') === 'llm' && <span>프롬프트 <b>{eff.resolved_prompt_label ?? '-'}</b>{eff.prompt_version_id ? ' (고정)' : ' (운영 버전 자동)'}</span>}
                    {(eff.method ?? 'llm') === 'llm' && <span>모델 <b>{eff.model_name ?? '-'}</b></span>}
                    {eff.settings && <span>최대 {eff.settings.max_tokens} 토큰</span>}
                    {eff.doc_type && <span>유형 {eff.doc_type}</span>}
                    {Object.keys(eff.source_names).some((k) => eff.sources[k] !== current.id) && (
                      <span className="muted">상속: {[...new Set(Object.entries(eff.source_names).filter(([k]) => eff.sources[k] !== current.id).map(([, n]) => n))].join(', ')}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

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
            {checked.length > 0 && (
              <div className="row banner info" style={{ marginBottom: 10 }}>
                <span>{checked.length}개 선택</span>
                <select aria-label="옮길 프로젝트" value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
                  <option value="">프로젝트로 이동…</option>
                  {projectOptions(projects).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  <option value="none">(미분류)</option>
                </select>
                <button className="primary sm" disabled={!moveTarget} onClick={() => void moveChecked()}>이동</button>
                <button className="sm ghost" onClick={() => setChecked([])}>선택 해제</button>
              </div>
            )}
            <ErrorBanner error={docs.error} />
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 28 }}><input type="checkbox" aria-label="전체 선택" checked={allChecked} onChange={(e) => setChecked(e.target.checked ? docs.data?.map((d) => d.id) ?? [] : [])} /></th>
                  <th>제목</th><th>프로젝트</th><th>Parser</th><th>유입</th><th>Element</th><th>품질</th><th>최근 청킹</th><th>등록</th><th />
                </tr>
              </thead>
              <tbody>
                {docs.data?.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`${d.title} 선택`} checked={checked.includes(d.id)} onChange={(e) => setChecked((c) => e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id))} /></td>
                    <td><b>{d.title}</b>{d.revision > 1 && <> <Badge>rev {d.revision}</Badge></>}{d.doc_type && <div className="small muted">{d.doc_type}</div>}</td>
                    <td className="small">{d.project_path?.length ? d.project_path.join(' / ') : <span className="muted">미분류</span>}</td>
                    <td>{d.parser_name} <span className="muted small">{d.parser_version}</span></td>
                    <td>{d.source === 'test' ? <Badge kind="warn">테스트</Badge> : <Badge kind="accent">운영</Badge>}</td>
                    <td>{d.stats.element_count}<div className="small muted">{d.stats.page_count}p · 표 {d.stats.table_count}</div></td>
                    <td>
                      {d.stats.empty_pages.length > 0 && <Badge kind="warn">빈 페이지 {d.stats.empty_pages.length}</Badge>}{' '}
                      {d.stats.low_confidence_count > 0 && <Badge kind="warn">저신뢰 {d.stats.low_confidence_count}</Badge>}{' '}
                      {!d.stats.has_bbox && <Badge>bbox 없음</Badge>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()} className="small">
                      {d.last_run ? (
                        <Link to={`/playground?doc=${d.id}&run=${d.last_run.id}`}>
                          <StatusBadge status={d.last_run.status} /> {d.last_run.status === 'done' && <>청크 {d.last_run.chunk_count}{d.last_run.ok === false ? ' ⚠' : ''}</>}
                        </Link>
                      ) : <span className="muted">-</span>}
                    </td>
                    <td className="small muted">{fmtDate(d.created_at)}</td>
                    <td onClick={(e) => e.stopPropagation()}><Link to={`/playground?doc=${d.id}`}>청킹 →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {docs.data?.length === 0 && <div className="empty">{selection === 'all' ? '문서가 없습니다. 테스트 문서를 업로드하거나 Parser 결과를 가져오세요.' : '이 프로젝트에 문서가 없습니다. 다른 목록에서 문서를 선택해 이 프로젝트로 옮기거나, 업로드 시 프로젝트를 지정하세요.'}</div>}
          </div>
        </section>
      </div>

      {showUpload && <UploadModal projects={projects} defaultProjectId={currentProjectId} onClose={() => setShowUpload(false)} onDone={reloadAll} />}
      {showImport && <ImportModal projects={projects} defaultProjectId={currentProjectId} onClose={() => setShowImport(false)} onDone={reloadAll} />}
      {editing && (
        <ProjectSettingsModal project={editing.project} parentId={editing.parentId} projects={projects} onClose={() => setEditing(null)}
          onSaved={(p) => { setEditing(null); setSelection(p.id); reloadAll() }} />
      )}
    </>
  )
}

function ProjectSelect({ projects, value, onChange }: { projects: Project[]; value: number | ''; onChange: (v: number | '') => void }) {
  return (
    <label className="field">프로젝트
      <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
        <option value="">(미분류)</option>
        {projectOptions(projects).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}

/** IN-02: 테스트 문서 업로드 → Parser API 직접 호출 → 결과 확인 */
function UploadModal({ projects, defaultProjectId, onClose, onDone }: { projects: Project[]; defaultProjectId?: number; onClose: () => void; onDone: () => void }) {
  const parsers = useAsync(() => api.parsers(), [])
  const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [params, setParams] = useState('{}')
  const [docType, setDocType] = useState('')
  const [projectId, setProjectId] = useState<number | ''>(defaultProjectId ?? '')
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
    if (projectId) form.append('project_id', String(projectId))
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
        <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} />
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
function ImportModal({ projects, defaultProjectId, onClose, onDone }: { projects: Project[]; defaultProjectId?: number; onClose: () => void; onDone: () => void }) {
  const [projectId, setProjectId] = useState<number | ''>(defaultProjectId ?? '')
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
    if (projectId) form.append('project_id', String(projectId))
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
        <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} />
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
