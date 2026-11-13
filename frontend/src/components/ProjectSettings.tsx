import { useState } from 'react'
import { api, papi, vapi, type ProjectInput } from '../api'
import type { ChunkSettings, Project } from '../types'
import { MetaEditor, PermissionEditor, metaToRows, rowsToMeta } from './AccessEditor'
import { descendantIds, projectOptions } from './ProjectTree'
import { ErrorBanner, Modal, useAsync } from './ui'

const EXCLUDABLE = ['header', 'footer', 'footnote', 'caption', 'figure']
const DEFAULT_SETTINGS: Partial<ChunkSettings> = { max_tokens: 512, min_tokens: 64, window_tokens: null, exclude_types: ['header', 'footer'], retries: 1, auto_fix: true }

/** 프로젝트 생성/수정. 프로파일 필드는 비워 두면(상속) 상위 프로젝트 값을 쓴다. */
export function ProjectSettingsModal({ project, parentId, projects, onClose, onSaved }: {
  project?: Project
  parentId?: string | null
  projects: Project[]
  onClose: () => void
  onSaved: (p: Project) => void
}) {
  const prompts = useAsync(() => api.prompts(), [])
  const models = useAsync(() => api.models(), [])
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [d, setD] = useState<ProjectInput>(() => project
    ? { name: project.name, description: project.description, parent_id: project.parent_id, sort_order: project.sort_order, method: project.method, prompt_id: project.prompt_id, prompt_version_id: project.prompt_version_id, model_id: project.model_id, params: project.params, settings: project.settings, doc_type: project.doc_type, vector_collection_id: project.vector_collection_id, meta: project.meta, permissions: project.permissions, permission_mode: project.permission_mode }
    : { name: '', description: '', parent_id: parentId ?? null, sort_order: 0, method: null, prompt_id: null, prompt_version_id: null, model_id: null, params: null, settings: null, doc_type: null, vector_collection_id: null, meta: null, permissions: null, permission_mode: null })
  const [error, setError] = useState('')
  const [metaRows, setMetaRows] = useState(() => metaToRows(project?.meta ?? null))
  const [tab, setTab] = useState<'profile' | 'access'>('profile')
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setD((x) => ({ ...x, [k]: v }))
  const exclude = project ? descendantIds(projects, project.id) : undefined
  const parent = projects.find((p) => p.id === d.parent_id)
  const inherited = parent?.effective
  const prompt = prompts.data?.find((p) => p.id === d.prompt_id)
  const s = d.settings ?? {}
  const setS = (k: keyof ChunkSettings, v: unknown) => set('settings', { ...(d.settings ?? DEFAULT_SETTINGS), [k]: v })

  const save = async () => {
    setError('')
    const { meta, error: metaError } = rowsToMeta(metaRows)
    if (metaError) { setError(metaError); setTab('access'); return }
    const body = { ...d, meta, permissions: d.permissions?.length ? d.permissions : null }
    try {
      onSaved(project ? await papi.updateProject(project.id, body) : await papi.createProject(body))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const inh = (field: string, value: string | null | undefined) =>
    inherited && value ? <span className="small muted"> — 상속값: {value}{inherited.source_names?.[field] ? ` (${inherited.source_names[field]})` : ''}</span> : null

  return (
    <Modal wide title={project ? `프로젝트 설정 — ${project.path.join(' / ')}` : '프로젝트 추가'} onClose={onClose}
      footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name.trim()} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-3">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} autoFocus placeholder="예: 방산규정집" /></label>
        <label className="field">상위 프로젝트
          <select value={d.parent_id ?? ''} onChange={(e) => set('parent_id', e.target.value ? e.target.value : null)}>
            <option value="">(최상위)</option>
            {projectOptions(projects, exclude).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="field">정렬 순서<input type="number" value={d.sort_order} onChange={(e) => set('sort_order', Number(e.target.value))} /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>설명<input value={d.description} onChange={(e) => set('description', e.target.value)} /></label>

      <div className="tabs" role="tablist" style={{ marginTop: 14 }}>
        <button role="tab" aria-selected={tab === 'profile'} className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>청킹 프로파일</button>
        <button role="tab" aria-selected={tab === 'access'} className={`tab ${tab === 'access' ? 'active' : ''}`} onClick={() => setTab('access')}>메타데이터 · 권한</button>
      </div>
      {tab === 'access' && (
        <div className="col">
          <h3 style={{ margin: 0 }}>메타데이터</h3>
          <p className="small muted" style={{ margin: 0 }}>벡터 DB에 적재할 때 청크마다 함께 저장됩니다(<code>metadata.project_meta</code>). 상위 값을 물려받고, 같은 키는 이 프로젝트 값이 우선합니다.</p>
          <MetaEditor rows={metaRows} onChange={setMetaRows} inherited={parent ? { meta: parent.access.meta, names: parent.access.meta_source_names } : undefined} />
          <h3 style={{ margin: '12px 0 0' }}>권한 목록</h3>
          <p className="small muted" style={{ margin: 0 }}>이 프로젝트 문서를 볼 수 있는 주체입니다(<code>group:</code>, <code>user:</code>, <code>role:</code> 등 자유 형식). 비어 있으면 제한 없음(전체 공개)입니다. 적재 시 청크에 복사되므로 바꾼 뒤에는 다시 적재해야 검색에 반영됩니다.</p>
          <PermissionEditor value={d.permissions ?? []} onChange={(v) => set('permissions', v)} mode={d.permission_mode ?? 'inherit'}
            onModeChange={(m) => set('permission_mode', m === 'inherit' ? null : m)} effective={parent?.access} />
        </div>
      )}
      <div style={tab === 'profile' ? undefined : { display: 'none' }}>
      <h3 style={{ marginTop: 4 }}>청킹 프로파일</h3>
      <p className="small muted" style={{ marginTop: 0 }}>이 프로젝트와 하위 프로젝트 문서에 쓸 청킹 방식입니다. "상속"으로 두면 상위 프로젝트 설정을 따릅니다. 청킹 화면에서 이 프로젝트 문서를 열면 기본값으로 적용되고, 일괄 청킹도 이 설정으로 실행됩니다.</p>
      <div className="grid-2">
        <label className="field">청킹 방식
          <select value={d.method ?? ''} onChange={(e) => set('method', (e.target.value || null) as ProjectInput['method'])}>
            <option value="">상속</option><option value="llm">LLM 시멘틱</option><option value="rule_structure">규칙 baseline</option>
          </select>
          {!d.method && inh('method', inherited?.method === 'llm' ? 'LLM 시멘틱' : inherited?.method === 'rule_structure' ? '규칙 baseline' : null)}
        </label>
        <label className="field">LLM 모델
          <select value={d.model_id ?? ''} onChange={(e) => set('model_id', e.target.value ? e.target.value : null)}>
            <option value="">상속</option>
            {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.enabled ? '' : ' (비활성)'}</option>)}
          </select>
          {!d.model_id && inh('model_id', inherited?.model_name)}
        </label>
        <label className="field">프롬프트
          <select value={d.prompt_id ?? ''} onChange={(e) => setD((x) => ({ ...x, prompt_id: e.target.value ? e.target.value : null, prompt_version_id: null }))}>
            <option value="">상속</option>
            {prompts.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {!d.prompt_id && inh('prompt_id', inherited?.resolved_prompt_label)}
        </label>
        <label className="field">프롬프트 버전
          <select value={d.prompt_version_id ?? ''} disabled={!d.prompt_id} onChange={(e) => set('prompt_version_id', e.target.value ? e.target.value : null)}>
            <option value="">운영(production) 버전 자동, 없으면 최신</option>
            {prompt?.versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status} 고정</option>)}
          </select>
        </label>
        <label className="field">문서 유형 (프롬프트 {'{{doc_type}}'})
          <input value={d.doc_type ?? ''} onChange={(e) => set('doc_type', e.target.value || null)} placeholder={inherited?.doc_type ? `상속: ${inherited.doc_type}` : '비우면 상속'} />
        </label>
        <label className="field">적재 컬렉션 (벡터 저장소)
          <select value={d.vector_collection_id ?? ''} onChange={(e) => set('vector_collection_id', e.target.value ? e.target.value : null)}>
            <option value="">{parent ? '상속' : '기본 컬렉션 사용'}</option>
            {stores.data?.filter((s) => s.collections.length).map((s) => (
              <optgroup key={s.id} label={`${s.name}${s.enabled ? '' : ' (비활성)'}`}>
                {s.collections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' (기본)' : ''}{c.description ? ` — ${c.description}` : ''}</option>)}
              </optgroup>
            ))}
          </select>
          {!d.vector_collection_id && (() => {
            const def = stores.data?.flatMap((s) => s.collections.map((c) => ({ name: s.name, collection: c.name, is_default: c.is_default }))).find((c) => c.is_default)
            const st = inherited?.vector_store ?? def
            if (!st) return <span className="small" style={{ color: 'var(--warn)' }}> — 기본 컬렉션이 없습니다. '벡터 저장소'에서 지정하세요</span>
            const src = inherited?.vector_store_source
            return <span className="small muted"> — {src?.kind === 'project' ? `상속값: ${st.name} · ${st.collection} (${src.project_name})` : `기본 컬렉션: ${st.name} · ${st.collection}`}</span>
          })()}
        </label>
      </div>

      <div style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!d.settings} onChange={(e) => set('settings', e.target.checked ? { ...DEFAULT_SETTINGS, ...(inherited?.settings ?? {}) } : null)} />청킹 설정을 이 프로젝트에서 지정 {!d.settings && inherited?.settings ? <span className="small muted">(지금은 상속: 최대 {inherited.settings.max_tokens ?? '-'} 토큰{inherited.source_names?.settings ? `, ${inherited.source_names.settings}` : ''})</span> : null}</label>
        {d.settings && (
          <div className="grid-3" style={{ marginTop: 6 }}>
            <label className="field">청크 최대 토큰<input type="number" value={s.max_tokens ?? ''} onChange={(e) => setS('max_tokens', Number(e.target.value))} /></label>
            <label className="field">청크 최소 토큰<input type="number" value={s.min_tokens ?? ''} onChange={(e) => setS('min_tokens', Number(e.target.value))} /></label>
            <label className="field">윈도우 토큰 (비우면 자동)<input type="number" value={s.window_tokens ?? ''} onChange={(e) => setS('window_tokens', e.target.value ? Number(e.target.value) : null)} /></label>
            <label className="field">재시도 횟수<input type="number" value={s.retries ?? 1} onChange={(e) => setS('retries', Number(e.target.value))} /></label>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <span className="small muted">청킹 제외 타입</span>
              <div className="row">
                {EXCLUDABLE.map((t) => (
                  <label key={t} className="check small"><input type="checkbox" checked={(s.exclude_types ?? []).includes(t)} onChange={(e) => setS('exclude_types', e.target.checked ? [...(s.exclude_types ?? []), t] : (s.exclude_types ?? []).filter((x) => x !== t))} />{t}</label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </Modal>
  )
}
