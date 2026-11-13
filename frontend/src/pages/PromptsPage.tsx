import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { LineDiff, TemplateEditor } from '../components/TemplateEditor'
import { Badge, ErrorBanner, Modal, fmtDate, useAsync } from '../components/ui'
import type { Prompt, PromptVersion } from '../types'

const STATUS_LABEL: Record<string, string> = { draft: '초안', testing: '테스트', approved: '승인', production: '운영' }

export default function PromptsPage() {
  const prompts = useAsync(() => api.prompts(), [])
  const defaults = useAsync(() => api.promptDefaults(), [])
  const [selId, setSelId] = useState<number>()
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const sel = prompts.data?.find((p) => p.id === selId) ?? prompts.data?.[0]

  const wrap = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try { await fn(); await prompts.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>청킹 프롬프트</h1><p>청킹 프롬프트의 버전·상태를 관리합니다. 저장할 때마다 새 버전이 생기고 기존 버전은 바뀌지 않습니다.</p></div>
        <button className="primary" onClick={() => setCreating(true)}>새 프롬프트</button>
      </div>
      <ErrorBanner error={error || prompts.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 12 }}>
        <div className="card col" style={{ gap: 4 }}>
          {prompts.data?.map((p) => (
            <button key={p.id} className={p.id === sel?.id ? 'primary' : 'ghost'} style={{ textAlign: 'left' }} onClick={() => setSelId(p.id)}>
              {p.name} <span className="small" style={{ opacity: .7 }}>v{p.latest_version}</span>
            </button>
          ))}
        </div>
        {sel && <PromptDetail key={sel.id} prompt={sel} variables={defaults.data?.variables ?? {}} wrap={wrap} onSelect={setSelId} />}
      </div>
      {creating && <CreatePrompt onClose={() => setCreating(false)} onCreated={async (p) => { await prompts.reload(); setSelId(p.id); setCreating(false) }} />}
    </>
  )
}

function PromptDetail({ prompt, variables, wrap, onSelect }: { prompt: Prompt; variables: Record<string, string>; wrap: (fn: () => Promise<unknown>) => () => Promise<void>; onSelect: (id: number) => void }) {
  const latest = prompt.versions[prompt.versions.length - 1]
  const [editId, setEditId] = useState<number>(latest.id)
  const base = prompt.versions.find((v) => v.id === editId) ?? latest
  const [system, setSystem] = useState(base.system_template)
  const [user, setUser] = useState(base.user_template)
  const [note, setNote] = useState('')
  const [diff, setDiff] = useState<{ a: PromptVersion; b: PromptVersion } | null>(null)
  const [docTypes, setDocTypes] = useState(prompt.doc_types.join(', '))
  const [desc, setDesc] = useState(prompt.description)

  useEffect(() => { setSystem(base.system_template); setUser(base.user_template) }, [base.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = system !== base.system_template || user !== base.user_template

  return (
    <div className="col">
      <div className="card">
        <div className="row">
          <h2 className="grow">{prompt.name}</h2>
          <Link to="/playground">청킹 화면에서 실험 →</Link>
        </div>
        <div className="grid-2">
          <label className="field">설명<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <label className="field">적용 문서 유형 (쉼표 구분)<input value={docTypes} onChange={(e) => setDocTypes(e.target.value)} placeholder="예: 사내 규정, 매뉴얼" /></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="sm" onClick={wrap(() => api.updatePrompt(prompt.id, desc, docTypes.split(',').map((s) => s.trim()).filter(Boolean)))}>정보 저장</button>
        </div>
      </div>

      <div className="card">
        <h3>버전</h3>
        <table className="list">
          <thead><tr><th>버전</th><th>상태</th><th>메모</th><th>생성</th><th /></tr></thead>
          <tbody>
            {[...prompt.versions].reverse().map((v, i, arr) => (
              <tr key={v.id} style={v.id === editId ? { background: 'var(--accent-soft)' } : undefined}>
                <td><b>v{v.version}</b></td>
                <td>
                  <select aria-label={`v${v.version} 상태`} value={v.status} onChange={(e) => {
                    if (e.target.value === 'production' && !confirm('운영(production)으로 승격할까요? 기존 운영 버전은 승인 상태로 바뀝니다.')) return
                    void wrap(() => api.setVersionStatus(v.id, e.target.value))()
                  }}>
                    {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {v.status === 'production' && <> <Badge kind="ok">운영</Badge></>}
                </td>
                <td className="small">{v.note}</td>
                <td className="small muted">{fmtDate(v.created_at)}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEditId(v.id)}>편집 기준</button>
                  {arr[i + 1] && <button className="sm" onClick={() => setDiff({ a: arr[i + 1], b: v })}>이전과 diff</button>}
                  <button className="sm" onClick={wrap(() => api.rollbackVersion(v.id))} title="이 버전 내용으로 새 버전을 만듭니다">롤백</button>
                  <button className="sm" onClick={wrap(async () => { const name = prompt.name && window.prompt('새 프롬프트 이름', `${prompt.name} (fork v${v.version})`); if (name) onSelect((await api.forkVersion(v.id, name)).id) })}>fork</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card col">
        <h3>v{base.version} 기준 편집 → 새 버전</h3>
        <TemplateEditor label="System 프롬프트" value={system} onChange={setSystem} variables={variables} rows={14} />
        <TemplateEditor label="User 프롬프트" value={user} onChange={setUser} variables={variables} rows={6} />
        <div className="small muted">사용 가능한 변수: {Object.entries(variables).map(([k, v]) => <span key={k} title={v} style={{ marginRight: 8 }}><code>{`{{${k}}}`}</code></span>)}</div>
        <div className="row">
          <input className="grow" placeholder="수정 메모" value={note} onChange={(e) => setNote(e.target.value)} aria-label="수정 메모" />
          <button disabled={!dirty} onClick={() => setDiff({ a: base, b: { ...base, system_template: system, user_template: user, version: 0 } })}>변경 diff</button>
          <button className="primary" disabled={!dirty} onClick={wrap(async () => {
            const v = await api.createVersion(prompt.id, { system_template: system, user_template: user, few_shots: base.few_shots, output_schema: base.output_schema, note: note || `v${base.version} 수정` })
            setNote('')
            setEditId(v.id)
          })}>새 버전 저장</button>
        </div>
        <details>
          <summary className="small">출력 JSON Schema</summary>
          <pre className="code-box">{JSON.stringify(base.output_schema, null, 2)}</pre>
        </details>
      </div>

      {diff && (
        <Modal wide title={`v${diff.a.version} → ${diff.b.version ? `v${diff.b.version}` : '편집 중'}`} onClose={() => setDiff(null)}>
          <h3>System</h3><div className="code-box"><LineDiff a={diff.a.system_template} b={diff.b.system_template} /></div>
          <h3 style={{ marginTop: 12 }}>User</h3><div className="code-box"><LineDiff a={diff.a.user_template} b={diff.b.user_template} /></div>
        </Modal>
      )}
    </div>
  )
}

function CreatePrompt({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Prompt) => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [error, setError] = useState('')
  return (
    <Modal title="새 프롬프트" onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!name.trim()} onClick={async () => { try { onCreated(await api.createPrompt(name.trim(), desc)) } catch (e) { setError(String(e instanceof Error ? e.message : e)) } }}>만들기</button>
    </>}>
      <ErrorBanner error={error} />
      <p className="small muted">기본 경계 청킹 프롬프트로 v1이 생성됩니다.</p>
      <div className="col">
        <label className="field">이름<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field">설명<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      </div>
    </Modal>
  )
}
