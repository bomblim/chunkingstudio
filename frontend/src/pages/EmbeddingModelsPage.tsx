import { useState } from 'react'
import { vapi, type EmbeddingModelInput } from '../api'
import { Badge, ErrorBanner, Modal, useAsync } from '../components/ui'
import type { EmbeddingModel } from '../types'

const EMPTY: EmbeddingModelInput = {
  name: '', provider: 'openai_compatible', engine: 'tei', base_url: 'http://localhost:8080/v1', model_id: '',
  api_key_env: '', is_external: false, dimension: null, max_input_tokens: 8192, query_prefix: '', document_prefix: '',
  batch_size: 32, extra_params: {}, enabled: true,
}
const ENGINES = ['tei', 'vllm', 'ollama', 'openai', 'other']

export default function EmbeddingModelsPage() {
  const models = useAsync(() => vapi.embeddingModels(), [])
  const [edit, setEdit] = useState<{ id?: number; data: EmbeddingModelInput } | null>(null)
  const [busy, setBusy] = useState<number>()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>임베딩 모델</h1>
          <p>OpenAI 호환 <code>/v1/embeddings</code> 엔드포인트(TEI·vLLM·Ollama·상용 API)를 등록합니다. 헬스체크 시 벡터 차원을 자동으로 확인합니다.</p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>임베딩 모델 등록</button>
      </div>
      <ErrorBanner error={models.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>엔진 / 주소</th><th>모델 ID</th><th>차원</th><th>최대 입력</th><th>지시문(prefix)</th><th>헬스</th><th>상태</th><th /></tr></thead>
          <tbody>
            {models.data?.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.is_external && <> <Badge kind="warn">외부</Badge></>}</td>
                <td>{m.engine || m.provider}<div className="small muted">{m.base_url}</div></td>
                <td className="mono small">{m.model_id}</td>
                <td>{m.dimension ?? '-'}</td>
                <td>{m.max_input_tokens.toLocaleString()}</td>
                <td className="small">{m.query_prefix ? <Badge>질의</Badge> : null} {m.document_prefix ? <Badge>문서</Badge> : null}{!m.query_prefix && !m.document_prefix && <span className="muted">없음</span>}</td>
                <td className="small">
                  {m.last_health.ok === undefined ? <span className="muted">미확인</span> : m.last_health.ok ? <Badge kind="ok">정상 {m.last_health.latency_ms}ms</Badge> : <Badge kind="err">실패</Badge>}
                  {m.last_health.ok === false && <div style={{ color: 'var(--danger)', maxWidth: 280 }}>{m.last_health.message}</div>}
                </td>
                <td>{m.blocked ? <Badge kind="err">차단(폐쇄망)</Badge> : m.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEdit({ id: m.id, data: strip(m) })}>수정</button>
                  <button className="sm" disabled={busy === m.id || !m.enabled} onClick={async () => { setBusy(m.id); try { await vapi.embeddingHealth(m.id) } finally { setBusy(undefined); void models.reload() } }}>{busy === m.id ? '확인 중…' : '헬스체크'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <EmbeddingForm initial={edit.data} id={edit.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void models.reload() }} />}
    </>
  )
}

function strip(m: EmbeddingModel): EmbeddingModelInput {
  const { id: _id, last_health: _h, blocked: _b, ...rest } = m
  return rest
}

function EmbeddingForm({ initial, id, onClose, onSaved }: { initial: EmbeddingModelInput; id?: number; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<EmbeddingModelInput>(initial)
  const [extra, setExtra] = useState(JSON.stringify(initial.extra_params, null, 2))
  const [error, setError] = useState('')
  const set = <K extends keyof EmbeddingModelInput>(k: K, v: EmbeddingModelInput[K]) => setD((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setError('')
    try {
      const body = { ...d, extra_params: JSON.parse(extra || '{}') }
      if (id) await vapi.updateEmbeddingModel(id, body)
      else await vapi.createEmbeddingModel(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title={id ? '임베딩 모델 수정' : '임베딩 모델 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name || !d.model_id} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-3">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">공급자
          <select value={d.provider} onChange={(e) => set('provider', e.target.value as EmbeddingModelInput['provider'])}>
            <option value="openai_compatible">OpenAI 호환 (/v1/embeddings)</option>
            <option value="mock">Mock (오프라인)</option>
          </select>
        </label>
        <label className="field">엔진
          <select value={d.engine} onChange={(e) => set('engine', e.target.value)}>{[...ENGINES, 'mock'].map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        {d.provider !== 'mock' && <label className="field">Base URL<input value={d.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="http://localhost:8080/v1" /></label>}
        <label className="field">모델 ID<input value={d.model_id} onChange={(e) => set('model_id', e.target.value)} placeholder="BAAI/bge-m3" /></label>
        {d.provider !== 'mock' && <label className="field">API 키 환경변수<input value={d.api_key_env} onChange={(e) => set('api_key_env', e.target.value)} placeholder="키 없는 자체 서빙이면 비움" /></label>}
        <label className="field">최대 입력 토큰<input type="number" value={d.max_input_tokens} onChange={(e) => set('max_input_tokens', Number(e.target.value))} /></label>
        <label className="field">배치 크기<input type="number" value={d.batch_size} onChange={(e) => set('batch_size', Number(e.target.value))} /></label>
        <label className="field">차원 (비우면 헬스체크로 자동)<input type="number" value={d.dimension ?? ''} onChange={(e) => set('dimension', e.target.value ? Number(e.target.value) : null)} /></label>
      </div>
      <div className="grid-2" style={{ marginTop: 8 }}>
        <label className="field">질의 지시문 (query prefix)<textarea rows={2} value={d.query_prefix} onChange={(e) => set('query_prefix', e.target.value)} placeholder='예: e5 계열 "query: ", Qwen3-Embedding "Instruct: ...\nQuery: "' /></label>
        <label className="field">문서 지시문 (document prefix)<textarea rows={2} value={d.document_prefix} onChange={(e) => set('document_prefix', e.target.value)} placeholder='예: e5 계열 "passage: "' /></label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>추가 요청 파라미터 (JSON, 요청 본문에 병합)<textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder='{"dimensions": 1024}' /></label>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="check"><input type="checkbox" checked={d.is_external} onChange={(e) => set('is_external', e.target.checked)} />외부(상용) API — 폐쇄망 모드에서 차단</label>
        <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
      </div>
    </Modal>
  )
}
