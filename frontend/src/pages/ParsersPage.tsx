import { useState } from 'react'
import { api, type ParserInput } from '../api'
import { Badge, ErrorBanner, Modal, StatusBadge, fmtDate, useAsync, Sid } from '../components/ui'
import type { Parser } from '../types'

const EMPTY: ParserInput = {
  name: '', description: '', version: '1.0', owner: '', input_formats: [], adapter: 'standard', adapter_config: {},
  param_schema: [], api_url: '', api_auth_header: '', api_auth_env: '', api_timeout_sec: 120, api_mode: 'sync',
  api_config: {}, api_status_url: '', api_file_field: 'file', max_file_mb: 50, enabled: true,
}

/** Upstage Agents API(v2) 기본값. Project ID·Agent ID는 사용자가 입력, 키는 UPSTAGE_API_KEY 환경변수 */
const UPSTAGE_PRESET: Partial<ParserInput> = {
  adapter: 'upstage', api_url: 'https://api.upstage.ai/v2', api_mode: 'upstage', api_file_field: 'file',
  api_auth_header: 'Authorization', api_auth_env: 'UPSTAGE_API_KEY', api_timeout_sec: 600,
  input_formats: ['pdf', 'docx', 'pptx', 'xlsx', 'hwp', 'png', 'jpg'],
}
const UPSTAGE_CONFIG_DEFAULT = { project_id: '', model: '', config_id: '1', purpose: 'user_data', include: '', poll_interval_sec: 2, extra_body: {} }

export default function ParsersPage() {
  const parsers = useAsync(() => api.parsers(), [])
  const [edit, setEdit] = useState<{ id?: string; data: ParserInput } | null>(null)
  const [jobsFor, setJobsFor] = useState<Parser | null>(null)
  const [busy, setBusy] = useState<string>()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>문서 파서</h1>
          <p>문서를 표준 스키마로 바꿔 주는 파서(Parser)를 등록합니다. 운영에서는 파서 결과를 수신만 하고, 테스트 업로드 때만 등록된 파서 API를 직접 호출합니다.</p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>파서 등록</button>
      </div>
      <ErrorBanner error={parsers.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>버전</th><th>어댑터</th><th>테스트 호출</th><th>헬스</th><th>테스트 호출 통계</th><th>상태</th><th /></tr></thead>
          <tbody>
            {parsers.data?.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="small muted">{p.description}</div><div className="small muted">{p.input_formats.join(', ')} {p.owner && `· ${p.owner}`}</div></td>
                <td>{p.version}</td>
                <td><code>{p.adapter}</code></td>
                <td>{p.test_callable ? <><Badge kind="accent">{p.api_mode}</Badge><div className="small muted mono" style={{ maxWidth: 260, wordBreak: 'break-all' }}>{p.api_url}</div></> : <Badge>결과 수신 전용</Badge>}</td>
                <td>
                  {p.last_health.ok === undefined ? <span className="muted small">미확인</span> : p.last_health.ok ? <Badge kind="ok">정상 {p.last_health.elapsed_ms}ms</Badge> : <Badge kind="err" title={p.last_health.message}>실패</Badge>}
                  {p.last_health.checked_at && <div className="small muted">{p.last_health.checked_at}</div>}
                  {p.last_health.ok === false && <div className="small" style={{ color: 'var(--danger)' }}>{p.last_health.message}</div>}
                </td>
                <td className="small">
                  {p.monitor.test_calls}회{p.monitor.error_rate !== null && ` · 오류율 ${(p.monitor.error_rate * 100).toFixed(0)}%`}
                  {p.monitor.avg_elapsed_ms !== null && <div className="muted">평균 {(p.monitor.avg_elapsed_ms / 1000).toFixed(1)}초</div>}
                </td>
                <td>{p.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEdit({ id: p.id, data: strip(p) })}>수정</button>
                  {p.test_callable && <button className="sm" disabled={busy === p.id} onClick={async () => { setBusy(p.id); try { await api.parserHealth(p.id) } finally { setBusy(undefined); void parsers.reload() } }}>{busy === p.id ? '확인 중…' : '연결 테스트'}</button>}
                  <button className="sm" onClick={() => setJobsFor(p)}>호출 이력</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ParserForm initial={edit.data} id={edit.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void parsers.reload() }} />}
      {jobsFor && <JobsModal parser={jobsFor} onClose={() => setJobsFor(null)} />}
    </>
  )
}

