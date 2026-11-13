import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DEFAULT_EMBED_TEMPLATE, api, papi, vapi } from '../api'
import { ProjectSettingsModal } from '../components/ProjectSettings'
import { ProjectTreeView, projectOptions, type ProjectSelection, isProjectId } from '../components/ProjectTree'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, usePolling, shortId } from '../components/ui'
import type { ParseJob, Project, VectorIndex } from '../types'

function parseSelection(v: string | null): ProjectSelection {
  if (v === 'unassigned') return 'unassigned'
  return v ? v : 'all'
}

export default function DocumentsPage() {
  const [sp, setSp] = useSearchParams()
  const selection = parseSelection(sp.get('project'))
  const setSelection = (v: ProjectSelection) => setSp((p) => { const n = new URLSearchParams(p); if (v === 'all') n.delete('project'); else n.set('project', String(v)); return n }, { replace: true })

  const [filters, setFilters] = useState<{ parser_id?: string; source?: string; q?: string }>({})
  const [q, setQ] = useState('')
  const tree = useAsync(() => papi.projects(), [])
  const docQuery = { ...filters, ...(selection === 'unassigned' ? { unassigned: true } : selection === 'all' ? {} : { project_id: selection }) }
  const docs = useAsync(() => api.documents(docQuery), [JSON.stringify(docQuery)])
  const parsers = useAsync(() => api.parsers(), [])
  const [showUpload, setShowUpload] = useState(false)
  const [editing, setEditing] = useState<{ project?: Project; parentId?: string | null } | null>(null)
  const [indexing, setIndexing] = useState<Project | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [moveTarget, setMoveTarget] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const projects = tree.data?.projects ?? []
  const current = isProjectId(selection) ? projects.find((p) => p.id === selection) : undefined
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
    const target = moveTarget === 'none' ? null : moveTarget
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
          <h1>문서 및 파싱</h1>
          <p>프로젝트(문서 분류) 단위로 문서를 관리합니다. 같은 프로젝트의 문서는 같은 청킹 프로파일을 씁니다.</p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowUpload(true)}>문서 업로드</button>
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
                <span>적재 컬렉션:</span>
                {eff.vector_store ? (
                  <>
                    <b>{eff.vector_store.name}</b><span className="mono">{eff.vector_store.collection}</span>
                    {eff.vector_store_source.kind === 'default'
                      ? <span className="muted">(기본 컬렉션 — 프로젝트에 지정 안 함)</span>
                      : eff.vector_store_source.project_id !== current.id && <span className="muted">(상속: {eff.vector_store_source.project_name})</span>}
                  </>
                ) : <Badge kind="warn">없음 — '벡터 저장소'에서 기본 컬렉션을 지정하세요</Badge>}
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
              <select aria-label="Parser 필터" value={filters.parser_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, parser_id: e.target.value ? e.target.value : undefined }))}>
                <option value="">모든 Parser</option>
                {parsers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select aria-label="유입 구분 필터" value={filters.source ?? ''} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value || undefined }))}>
                <option value="">전체 유입</option>
                <option value="test">Studio</option>
                <option value="runtime">API</option>
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
                    <td>{d.source === 'test' ? <Badge>Studio</Badge> : <Badge kind="accent">API</Badge>}</td>
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
            {docs.data?.length === 0 && <div className="empty">{selection === 'all' ? '문서가 없습니다. "문서 업로드"로 올리거나 API로 문서를 넣으세요.' : '이 프로젝트에 문서가 없습니다. 다른 목록에서 문서를 선택해 이 프로젝트로 옮기거나, 업로드 시 프로젝트를 지정하세요.'}</div>}
          </div>
        </section>
      </div>

      {showUpload && <UploadModal projects={projects} defaultProjectId={currentProjectId} onClose={() => setShowUpload(false)} onDone={reloadAll} />}
      {indexing && <IndexAllModal project={indexing} onClose={() => setIndexing(null)} />}
      {editing && (
        <ProjectSettingsModal project={editing.project} parentId={editing.parentId} projects={projects} onClose={() => setEditing(null)}
          onSaved={(p) => { setEditing(null); setSelection(p.id); reloadAll() }} />
      )}
    </>
  )
}

