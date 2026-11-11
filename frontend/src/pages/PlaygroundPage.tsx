import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, papi } from '../api'
import { chunkColor } from '../colors'
import { TableView } from '../components/ElementViews'
import { TemplateEditor } from '../components/TemplateEditor'
import { Badge, ErrorBanner, Histogram, Stat, StatusBadge, Tabs, fmtDate, useAsync, usePolling } from '../components/ui'
import type { Chunk, ChunkSettings, DocElement, Issue, PromptPreview, PromptVersion, RunDetail } from '../types'

const DEFAULT_SETTINGS: ChunkSettings = {
  max_tokens: 512, min_tokens: 64, window_tokens: null, exclude_types: ['header', 'footer'],
  scope: { mode: 'all' }, auto_fix: true, retries: 1, doc_type: '',
}
const EXCLUDABLE = ['header', 'footer', 'footnote', 'caption', 'figure']

type BottomTab = 'windows' | 'preview' | 'history' | 'snapshot'

export default function PlaygroundPage() {
  const [sp, setSp] = useSearchParams()
  const docId = Number(sp.get('doc')) || undefined
  const runId = Number(sp.get('run')) || undefined
  const setParam = (k: string, v?: number) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, String(v)); else n.delete(k); return n }, { replace: true })

  const docs = useAsync(() => api.documents(), [])
  const doc = useAsync(() => (docId ? api.document(docId) : Promise.resolve(undefined)), [docId])
  const models = useAsync(() => api.models(true), [])
  const prompts = useAsync(() => api.prompts(), [])
  const defaults = useAsync(() => api.promptDefaults(), [])
  const runs = useAsync(() => (docId ? api.runs(docId) : Promise.resolve([])), [docId])

  // ---------------------------------------------------------------- 설정 상태
  const [promptId, setPromptId] = useState<number>()
  const [versionId, setVersionId] = useState<number>()
  const [system, setSystem] = useState('')
  const [user, setUser] = useState('')
  const [fewShots, setFewShots] = useState('[]')
  const [note, setNote] = useState('')
  const [modelId, setModelId] = useState<number>()
  const [method, setMethod] = useState<'llm' | 'rule_structure'>('llm')
  const [params, setParams] = useState<{ temperature?: number; top_p?: number; max_tokens?: number; seed?: number; effort?: string }>({ temperature: 0 })
  const [settings, setSettings] = useState<ChunkSettings>(DEFAULT_SETTINGS)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [bottom, setBottom] = useState<BottomTab>('windows')

  const prompt = prompts.data?.find((p) => p.id === promptId)
  const version: PromptVersion | undefined = prompt?.versions.find((v) => v.id === versionId)
  const model = models.data?.find((m) => m.id === modelId)
  const dirty = !!version && (version.system_template !== system || version.user_template !== user || JSON.stringify(version.few_shots) !== normalizeJson(fewShots))

  useEffect(() => {
    if (!promptId && prompts.data?.length) setPromptId(prompts.data[0].id)
  }, [prompts.data, promptId])
  useEffect(() => {
    if (prompt && !prompt.versions.some((v) => v.id === versionId)) {
      const v = prompt.versions.find((x) => x.id === prompt.production_version_id) ?? prompt.versions[prompt.versions.length - 1]
      setVersionId(v?.id)
    }
  }, [prompt, versionId])
  useEffect(() => {
    if (version) {
      setSystem(version.system_template)
      setUser(version.user_template)
      setFewShots(JSON.stringify(version.few_shots ?? [], null, 2))
    }
  }, [version?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!modelId && models.data?.length) setModelId(models.data[0].id)
  }, [models.data, modelId])
  useEffect(() => {
    if (!docId && docs.data?.length) setParam('doc', docs.data[0].id)
  }, [docs.data, docId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- 프로젝트 청킹 프로파일
  const projectId = doc.data?.project_id ?? null
  const project = useAsync(() => (projectId ? papi.project(projectId) : Promise.resolve(undefined)), [projectId])
  const [appliedFor, setAppliedFor] = useState<number>()
  const [projectNotice, setProjectNotice] = useState('')
  useEffect(() => {
    // 문서를 바꿀 때마다 한 번, 문서가 속한 프로젝트의 (상속 포함) 프로파일을 기본값으로 적용
    const p = project.data
    if (!p || !docId || appliedFor === docId || !prompts.data || !models.data || p.id !== projectId) return
    const eff = p.effective
    if (eff.method) setMethod(eff.method)
    else if (eff.prompt_id && eff.model_id) setMethod('llm')
    if (eff.prompt_id) { setPromptId(eff.prompt_id); setVersionId(eff.resolved_prompt_version_id ?? undefined) }
    if (eff.model_id && models.data.some((m) => m.id === eff.model_id)) setModelId(eff.model_id)
    if (eff.params) setParams(eff.params as typeof params)
    setSettings({ ...DEFAULT_SETTINGS, ...(eff.settings ?? {}), doc_type: eff.doc_type ?? '', scope: { mode: 'all' } })
    setAppliedFor(docId)
  }, [project.data, docId, prompts.data, models.data, appliedFor, projectId])

  const saveToProject = async () => {
    const p = project.data
    if (!p) return
    if (!confirm(`현재 설정을 '${p.path.join(' / ')}' 프로젝트의 청킹 프로파일로 저장할까요?\n하위 프로젝트 중 따로 지정하지 않은 곳에도 적용됩니다.`)) return
    setError('')
    try {
      await papi.updateProject(p.id, {
        name: p.name, description: p.description, parent_id: p.parent_id, sort_order: p.sort_order,
        method,
        prompt_id: method === 'llm' ? promptId ?? null : p.prompt_id,
        prompt_version_id: method === 'llm' ? versionId ?? null : p.prompt_version_id,
        model_id: method === 'llm' ? modelId ?? null : p.model_id,
        params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')),
        settings: { max_tokens: settings.max_tokens, min_tokens: settings.min_tokens, window_tokens: settings.window_tokens,
                    exclude_types: settings.exclude_types, retries: settings.retries, auto_fix: settings.auto_fix },
        doc_type: settings.doc_type || p.doc_type,
        meta: p.meta, permissions: p.permissions, permission_mode: p.permission_mode,
      })
      await project.reload()
      setProjectNotice('프로젝트 프로파일에 저장했습니다')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ---------------------------------------------------------------- 실행 결과
  const [run, setRun] = useState<RunDetail>()
  useEffect(() => {
    if (!runId) { setRun(undefined); return }
    void api.run(runId).then(setRun, (e) => setError(String(e)))
  }, [runId])
  const active = run && (run.status === 'queued' || run.status === 'running')
  usePolling(async () => {
    if (!runId) return
    const r = await api.run(runId)
    setRun(r)
    if (r.status === 'done' || r.status === 'failed') void runs.reload()
  }, !!active, 800)

  const loadRunSettings = (r: RunDetail) => {
    setMethod(r.method)
    setSettings({ ...DEFAULT_SETTINGS, ...r.settings })
    setParams(r.params as typeof params)
    if (r.model_id) setModelId(r.model_id)
    if (r.prompt_id && r.prompt_version_id) { setPromptId(r.prompt_id); setVersionId(r.prompt_version_id) }
  }

  const fewShotsParsed = (): unknown[] | null => {
    try {
      const v = JSON.parse(fewShots || '[]')
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }

  const saveVersion = async (): Promise<number | undefined> => {
    if (!prompt || !version) return
    const shots = fewShotsParsed()
    if (!shots) { setError('Few-shot은 [{"input": "...", "output": {...}}] 형식의 JSON 배열이어야 합니다'); return }
    const v = await api.createVersion(prompt.id, {
      system_template: system, user_template: user, few_shots: shots as PromptVersion['few_shots'],
      output_schema: version.output_schema, note: note || `v${version.version} 수정`,
    })
    setNote('')
    await prompts.reload()
    setVersionId(v.id)
    return v.id
  }

  const execute = async () => {
    if (!docId) return
    setError('')
    try {
      let pvId = versionId
      if (method === 'llm' && dirty) pvId = await saveVersion()
      if (method === 'llm' && (!pvId || !modelId)) { setError('프롬프트 버전과 모델을 선택하세요'); return }
      const cleanParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
      const r = await api.startRun({
        document_id: docId, method, prompt_version_id: method === 'llm' ? pvId : undefined,
        model_id: method === 'llm' ? modelId : undefined, params: cleanParams, settings,
      })
      setParam('run', r.id)
      setRun({ ...r, chunks: [], windows: [], feedback: {}, snapshot: {} })
      void runs.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doPreview = async () => {
    if (!docId) return
    setError('')
    try {
      setPreview(await api.previewPrompt({ document_id: docId, system_template: system, user_template: user, few_shots: fewShotsParsed() ?? [], model_id: modelId, settings, params }))
      setBottom('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const elements = doc.data?.content.elements ?? []
  const headings = elements.filter((e) => e.type === 'heading' || e.type === 'title')
  const estimatedCost = preview && model ? (preview.estimated_input_tokens * preview.estimated_windows * model.input_price_per_1m) / 1e6 : null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Prompt Playground</h1>
          <p>프롬프트를 수정하며 LLM이 정한 청크 경계를 원문 위에서 확인합니다. LLM은 Element ID 범위만 반환하고, 청크 본문은 원본 Element로 조립됩니다.</p>
        </div>
        <label className="field" style={{ minWidth: 280 }}>문서
          <select value={docId ?? ''} onChange={(e) => { setParam('run'); setParam('doc', Number(e.target.value)) }}>
            {docs.data?.map((d) => <option key={d.id} value={d.id}>{d.project_path?.length ? `[${d.project_path.join(' / ')}] ` : ''}{d.title} (#{d.id}, {d.stats.element_count}개)</option>)}
          </select>
        </label>
      </div>
      <ErrorBanner error={error || doc.error || prompts.error || models.error} />

      <div className="pg">
        {/* ------------------------------------------------ 왼쪽: 프롬프트·모델·설정 */}
        <section className="pg-pane col" aria-label="프롬프트 설정">
          {project.data && (
            <div className="banner info small" style={{ margin: 0 }}>
              <div>프로젝트 <b>{project.data.path.join(" / ")}</b>의 청킹 프로파일을 기본값으로 적용했습니다.</div>
              <div className="row" style={{ marginTop: 4 }}>
                <button className="sm" disabled={dirty && method === "llm"} title={dirty ? "프롬프트 수정 사항을 먼저 새 버전으로 저장하세요" : undefined} onClick={() => void saveToProject()}>현재 설정을 프로젝트에 저장</button>
                <Link className="small" to={`/documents?project=${project.data.id}`}>프로젝트 문서 보기</Link>
                {projectNotice && <span>{projectNotice}</span>}
              </div>
            </div>
          )}
          <div className="row">
            <label className="check"><input type="radio" checked={method === 'llm'} onChange={() => setMethod('llm')} />LLM 시멘틱</label>
            <label className="check"><input type="radio" checked={method === 'rule_structure'} onChange={() => setMethod('rule_structure')} />규칙 baseline</label>
          </div>
          {method === 'llm' && (
            <>
              <div className="row">
                <label className="field grow">프롬프트
                  <select value={promptId ?? ''} onChange={(e) => { setPromptId(Number(e.target.value)); setVersionId(undefined) }}>
                    {prompts.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="field">버전
                  <select value={versionId ?? ''} onChange={(e) => setVersionId(Number(e.target.value))}>
                    {prompt?.versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>)}
                  </select>
                </label>
              </div>
              {dirty && <div className="banner warn small" style={{ margin: 0 }}>수정됨 — 실행 시 새 버전으로 저장됩니다 (재현성)</div>}
              <TemplateEditor label="System 프롬프트" value={system} onChange={setSystem} variables={defaults.data?.variables ?? {}} rows={12} />
              <TemplateEditor label="User 프롬프트" value={user} onChange={setUser} variables={defaults.data?.variables ?? {}} rows={6} />
              <details>
                <summary className="small">Few-shot 예시 (JSON)</summary>
                <textarea rows={6} value={fewShots} onChange={(e) => setFewShots(e.target.value)} placeholder='[{"input": "[E1][heading] ...", "output": {"chunks": [...]}}]' />
                {fewShotsParsed() === null && <div className="small" style={{ color: 'var(--danger)' }}>JSON 배열이 아닙니다</div>}
              </details>
              <div className="row">
                <input className="grow" placeholder="수정 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="수정 메모" />
                <button disabled={!dirty} onClick={() => void saveVersion()}>새 버전 저장</button>
              </div>
              <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
              <label className="field">모델
                <select value={modelId ?? ''} onChange={(e) => setModelId(Number(e.target.value))}>
                  {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.engine || m.provider}{m.is_external ? ' (외부)' : ''}</option>)}
                </select>
              </label>
              {model && <div className="small muted">컨텍스트 {model.context_length.toLocaleString()} · 구조화 출력 {model.strategy_chain.join(' → ')}</div>}
              <div className="grid-2">
                {model?.provider === 'anthropic' ? (
                  <label className="field">effort
                    <select value={params.effort ?? ''} onChange={(e) => setParams((p) => ({ ...p, effort: e.target.value || undefined }))}>
                      <option value="">기본</option>{['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                ) : (
                  <>
                    <NumField label="temperature" value={params.temperature} step={0.1} onChange={(v) => setParams((p) => ({ ...p, temperature: v }))} />
                    <NumField label="top_p" value={params.top_p} step={0.05} onChange={(v) => setParams((p) => ({ ...p, top_p: v }))} />
                    <NumField label="seed" value={params.seed} onChange={(v) => setParams((p) => ({ ...p, seed: v }))} />
                  </>
                )}
                <NumField label="max_tokens (출력)" value={params.max_tokens} onChange={(v) => setParams((p) => ({ ...p, max_tokens: v }))} />
              </div>
            </>
          )}
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
          <h3>청킹 설정</h3>
          <div className="grid-2">
            <NumField label="청크 최대 토큰" value={settings.max_tokens} onChange={(v) => setSettings((s) => ({ ...s, max_tokens: v ?? 512 }))} />
            <NumField label="청크 최소 토큰" value={settings.min_tokens} onChange={(v) => setSettings((s) => ({ ...s, min_tokens: v ?? 0 }))} />
            {method === 'llm' && <NumField label="윈도우 토큰 (비우면 자동)" value={settings.window_tokens ?? undefined} onChange={(v) => setSettings((s) => ({ ...s, window_tokens: v ?? null }))} />}
            {method === 'llm' && <NumField label="재시도 횟수" value={settings.retries} onChange={(v) => setSettings((s) => ({ ...s, retries: v ?? 0 }))} />}
          </div>
          <div className="field">
            <span className="small muted">청킹 제외 타입</span>
            <div className="row">
              {EXCLUDABLE.map((t) => (
                <label key={t} className="check small"><input type="checkbox" checked={settings.exclude_types.includes(t)} onChange={(e) => setSettings((s) => ({ ...s, exclude_types: e.target.checked ? [...s.exclude_types, t] : s.exclude_types.filter((x) => x !== t) }))} />{t}</label>
              ))}
            </div>
          </div>
          <div className="row">
            <label className="field">실행 범위
              <select value={settings.scope.mode} onChange={(e) => setSettings((s) => ({ ...s, scope: { mode: e.target.value as ChunkSettings['scope']['mode'] } }))}>
                <option value="all">전체</option><option value="section">섹션</option><option value="pages">페이지</option>
              </select>
            </label>
            {settings.scope.mode === 'section' && (
              <label className="field grow">섹션
                <select value={settings.scope.section_id ?? ''} onChange={(e) => setSettings((s) => ({ ...s, scope: { mode: 'section', section_id: e.target.value } }))}>
                  <option value="">선택</option>
                  {headings.map((h) => <option key={h.element_id} value={h.element_id}>{'  '.repeat((h.level ?? 1) - 1)}{h.text.slice(0, 40)}</option>)}
                </select>
              </label>
            )}
            {settings.scope.mode === 'pages' && (
              <>
                <NumField label="시작 페이지" value={settings.scope.page_from} onChange={(v) => setSettings((s) => ({ ...s, scope: { ...s.scope, page_from: v } }))} />
                <NumField label="끝 페이지" value={settings.scope.page_to} onChange={(v) => setSettings((s) => ({ ...s, scope: { ...s.scope, page_to: v } }))} />
              </>
            )}
          </div>
          {method === 'llm' && <label className="check small"><input type="checkbox" checked={settings.auto_fix} onChange={(e) => setSettings((s) => ({ ...s, auto_fix: e.target.checked }))} />누락·겹침 경계 자동 보정</label>}
          <div className="row">
            {method === 'llm' && <button onClick={() => void doPreview()} disabled={!docId}>프롬프트 미리보기</button>}
            <span className="spacer" />
            <button className="primary" onClick={() => void execute()} disabled={!docId || !!active || (method === 'llm' && fewShotsParsed() === null)}>
              {active ? '실행 중…' : dirty && method === 'llm' ? '저장 후 실행' : '실행'}
            </button>
          </div>
          {preview && method === 'llm' && (
            <div className="small muted">예상: 윈도우 {preview.estimated_windows}개 · 윈도우당 입력 ~{preview.estimated_input_tokens.toLocaleString()} 토큰{estimatedCost !== null && estimatedCost > 0 ? ` · 입력 비용 ~$${estimatedCost.toFixed(4)}` : ''}</div>
          )}
        </section>

        {/* ------------------------------------------------ 가운데: 문서 뷰 */}
        <section className="pg-pane" aria-label="청크 경계 문서 뷰">
          <h3>문서 뷰 {run && <StatusBadge status={run.status} />}{run && <span className="small muted">실행 #{run.id}</span>}{run?.status === 'done' && <Link to={`/indexes?run=${run.id}`} className="small" style={{ marginLeft: 'auto' }}>벡터 DB 적재 →</Link>}</h3>
          {active && <ProgressBar run={run} />}
          {run?.status === 'failed' && <div className="banner err"><pre>{run.error}</pre></div>}
          <ChunkedDocument elements={elements} run={run} />
        </section>

        {/* ------------------------------------------------ 오른쪽: 청크 리스트 */}
        <section className="pg-pane" aria-label="청크 목록">
          <ChunkPanel run={run} onFeedback={async (cid, v) => { if (run) { const fb = await api.feedback(run.id, cid, v); setRun({ ...run, feedback: fb }) } }} />
        </section>
      </div>

      {/* ------------------------------------------------ 하단: Raw I/O, 로그, 이력 */}
      <div className="card bottom-panel">
        <Tabs<BottomTab> value={bottom} onChange={setBottom} tabs={[
          { id: 'windows', label: `윈도우 로그 / Raw 입·출력${run?.windows.length ? ` (${run.windows.length})` : ''}` },
          { id: 'preview', label: '최종 프롬프트 미리보기' },
          { id: 'history', label: `실행 이력${runs.data?.length ? ` (${runs.data.length})` : ''}` },
          { id: 'snapshot', label: '재현 스냅샷' },
        ]} />
        {bottom === 'windows' && <WindowLogs run={run} />}
        {bottom === 'preview' && (preview ? (
          <div className="col">
            {preview.unknown_variables.length > 0 && <div className="banner warn">알 수 없는 변수: {preview.unknown_variables.join(', ')}</div>}
            <div className="small muted">첫 윈도우 기준 (Element {preview.first_window_elements}/{preview.total_elements}개, 윈도우 예산 {preview.window_budget.toLocaleString()} 토큰)</div>
            <div className="grid-2">
              <div><h3>System</h3><pre className="code-box">{preview.system}</pre></div>
              <div><h3>User</h3><pre className="code-box">{preview.user}</pre></div>
            </div>
          </div>
        ) : <div className="muted">왼쪽의 "프롬프트 미리보기"를 누르면 변수가 치환된 최종 프롬프트를 LLM 호출 없이 확인할 수 있습니다.</div>)}
        {bottom === 'history' && (
          <table className="list">
            <thead><tr><th>#</th><th>방식</th><th>프롬프트</th><th>모델</th><th>상태</th><th>청크</th><th>검증</th><th>토큰(입/출)</th><th>지연</th><th>실행 시각</th><th /></tr></thead>
            <tbody>
              {runs.data?.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setParam('run', r.id)} style={r.id === runId ? { background: 'var(--accent-soft)' } : undefined}>
                  <td>{r.id}</td>
                  <td>{r.method === 'llm' ? 'LLM' : '규칙'}</td>
                  <td>{r.prompt_label}</td>
                  <td>{r.model_name}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.totals.chunk_count ?? '-'}</td>
                  <td>{r.validation.ok === undefined ? '-' : r.validation.ok ? <Badge kind="ok">통과</Badge> : <Badge kind="err">오류 {r.validation.error_count}</Badge>} {!!r.validation.warning_count && <Badge kind="warn">경고 {r.validation.warning_count}</Badge>}</td>
                  <td>{r.totals.input_tokens ?? 0} / {r.totals.output_tokens ?? 0}</td>
                  <td>{r.totals.latency_ms ? `${(r.totals.latency_ms / 1000).toFixed(1)}초` : '-'}</td>
                  <td className="small muted">{fmtDate(r.created_at)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="sm" onClick={async () => loadRunSettings(await api.run(r.id))}>설정 불러오기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {bottom === 'snapshot' && (run ? <pre className="code-box">{JSON.stringify({ snapshot: run.snapshot, params: run.params, settings: run.settings }, null, 2)}</pre> : <div className="muted">실행을 선택하세요</div>)}
      </div>
    </>
  )
}

function normalizeJson(s: string) {
  try { return JSON.stringify(JSON.parse(s || '[]')) } catch { return s }
}

function NumField({ label, value, onChange, step }: { label: string; value?: number; onChange: (v: number | undefined) => void; step?: number }) {
  return (
    <label className="field">{label}
      <input type="number" step={step ?? 1} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </label>
  )
}

function ProgressBar({ run }: { run: RunDetail }) {
  const p = run.progress ?? {}
  const pct = p.elements_total ? Math.round(((p.elements_done ?? 0) / p.elements_total) * 100) : 5
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="small muted">{p.window ? `윈도우 ${p.window}/${p.estimated_windows ?? '?'} 처리 중` : '대기 중'} · Element {p.elements_done ?? 0}/{p.elements_total ?? '?'}</div>
      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

/** 청크 경계 색상 하이라이트 + 경계 hover 시 reason */
function ChunkedDocument({ elements, run }: { elements: DocElement[]; run?: RunDetail }) {
  const sorted = useMemo(() => [...elements].sort((a, b) => a.reading_order - b.reading_order), [elements])
  const byId = useMemo(() => new Map(sorted.map((e) => [e.element_id, e])), [sorted])
  const [selected, setSelected] = useState<string | null>(null)
  const chunks = run?.chunks ?? []

  if (!chunks.length) {
    return (
      <div className="el-list">
        {run && run.status === 'done' && <div className="banner warn">청크가 없습니다</div>}
        {!run && <div className="banner info">실행하면 청크 경계가 색상으로 표시됩니다. 아래는 원본 Element입니다.</div>}
        {sorted.map((e) => <ElLine key={e.element_id} el={e} />)}
      </div>
    )
  }
  const missing = new Set((run?.validation.issues ?? []).filter((i) => i.code === 'missing').flatMap((i) => i.element_ids ?? []))
  const chunkOf = new Map<string, number>()
  chunks.forEach((c, i) => c.element_ids.forEach((id) => chunkOf.set(id, i)))

  // 문서 순서대로 청크 블록과 청크 밖 Element(제외/누락)를 배치
  const blocks: ({ kind: 'chunk'; idx: number } | { kind: 'loose'; el: DocElement })[] = []
  const placed = new Set<number>()
  for (const e of sorted) {
    const ci = chunkOf.get(e.element_id)
    if (ci === undefined) blocks.push({ kind: 'loose', el: e })
    else if (!placed.has(ci)) { placed.add(ci); blocks.push({ kind: 'chunk', idx: ci }) }
  }

  return (
    <div>
      {blocks.map((b) => {
        if (b.kind === 'loose') {
          const isMissing = missing.has(b.el.element_id)
          return (
            <div key={b.el.element_id} style={{ opacity: isMissing ? 1 : 0.45, padding: '2px 8px', borderLeft: `5px dashed ${isMissing ? 'var(--danger)' : 'var(--border)'}`, marginBottom: 6 }}>
              <div className="small muted">{isMissing ? '⚠ 어떤 청크에도 포함되지 않음' : '청킹 제외'}</div>
              <ElLine el={b.el} />
            </div>
          )
        }
        const c = chunks[b.idx]
        const color = chunkColor(b.idx)
        return (
          <div key={c.chunk_id} id={`chunk-${c.chunk_id}`}>
            {b.idx > 0 && <div className="boundary" title={c.reason}>✂ 경계 · {c.reason || '(근거 없음)'}</div>}
            <div className={`chunk-block ${selected === c.chunk_id ? 'selected' : ''}`} style={{ borderLeftColor: color, background: chunkColor(b.idx, 0.07) }} onClick={() => setSelected(c.chunk_id)}>
              <div className="chunk-head">
                <b style={{ color }}>{c.chunk_id}</b><span>{c.start_id}~{c.end_id}</span><span>{c.tokens}t</span>
                {c.source !== 'llm' && <Badge kind="warn">{c.source === 'fallback' ? '규칙 fallback' : '규칙'}</Badge>}
                {c.title && <span className="muted">— {c.title}</span>}
              </div>
              {c.element_ids.map((id) => { const el = byId.get(id); return el ? <ElLine key={id} el={el} /> : <div key={id} className="small">{id} (없음)</div> })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ElLine({ el }: { el: DocElement }) {
  const heading = el.type === 'heading' || el.type === 'title'
  return (
    <div className={`chunk-el ${heading ? 'heading' : ''}`}>
      <span className="eid">{el.element_id}·{el.type}</span>
      {el.type === 'table' ? <TableView el={el} /> : el.text}
    </div>
  )
}

function ChunkPanel({ run, onFeedback }: { run?: RunDetail; onFeedback: (chunkId: string, v: 'up' | 'down' | null) => void }) {
  const [filter, setFilter] = useState<'all' | 'issues'>('all')
  if (!run) return <div className="muted">실행 결과가 여기에 표시됩니다.</div>
  const t = run.totals
  const issues = run.validation.issues ?? []
  const byChunk = new Map<string, Issue[]>()
  for (const i of issues) if (i.chunk_id) byChunk.set(i.chunk_id, [...(byChunk.get(i.chunk_id) ?? []), i])
  const general = issues.filter((i) => !i.chunk_id)
  const chunks: Chunk[] = filter === 'issues' ? run.chunks.filter((c) => byChunk.has(c.chunk_id)) : run.chunks

  return (
    <div className="col">
      <div className="grid-3">
        <Stat label="청크" value={t.chunk_count ?? '-'} />
        <Stat label="평균 토큰" value={t.avg_tokens ?? '-'} />
        <Stat label="윈도우" value={t.windows ?? '-'} />
        <Stat label="입력/출력 토큰" value={<span style={{ fontSize: 14 }}>{(t.input_tokens ?? 0).toLocaleString()} / {(t.output_tokens ?? 0).toLocaleString()}</span>} />
        <Stat label="비용" value={<span style={{ fontSize: 14 }}>{t.cost_usd ? `$${t.cost_usd.toFixed(4)}` : '-'}</span>} />
        <Stat label="LLM 지연" value={<span style={{ fontSize: 14 }}>{t.latency_ms ? `${(t.latency_ms / 1000).toFixed(1)}초` : '-'}</span>} />
      </div>
      <Histogram values={run.chunks.map((c) => c.tokens)} />
      <div className="row">
        {run.validation.ok !== undefined && (run.validation.ok ? <Badge kind="ok">검증 통과</Badge> : <Badge kind="err">검증 오류 {run.validation.error_count}</Badge>)}
        {!!run.validation.warning_count && <Badge kind="warn">경고 {run.validation.warning_count}</Badge>}
        {run.validation.coverage && <Badge>커버리지 {run.validation.coverage.covered}/{run.validation.coverage.total}</Badge>}
        {!!t.fallback_windows && <Badge kind="warn">fallback 윈도우 {t.fallback_windows}</Badge>}
      </div>
      {general.length > 0 && (
        <details open={general.some((i) => i.level === 'error')}>
          <summary className="small">검증 로그 {general.length}건</summary>
          {general.map((i, n) => <div key={n} className="small" style={{ color: i.level === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{i.window !== undefined ? `[W${i.window + 1}] ` : ''}{i.message}</div>)}
        </details>
      )}
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>청크 목록</h3>
        <select aria-label="청크 필터" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'issues')}><option value="all">전체</option><option value="issues">경고 있는 청크</option></select>
      </div>
      {chunks.map((c) => {
        const idx = run.chunks.indexOf(c)
        const fb = run.feedback?.[c.chunk_id]?.value
        return (
          <div key={c.chunk_id} className="chunk-card" style={{ borderLeftColor: chunkColor(idx) }}
            onClick={() => document.getElementById(`chunk-${c.chunk_id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <div className="row" style={{ gap: 6 }}>
              <b className="mono" style={{ color: chunkColor(idx) }}>{c.chunk_id}</b>
              <span className="t grow">{c.title || <span className="muted">(제목 없음)</span>}</span>
              <Badge kind={c.tokens > run.settings.max_tokens ? 'warn' : undefined}>{c.tokens}t</Badge>
            </div>
            {c.summary && <div className="small">{c.summary}</div>}
            {c.keywords.length > 0 && <div className="small muted">#{c.keywords.join(' #')}</div>}
            <div className="small muted">{c.section_path} · p.{c.pages.join(',') || '-'}</div>
            {byChunk.get(c.chunk_id)?.map((i, n) => <div key={n} className="small" style={{ color: 'var(--warn)' }}>⚠ {i.message}</div>)}
            <div className="row" onClick={(e) => e.stopPropagation()} style={{ marginTop: 4 }}>
              <button className={`sm ${fb === 'up' ? 'primary' : ''}`} onClick={() => onFeedback(c.chunk_id, fb === 'up' ? null : 'up')} aria-label="좋음">👍</button>
              <button className={`sm ${fb === 'down' ? 'primary' : ''}`} onClick={() => onFeedback(c.chunk_id, fb === 'down' ? null : 'down')} aria-label="나쁨">👎</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WindowLogs({ run }: { run?: RunDetail }) {
  const [open, setOpen] = useState(0)
  if (!run) return <div className="muted">실행을 선택하세요</div>
  if (run.method !== 'llm') return <div className="muted">규칙 baseline은 LLM을 호출하지 않습니다.</div>
  if (!run.windows.length) return <div className="muted">{run.status === 'done' ? '윈도우 없음' : '실행 중…'}</div>
  const w = run.windows[Math.min(open, run.windows.length - 1)]
  return (
    <div className="col">
      <div className="row">
        {run.windows.map((x, i) => (
          <button key={i} className={`sm ${i === open ? 'primary' : ''}`} onClick={() => setOpen(i)}>
            W{i + 1} {x.fallback ? '⚠' : ''}
          </button>
        ))}
      </div>
      <div className="small muted">
        {w.first_id}~{w.last_id} · Element {w.element_count}개 · ~{w.tokens} 토큰 · 전략 {w.strategy ?? '-'}{w.stitch ? ` · Stitching: ${w.stitch}` : ''}
      </div>
      {w.warnings.map((m, i) => <div key={i} className="banner warn small" style={{ margin: 0 }}>{m}</div>)}
      {w.issues.map((m, i) => <div key={i} className="small" style={{ color: m.level === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{m.code}: {m.message}</div>)}
      <div className="grid-2">
        <div><h3>입력 (System)</h3><pre className="code-box">{w.system}</pre><h3 style={{ marginTop: 8 }}>입력 (User)</h3><pre className="code-box">{w.user}</pre></div>
        <div>
          <h3>시도 {w.attempts.length}회</h3>
          {w.attempts.map((a, i) => (
            <div key={i} className="card" style={{ padding: 8, marginBottom: 6 }}>
              <div className="row small">
                <b>{a.kind === 'repair' ? 'Repair' : `호출 ${a.attempt}`}</b>
                {a.ok ? <Badge kind="ok">성공</Badge> : <Badge kind="err">실패</Badge>}
                {a.strategy && <Badge>{a.strategy}</Badge>}
                {a.latency_ms !== undefined && <span className="muted">{a.latency_ms}ms</span>}
                {a.input_tokens != null && <span className="muted">in {a.input_tokens} / out {a.output_tokens}</span>}
              </div>
              {a.error && <div className="small" style={{ color: 'var(--danger)' }}>{a.error}</div>}
              {a.raw !== undefined && <pre className="code-box" style={{ marginTop: 4 }}>{prettyJson(a.raw)}</pre>}
              {a.request && <details><summary className="small muted">요청 파라미터</summary><pre className="code-box">{JSON.stringify(a.request, null, 2)}</pre></details>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function prettyJson(s: string) {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

