import { useState } from 'react'
import { api, type ModelInput } from '../api'
import { Badge, ErrorBanner, Modal, useAsync } from '../components/ui'
import type { LLMModel } from '../types'

const EMPTY: ModelInput = {
  name: '', provider: 'openai_compatible', engine: 'vllm', base_url: 'http://localhost:8000/v1', model_id: '',
  api_key_env: '', is_external: false, context_length: 32768, max_output_tokens: 4096, structured_output: 'auto',
  input_price_per_1m: 0, output_price_per_1m: 0, extra_params: {}, enabled: true,
}

export default function ModelsPage() {
  const models = useAsync(() => api.models(), [])
  const meta = useAsync(() => api.modelsMeta(), [])
  const [edit, setEdit] = useState<{ id?: string; data: ModelInput } | null>(null)
  const [busy, setBusy] = useState<string>()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>청킹 모델</h1>
          <p>시멘틱 청킹에 쓸 LLM을 등록합니다. 상용 API와 오픈소스 자체 서빙(vLLM·TGI·SGLang·Ollama)을 모두 지원합니다.</p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>모델 등록</button>
      </div>
      {meta.data && !meta.data.allow_external_llm && <div className="banner warn">폐쇄망 모드: 외부 모델은 청킹 화면에 표시되지 않고 호출도 차단됩니다.</div>}
      <ErrorBanner error={models.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>공급자 / 엔진</th><th>모델 ID</th><th>컨텍스트</th><th>구조화 출력</th><th>단가 ($/1M in·out)</th><th>헬스</th><th>상태</th><th /></tr></thead>
          <tbody>
            {models.data?.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.is_external && <> <Badge kind="warn">외부</Badge></>}</td>
                <td>{m.provider}<div className="small muted">{m.engine} {m.base_url && `· ${m.base_url}`}</div></td>
                <td className="mono small">{m.model_id}</td>
                <td>{m.context_length.toLocaleString()}<div className="small muted">출력 {m.max_output_tokens.toLocaleString()}</div></td>
                <td className="small">{m.structured_output === 'auto' ? `자동: ${m.strategy_chain.join(' → ')}` : m.strategy_chain.join(' → ')}</td>
                <td className="small">{m.input_price_per_1m || m.output_price_per_1m ? `${m.input_price_per_1m} / ${m.output_price_per_1m}` : '자체 서빙(0)'}</td>
                <td className="small">
                  {m.last_health.ok === undefined ? <span className="muted">미확인</span> : m.last_health.ok ? <Badge kind="ok">정상 {m.last_health.latency_ms}ms · {m.last_health.strategy}</Badge> : <Badge kind="err">실패</Badge>}
                  {m.last_health.ok === false && <div style={{ color: 'var(--danger)', maxWidth: 260 }}>{m.last_health.message}</div>}
                </td>
                <td>{m.blocked ? <Badge kind="err">차단(폐쇄망)</Badge> : m.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEdit({ id: m.id, data: strip(m) })}>수정</button>
                  <button className="sm" disabled={busy === m.id || !m.enabled} onClick={async () => { setBusy(m.id); try { await api.modelHealth(m.id) } finally { setBusy(undefined); void models.reload() } }}>{busy === m.id ? '확인 중…' : '헬스체크'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && meta.data && <ModelForm initial={edit.data} id={edit.id} meta={meta.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void models.reload() }} />}
    </>
  )
}

function strip(m: LLMModel): ModelInput {
  const { id: _id, last_health: _h, blocked: _b, strategy_chain: _s, ...rest } = m
  return rest
}

function ModelForm({ initial, id, meta, onClose, onSaved }: {
  initial: ModelInput; id?: string; meta: { providers: { name: string; label: string; engines: string[] }[]; strategies: string[] }
  onClose: () => void; onSaved: () => void
}) {
  const [d, setD] = useState<ModelInput>(initial)
  const [extra, setExtra] = useState(JSON.stringify(initial.extra_params, null, 2))
  const [error, setError] = useState('')
  const set = <K extends keyof ModelInput>(k: K, v: ModelInput[K]) => setD((x) => ({ ...x, [k]: v }))
  const provider = meta.providers.find((p) => p.name === d.provider)

  const save = async () => {
    setError('')
    try {
      const body = { ...d, extra_params: JSON.parse(extra || '{}') }
      if (id) await api.updateModel(id, body)
      else await api.createModel(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title={id ? '모델 수정' : '모델 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name || !d.model_id} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-3">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">공급자
          <select value={d.provider} onChange={(e) => { const p = meta.providers.find((x) => x.name === e.target.value); setD((x) => ({ ...x, provider: e.target.value as ModelInput['provider'], engine: p?.engines[0] ?? '' })) }}>
            {meta.providers.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
        </label>
        <label className="field">서빙 엔진
          <select value={d.engine} onChange={(e) => set('engine', e.target.value)}>
            {provider?.engines.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label className="field">모델 ID<input value={d.model_id} onChange={(e) => set('model_id', e.target.value)} placeholder={d.provider === 'anthropic' ? 'claude-opus-5-5' : 'Qwen/Qwen2.5-32B-Instruct'} /></label>
        {d.provider !== 'mock' && <label className="field">Base URL{d.provider === 'anthropic' && ' (비우면 기본)'}<input value={d.base_url} onChange={(e) => set('base_url', e.target.value)} /></label>}
        {d.provider !== 'mock' && <label className="field">API 키 환경변수<input value={d.api_key_env} onChange={(e) => set('api_key_env', e.target.value)} placeholder="키 없는 자체 서빙이면 비움" /></label>}
        <label className="field">컨텍스트 길이<input type="number" value={d.context_length} onChange={(e) => set('context_length', Number(e.target.value))} /></label>
        <label className="field">최대 출력 토큰<input type="number" value={d.max_output_tokens} onChange={(e) => set('max_output_tokens', Number(e.target.value))} /></label>
        <label className="field">구조화 출력 전략
          <select value={d.structured_output} onChange={(e) => set('structured_output', e.target.value)}>
            {meta.strategies.map((s) => <option key={s} value={s}>{s === 'auto' ? 'auto (엔진별 자동 + 거부 시 강등)' : s}</option>)}
          </select>
        </label>
        <label className="field">입력 단가 ($/1M)<input type="number" step="0.01" value={d.input_price_per_1m} onChange={(e) => set('input_price_per_1m', Number(e.target.value))} /></label>
        <label className="field">출력 단가 ($/1M)<input type="number" step="0.01" value={d.output_price_per_1m} onChange={(e) => set('output_price_per_1m', Number(e.target.value))} /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>추가 요청 파라미터 (JSON, 요청 본문에 병합)<textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="check"><input type="checkbox" checked={d.is_external} onChange={(e) => set('is_external', e.target.checked)} />외부(상용) API — 폐쇄망 모드에서 차단</label>
        <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
      </div>
    </Modal>
  )
}
