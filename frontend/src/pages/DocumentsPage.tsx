import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, papi, vapi } from '../api'
import { ProjectSettingsModal } from '../components/ProjectSettings'
import { ProjectTreeView, projectOptions, type ProjectSelection } from '../components/ProjectTree'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, usePolling } from '../components/ui'
import type { ParseJob, Project, VectorIndex } from '../types'

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
  const [indexing, setIndexing] = useState<Project | null>(null)
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
                <button className="primary" disabled={!current.total_doc_count} onClick={() => setIndexing(current)} title="문서마다 가장 최근에 성공한 청킹 결과를 벡터 DB에 적재">일괄 적재</button>
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
              <div className="row small" style={{ marginTop: 6, gap: 6 }}>
                <span>메타데이터:</span>
                {Object.keys(current.access.meta).length ? Object.entries(current.access.meta).map(([k, v]) => (
                  <span key={k} className="badge" title={current.access.meta_sources[k] !== current.id ? `${current.access.meta_source_names[k]}에서 상속` : undefined}>{k}={Array.isArray(v) ? v.join(", ") : String(v)}</span>
                )) : <span className="muted">없음</span>}
                <span style={{ marginLeft: 8 }}>권한:</span>
                {current.access.public ? <Badge kind="ok">전체 공개</Badge> : current.access.permissions.map((p) => (
                  <span key={p} className="badge accent" title={current.access.permission_sources[p] !== current.id ? `${current.access.permission_source_names[p]}에서 상속` : undefined}>{p}</span>
                ))}
                {current.permission_mode === "override" && <span className="muted">(상위 권한 재정의)</span>}
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
      {indexing && <IndexAllModal project={indexing} onClose={() => setIndexing(null)} />}
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