function ProjectSelect({ projects, value, onChange }: { projects: Project[]; value: string | ''; onChange: (v: string | '') => void }) {
  return (
    <label className="field">프로젝트
      <select value={value} onChange={(e) => onChange(e.target.value ? e.target.value : '')}>
        <option value="">(미분류)</option>
        {projectOptions(projects).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}

/** IN-02: 문서 업로드 → Parser API 직접 호출 → 결과 확인 */
function UploadModal({ projects, defaultProjectId, onClose, onDone }: { projects: Project[]; defaultProjectId?: string; onClose: () => void; onDone: () => void }) {
  const parsers = useAsync(() => api.parsers(), [])
  const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [params, setParams] = useState('{}')
  const [docType, setDocType] = useState('')
  const [projectId, setProjectId] = useState<string | ''>(defaultProjectId ?? '')
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
    <Modal title="문서 업로드" onClose={onClose} footer={
      <>
        <button onClick={onClose}>닫기</button>
        <button className="primary" disabled={!file || !selected.length || running} onClick={() => void submit()}>Parser 호출</button>
      </>
    }>
      <p className="muted small">선택한 Parser의 API를 Studio가 직접 호출하고, 결과를 표준 스키마로 변환해 저장합니다(유입: Studio). 여러 Parser를 고르면 결과를 비교할 수 있습니다.</p>
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
          {parsers.data && !callable.length && <span className="muted">API가 등록된 파서가 없습니다. 문서 파서에서 등록하세요.</span>}
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

/** 프로젝트 문서마다 가장 최근에 성공한 청킹 결과를, 각 문서의 프로젝트 저장소(컬렉션)에 일괄 적재 */
function IndexAllModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [includeDesc, setIncludeDesc] = useState(true)
  const plan = useAsync(() => papi.indexPlan(project.id, includeDesc), [project.id, includeDesc])
  const meta = useAsync(() => vapi.indexMeta(), [])
  const models = useAsync(() => vapi.embeddingModels(true), [])
  const [modelId, setModelId] = useState<string>()
  const [template, setTemplate] = useState(DEFAULT_EMBED_TEMPLATE)
  const [metric, setMetric] = useState('COSINE')
  const [mode, setMode] = useState<'append' | 'recreate'>('append')
  const [error, setError] = useState('')
  const [started, setStarted] = useState<VectorIndex[] | null>(null)
  const [busy, setBusy] = useState(false)

  const items = plan.data?.items ?? []
  const skipped = plan.data?.skipped ?? []
  const groups = plan.data?.groups ?? []
  // 기존 컬렉션에 추가할 때는 그 컬렉션의 임베딩 모델을 그대로 써야 한다
  const lockedModels = [...new Set(groups.map((g) => g.existing_index?.embedding_model_id).filter((x): x is string => !!x))]
  const locked = mode === 'append' && lockedModels.length > 0
  const modelConflict = mode === 'append' && lockedModels.length > 1
  const shared = groups.filter((g) => g.others_in_collection > 0)

  useEffect(() => {
    if (locked && lockedModels.length === 1) setModelId(lockedModels[0])
    else if (!modelId && models.data?.length) setModelId(models.data[0].id)
  }, [models.data, locked, lockedModels.join(','), modelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const live = !!started?.some((ix) => ix.status === 'queued' || ix.status === 'running')
  usePolling(async () => { if (started) setStarted(await Promise.all(started.map((ix) => vapi.index(ix.id)))) }, live, 1000)

  const submit = async () => {
    if (!modelId) return
    if (mode === 'recreate') {
      const names = groups.map((g) => g.store.collection).join(', ')
      const extra = shared.length ? `\n\n이 일괄 적재에 포함되지 않은 문서 ${shared.reduce((n, g) => n + g.others_in_collection, 0)}개도 함께 지워집니다.` : ''
      if (!confirm(`컬렉션(${names})을 비우고 다시 적재합니다.${extra}\n진행할까요?`)) return
    }
    setError('')
    setBusy(true)
    try {
      const r = await papi.indexAll(project.id, { embedding_model_id: modelId, embed_template: template, metric, mode, include_descendants: includeDesc })
      setStarted(r.indexes)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const title = `일괄 적재 — ${project.path.join(' / ')}`

  if (started) {
    return (
      <Modal wide title={title} onClose={onClose} footer={<><Link to="/indexes"><button>질의 테스트로 이동</button></Link><button className="primary" onClick={onClose}>닫기</button></>}>
        {started.map((ix) => {
          const b = ix.stats.batch
          const running = ix.status === 'queued' || ix.status === 'running'
          return (
            <div key={ix.id} className="card" style={{ margin: '0 0 8px', padding: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <StatusBadge status={ix.status} />
                <b>{ix.store_name}</b><span className="mono">{ix.collection}</span>
                {b && <span>문서 {Math.min(b.done + (running && b.current ? 1 : 0), b.total)}/{b.total} · 성공 {b.succeeded}{b.failed.length ? ` · 실패 ${b.failed.length}` : ''}</span>}
                <span className="muted">컬렉션 청크 {ix.chunk_count}개</span>
              </div>
              {running && b?.current && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  처리 중: {b.current} ({ix.progress.phase === 'inserting' ? '적재' : '임베딩'} {ix.progress.done ?? 0}/{ix.progress.total ?? 0})
                </div>
              )}
              {running && !b?.current && <div className="small muted" style={{ marginTop: 6 }}>앞 저장소 적재가 끝나기를 기다리는 중</div>}
              {ix.status === 'failed' && <div className="banner error" style={{ marginTop: 8 }}>{ix.error}</div>}
              {ix.warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>⚠ {w}</div>)}
              {!!b?.failed.length && (
                <table className="list" style={{ marginTop: 8 }}>
                  <thead><tr><th>실패한 문서</th><th>오류</th></tr></thead>
                  <tbody>{b.failed.map((f) => <tr key={f.document_id}><td>{f.title}</td><td className="small">{f.error}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          )
        })}
        {!live && started.every((ix) => ix.status === 'done') && <div className="banner info">적재가 끝났습니다. "질의 테스트"에서 검색 결과를 확인할 수 있습니다.</div>}
      </Modal>
    )
  }

  return (
    <Modal wide title={title} onClose={onClose} footer={<><button onClick={onClose}>취소</button>
      <button className="primary" disabled={busy || !items.length || !modelId || modelConflict} onClick={() => void submit()}>{busy ? '시작 중…' : `문서 ${items.length}개 적재`}</button></>}>
      <ErrorBanner error={error || plan.error} />
      <p className="small muted" style={{ marginTop: 0 }}>
        문서마다 <b>가장 최근에 성공한 청킹 실행</b>을 골라, 문서가 속한 프로젝트의 <b>적재 컬렉션</b>에 순서대로 적재합니다.
        컬렉션을 지정하지 않은 프로젝트는 기본 컬렉션에 들어갑니다. 같은 문서의 이전 청크는 교체되어 중복되지 않습니다.
      </p>
      <label className="check small"><input type="checkbox" checked={includeDesc} onChange={(e) => setIncludeDesc(e.target.checked)} />하위 프로젝트 문서 포함</label>

      {groups.length > 0 && (
        <table className="list" style={{ margin: '8px 0' }}>
          <thead><tr><th>벡터 저장소</th><th>컬렉션</th><th>문서</th><th>청크</th><th>기존 적재</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.store.collection_id}>
                <td><b>{g.store.name}</b>{g.via_default && <> <Badge kind="accent">기본 컬렉션</Badge></>}</td>
                <td className="mono">{g.store.collection}</td>
                <td>{g.document_count}</td>
                <td>{g.chunk_count}</td>
                <td className="small">
                  {g.existing_index ? <>청크 {g.existing_index.chunk_count}개 · {g.existing_index.embedding_model_name}</> : <span className="muted">없음 (새로 생성)</span>}
                  {g.others_in_collection > 0 && <div className="muted">다른 문서 {g.others_in_collection}개 포함 ({g.other_titles.join(', ')}{g.others_in_collection > g.other_titles.length ? ' …' : ''})</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="scroll" style={{ maxHeight: 220, margin: '8px 0', border: '1px solid var(--border)', borderRadius: 6 }}>
        <table className="list">
          <thead><tr><th>문서</th><th>프로젝트</th><th>적재할 청킹 실행</th><th>청크</th><th>적재 위치</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.document_id}>
                <td>{i.title}</td>
                <td className="small">{i.project_path.join(' / ')}</td>
                <td className="small">
                  <Link to={`/playground?doc=${i.document_id}&run=${i.run_id}`} target="_blank" title={i.run_id}>{shortId(i.run_id)}</Link> · {i.method === 'llm' ? 'LLM' : '규칙'} · {fmtDate(i.created_at)}
                  {i.note && <div style={{ color: 'var(--warn)' }}>{i.note}</div>}
                </td>
                <td>{i.chunk_count}</td>
                <td className="small">{(() => { const g = groups.find((x) => x.store.collection_id === i.collection_id); return g ? `${g.store.name} / ${g.store.collection}` : '' })()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan.data && !items.length && <div className="empty">성공한 청킹 실행이 있는 문서가 없습니다. 먼저 "일괄 청킹"을 실행하세요.</div>}
      </div>
      {skipped.length > 0 && (
        <details>
          <summary className="small muted">제외된 문서 {skipped.length}개</summary>
          <ul className="small" style={{ margin: '4px 0' }}>{skipped.map((s) => <li key={s.document_id}>{s.title} — <span className="muted">{s.reason}</span></li>)}</ul>
        </details>
      )}

      <div className="grid-3" style={{ marginTop: 10 }}>
        <label className="field">적재 방식
          <select value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'recreate')}>
            <option value="append">추가 (같은 문서는 교체)</option>
            <option value="recreate">컬렉션 비우고 다시 적재</option>
          </select>
        </label>
        <label className="field">임베딩 모델
          <select value={modelId ?? ''} disabled={locked && !modelConflict} onChange={(e) => setModelId(e.target.value)}>
            {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.dimension ? ` (${m.dimension}d)` : ''}</option>)}
          </select>
          {locked && !modelConflict && <span className="small muted">기존 컬렉션의 모델로 고정 (바꾸려면 '비우고 다시 적재')</span>}
        </label>
        <label className="field">유사도
          <select value={metric} disabled={locked} onChange={(e) => setMetric(e.target.value)}>{meta.data?.metrics.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="field">임베딩 텍스트
          <select value={template} disabled={locked} onChange={(e) => setTemplate(e.target.value)}>
            {meta.data?.templates.map((t) => <option key={t.label} value={t.template}>{t.label}</option>)}
          </select>
        </label>
      </div>
      {locked && <div className="small muted" style={{ marginTop: 4 }}>기존 컬렉션에 추가할 때는 그 컬렉션의 임베딩 모델·텍스트 템플릿·유사도를 그대로 씁니다.</div>}
      {modelConflict && <div className="banner warn small" style={{ marginTop: 8 }}>저장소마다 기존 임베딩 모델이 달라 한 번에 추가할 수 없습니다. 하위 프로젝트를 나눠 적재하거나 '비우고 다시 적재'를 선택하세요.</div>}
      {mode === 'recreate' && shared.length > 0 && (
        <div className="banner warn small" style={{ marginTop: 8 }}>
          비우는 컬렉션에 이 일괄 적재에 포함되지 않은 문서가 있습니다: {shared.map((g) => `${g.store.collection} ${g.others_in_collection}개`).join(', ')}. 함께 지워집니다.
        </div>
      )}
    </Modal>
  )
}