function strip(p: Parser): ParserInput {
  const { id: _id, last_health: _h, monitor: _m, test_callable: _t, ...rest } = p
  return rest
}

function ParserForm({ initial, id, onClose, onSaved }: { initial: ParserInput; id?: string; onClose: () => void; onSaved: () => void }) {
  const adapters = useAsync(() => api.adapters(), [])
  const [d, setD] = useState<ParserInput>(initial)
  const [paramSchema, setParamSchema] = useState(JSON.stringify(initial.param_schema, null, 2))
  const [adapterCfg, setAdapterCfg] = useState(JSON.stringify(initial.adapter_config, null, 2))
  const [extraBody, setExtraBody] = useState(JSON.stringify(initial.api_config?.extra_body ?? {}, null, 2))
  const [error, setError] = useState('')
  const set = <K extends keyof ParserInput>(k: K, v: ParserInput[K]) => setD((x) => ({ ...x, [k]: v }))
  const cfg = d.api_config ?? {}
  const setCfg = (k: string, v: unknown) => setD((x) => ({ ...x, api_config: { ...(x.api_config ?? {}), [k]: v } }))
  const applyUpstagePreset = () => {
    setD((x) => ({ ...x, ...UPSTAGE_PRESET, api_config: { ...UPSTAGE_CONFIG_DEFAULT, ...(x.api_config ?? {}) } }))
    setExtraBody(JSON.stringify(cfg.extra_body ?? {}, null, 2))
  }

  const save = async () => {
    setError('')
    try {
      const apiConfig = d.api_mode === 'upstage' ? { ...cfg, extra_body: JSON.parse(extraBody || '{}') } : d.api_config
      const body = { ...d, api_config: apiConfig ?? {}, param_schema: JSON.parse(paramSchema || '[]'), adapter_config: JSON.parse(adapterCfg || '{}') }
      if (id) await api.updateParser(id, body)
      else await api.createParser(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title={id ? 'Parser 수정' : 'Parser 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <h3>기본 정보</h3>
      <div className="grid-3">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">버전<input value={d.version} onChange={(e) => set('version', e.target.value)} /></label>
        <label className="field">담당자<input value={d.owner} onChange={(e) => set('owner', e.target.value)} /></label>
      </div>
      <div className="grid-2" style={{ marginTop: 8 }}>
        <label className="field">설명<input value={d.description} onChange={(e) => set('description', e.target.value)} /></label>
        <label className="field">지원 입력 포맷 (쉼표)<input value={d.input_formats.join(', ')} onChange={(e) => set('input_formats', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></label>
      </div>
      <h3 style={{ marginTop: 14 }}>출력 어댑터 (원본 출력 → 표준 스키마)</h3>
      <div className="grid-2">
        <label className="field">어댑터
          <select value={d.adapter} onChange={(e) => set('adapter', e.target.value)}>
            {adapters.data?.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.description}</option>)}
          </select>
        </label>
        <label className="field">어댑터 설정 (JSON)<textarea rows={2} value={adapterCfg} onChange={(e) => setAdapterCfg(e.target.value)} /></label>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <h3 className="grow" style={{ margin: 0 }}>테스트 호출 API (비우면 결과 수신 전용)</h3>
        <button className="sm" onClick={applyUpstagePreset}>Upstage 기본값 채우기</button>
      </div>
      <div className="grid-2" style={{ marginTop: 6 }}>
        <label className="field">{d.api_mode === 'upstage' ? 'Base URL (…/v2)' : '엔드포인트 URL'}<input value={d.api_url} onChange={(e) => set('api_url', e.target.value)} placeholder={d.api_mode === 'upstage' ? 'https://api.upstage.ai/v2' : 'https://parser.internal/api/parse'} /></label>
        <label className="field">호출 방식
          <select value={d.api_mode} onChange={(e) => {
            const mode = e.target.value as ParserInput['api_mode']
            if (mode === 'upstage') applyUpstagePreset()
            else set('api_mode', mode)
          }}>
            <option value="sync">동기 (응답 본문 = 결과)</option>
            <option value="async">비동기 (job_id 폴링)</option>
            <option value="upstage">Upstage Agents API (업로드 → 작업 → 폴링)</option>
          </select>
        </label>
        {d.api_mode === 'upstage' && (
          <>
            <label className="field">Project ID (x-project-id 헤더)<input className="mono" value={String(cfg.project_id ?? '')} onChange={(e) => setCfg('project_id', e.target.value.trim())} placeholder="proj_..." /></label>
            <label className="field">Agent ID (model)<input className="mono" value={String(cfg.model ?? '')} onChange={(e) => setCfg('model', e.target.value.trim())} placeholder="agt_..." /></label>
            <label className="field">config_id<input value={String(cfg.config_id ?? '')} onChange={(e) => setCfg('config_id', e.target.value)} placeholder="1" /></label>
            <label className="field">파일 purpose<input value={String(cfg.purpose ?? '')} onChange={(e) => setCfg('purpose', e.target.value)} placeholder="user_data" /></label>
            <label className="field">include (결과 범위)
              <select value={String(cfg.include ?? '')} onChange={(e) => setCfg('include', e.target.value)}>
                <option value="">기본 (마지막 단계 결과)</option><option value="all">all (모든 단계 결과)</option>
              </select>
            </label>
            <label className="field">폴링 간격 (초)<input type="number" min={0.5} step={0.5} value={Number(cfg.poll_interval_sec ?? 2)} onChange={(e) => setCfg('poll_interval_sec', Number(e.target.value))} /></label>
            <label className="field">작업 요청에 추가할 필드 (JSON)<textarea rows={2} value={extraBody} onChange={(e) => setExtraBody(e.target.value)} placeholder="{}" /></label>
            <div className="small muted" style={{ alignSelf: 'end' }}>API 키는 화면에 저장하지 않습니다. 서버의 <code>{d.api_auth_env || 'UPSTAGE_API_KEY'}</code> 환경변수(backend/.env)에 토큰을 넣으세요.</div>
          </>
        )}
        {d.api_mode === 'async' && <label className="field">상태 조회 URL ({'{job_id}'} 치환)<input value={d.api_status_url} onChange={(e) => set('api_status_url', e.target.value)} placeholder="https://parser.internal/api/jobs/{job_id}" /></label>}
        {d.api_mode !== 'upstage' && <label className="field">파일 필드명<input value={d.api_file_field} onChange={(e) => set('api_file_field', e.target.value)} /></label>}
        <label className="field">인증 헤더 이름<input value={d.api_auth_header} onChange={(e) => set('api_auth_header', e.target.value)} placeholder="Authorization" /></label>
        <label className="field">인증 값 환경변수 (값은 서버 환경변수에서 읽음)<input value={d.api_auth_env} onChange={(e) => set('api_auth_env', e.target.value)} placeholder="PARSER_X_TOKEN" /></label>
        <label className="field">타임아웃 (초)<input type="number" value={d.api_timeout_sec} onChange={(e) => set('api_timeout_sec', Number(e.target.value))} /></label>
        <label className="field">최대 파일 크기 (MB)<input type="number" value={d.max_file_mb} onChange={(e) => set('max_file_mb', Number(e.target.value))} /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>설정 파라미터 스키마 (JSON: [{'{'}name, type, default, description{'}'}])<textarea rows={4} value={paramSchema} onChange={(e) => setParamSchema(e.target.value)} /></label>
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
    </Modal>
  )
}

function JobsModal({ parser, onClose }: { parser: Parser; onClose: () => void }) {
  const jobs = useAsync(() => api.parserJobs(parser.id), [parser.id])
  return (
    <Modal wide title={`${parser.name} 테스트 호출 이력`} onClose={onClose}>
      <table className="list">
        <thead><tr><th>#</th><th>파일</th><th>상태</th><th>시간</th><th>오류</th><th>시각</th><th /></tr></thead>
        <tbody>
          {jobs.data?.map((j) => (
            <tr key={j.id}>
              <td><Sid id={j.id} /></td><td>{j.file_name}</td><td><StatusBadge status={j.status} /></td>
              <td>{j.elapsed_ms ? `${j.elapsed_ms}ms` : '-'}</td>
              <td className="small">{j.error_kind && <b>{j.error_kind}</b>} {j.error.slice(0, 160)}</td>
              <td className="small muted">{fmtDate(j.created_at)}</td>
              <td>{j.document_id && <a href={`/documents/${j.document_id}`}>결과</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobs.data?.length === 0 && <div className="empty">호출 이력이 없습니다</div>}
    </Modal>
  )
}