/** 프로젝트 문서마다 가장 최근에 성공한 청킹 결과를 한 컬렉션에 일괄 적재 */
function IndexAllModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [includeDesc, setIncludeDesc] = useState(true)
  const plan = useAsync(() => papi.indexPlan(project.id, includeDesc), [project.id, includeDesc])
  const meta = useAsync(() => vapi.indexMeta(), [])
  const models = useAsync(() => vapi.embeddingModels(true), [])
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [modelId, setModelId] = useState<number>()
  const [storeId, setStoreId] = useState<number>()
  const [collection, setCollection] = useState('')
  const [template, setTemplate] = useState('{text}')
  const [metric, setMetric] = useState('COSINE')
  const [mode, setMode] = useState('recreate')
  const [error, setError] = useState('')
  const [started, setStarted] = useState<VectorIndex | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!modelId && models.data?.length) setModelId(models.data[0].id) }, [models.data, modelId])
  useEffect(() => {
    if (!storeId && stores.data?.length) setStoreId((stores.data.find((s) => s.kind === 'milvus' && s.enabled) ?? stores.data[0]).id)
  }, [stores.data, storeId])
  useEffect(() => { if (!collection && plan.data) setCollection(plan.data.default_collection) }, [plan.data, collection])

  const live = !!started && (started.status === 'queued' || started.status === 'running')
  usePolling(async () => { if (started) setStarted(await vapi.index(started.id)) }, live, 1000)

  const items = plan.data?.items ?? []
  const skipped = plan.data?.skipped ?? []
  const model = models.data?.find((m) => m.id === modelId)
  const totalChunks = items.reduce((n, i) => n + (i.chunk_count ?? 0), 0)

  const submit = async () => {
    if (!modelId || !storeId) return
    if (mode === 'recreate' && !confirm(`'${collection}' 컬렉션이 있으면 삭제하고 다시 만듭니다. 진행할까요?`)) return
    setError('')
    setBusy(true)
    try {
      const r = await papi.indexAll(project.id, { store_id: storeId, embedding_model_id: modelId, collection, embed_template: template, metric, mode, include_descendants: includeDesc })
      setStarted(r.index)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const title = `일괄 적재 — ${project.path.join(' / ')}`

  if (started) {
    const b = started.stats.batch
    return (
      <Modal wide title={title} onClose={onClose} footer={<><Link to="/indexes"><button>벡터 인덱스·질의로 이동</button></Link><button className="primary" onClick={onClose}>닫기</button></>}>
        <div className="row" style={{ gap: 10 }}>
          <StatusBadge status={started.status} />
          <b className="mono">{started.collection}</b>
          {b && <span>문서 {Math.min(b.done + (live ? 1 : 0), b.total)}/{b.total} · 성공 {b.succeeded}{b.failed.length ? ` · 실패 ${b.failed.length}` : ''}</span>}
          <span className="muted">컬렉션 청크 {started.chunk_count}개</span>
        </div>
        {live && b?.current && (
          <div className="small muted" style={{ marginTop: 6 }}>
            처리 중: {b.current} ({started.progress.phase === 'inserting' ? '적재' : '임베딩'} {started.progress.done ?? 0}/{started.progress.total ?? 0})
          </div>
        )}
        {started.status === 'failed' && <div className="banner error" style={{ marginTop: 8 }}>{started.error}</div>}
        {started.warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>⚠ {w}</div>)}
        {!!b?.failed.length && (
          <table className="list" style={{ marginTop: 8 }}>
            <thead><tr><th>실패한 문서</th><th>오류</th></tr></thead>
            <tbody>{b.failed.map((f) => <tr key={f.document_id}><td>{f.title}</td><td className="small">{f.error}</td></tr>)}</tbody>
          </table>
        )}
        {started.status === 'done' && <div className="banner info" style={{ marginTop: 8 }}>적재가 끝났습니다. "벡터 인덱스·질의"에서 이 컬렉션으로 질의를 테스트할 수 있습니다.</div>}
      </Modal>
    )
  }

  return (
    <Modal wide title={title} onClose={onClose} footer={<><button onClick={onClose}>취소</button>
      <button className="primary" disabled={busy || !items.length || !modelId || !storeId || !collection} onClick={() => void submit()}>{busy ? '시작 중…' : `문서 ${items.length}개 적재`}</button></>}>
      <ErrorBanner error={error || plan.error} />
      <p className="small muted" style={{ marginTop: 0 }}>
        문서마다 <b>가장 최근에 성공한 청킹 실행</b>을 골라 한 컬렉션에 순서대로 적재합니다. 같은 문서의 이전 청크는 교체되어 중복되지 않습니다.
        성공한 청킹이 없는 문서는 제외됩니다.
      </p>
      <label className="check small"><input type="checkbox" checked={includeDesc} onChange={(e) => setIncludeDesc(e.target.checked)} />하위 프로젝트 문서 포함</label>
      <div className="scroll" style={{ maxHeight: 240, margin: '8px 0', border: '1px solid var(--border)', borderRadius: 6 }}>
        <table className="list">
          <thead><tr><th>문서</th><th>프로젝트</th><th>적재할 청킹 실행</th><th>청크</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.document_id}>
                <td>{i.title}</td>
                <td className="small">{i.project_path.join(' / ')}</td>
                <td className="small">
                  <Link to={`/playground?doc=${i.document_id}&run=${i.run_id}`} target="_blank">#{i.run_id}</Link> · {i.method === 'llm' ? 'LLM' : '규칙'} · {fmtDate(i.created_at)}
                  {i.note && <div style={{ color: 'var(--warn)' }}>{i.note}</div>}
                </td>
                <td>{i.chunk_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan.data && !items.length && <div className="empty">성공한 청킹 실행이 있는 문서가 없습니다. 먼저 "일괄 청킹"을 실행하세요.</div>}
      </div>
      <div className="small">적재 대상 <b>{items.length}</b>개 문서 · 청크 약 <b>{totalChunks}</b>개{skipped.length > 0 && <> · 제외 {skipped.length}개</>}</div>
      {skipped.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary className="small muted">제외된 문서 {skipped.length}개</summary>
          <ul className="small" style={{ margin: '4px 0' }}>{skipped.map((s) => <li key={s.document_id}>{s.title} — <span className="muted">{s.reason}</span></li>)}</ul>
        </details>
      )}
      <div className="grid-3" style={{ marginTop: 10 }}>
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
        <label className="field">컬렉션 이름<input className="mono" value={collection} onChange={(e) => setCollection(e.target.value)} /></label>
        <label className="field">유사도
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>{meta.data?.metrics.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="field">컬렉션이 이미 있으면
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="recreate">삭제 후 다시 만들기</option>
            <option value="append">추가 (같은 문서는 교체)</option>
            <option value="create">실패 (새로 만들 때만)</option>
          </select>
        </label>
        <label className="field">임베딩 텍스트
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {meta.data?.templates.map((t) => <option key={t.label} value={t.template}>{t.label}</option>)}
          </select>
        </label>
      </div>
      {model && <div className="small muted" style={{ marginTop: 4 }}>최대 입력 {model.max_input_tokens} 토큰을 넘는 청크는 잘리거나 실패할 수 있습니다.</div>}
    </Modal>
  )
}
