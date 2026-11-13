import { useState } from 'react'
import { vapi, type RerankModelInput } from '../api'
import { Badge, ErrorBanner, Modal, useAsync } from '../components/ui'
import type { RerankModel } from '../types'

const EMPTY: RerankModelInput = {
  name: '', provider: 'tei', engine: 'tei', base_url: 'http://localhost:8081', model_id: '', api_key_env: '',
  is_external: false, max_input_tokens: 512, batch_size: 32, document_template: '{text}', extra_params: {}, enabled: true,
}
const ENGINES = ['tei', 'vllm', 'nim', 'infinity', 'xinference', 'cohere', 'jina', 'other']
const PROVIDER_LABEL: Record<RerankModel['provider'], string> = {
  tei: 'TEI (/rerank)',
  cohere_compatible: 'Cohere 형식 (/rerank)',
  nvidia_nim: 'NVIDIA NIM (/ranking)',
  mock: 'Mock (오프라인)',
}
const TEMPLATES = [
  { label: '본문만', template: '{text}' },
  { label: '제목 + 본문', template: '{title}\n{text}' },
  { label: '문서 제목 + 섹션 경로 + 본문', template: '[{document_title}] {section_path}\n{text}' },
]

export default function RerankModelsPage() {
  const models = useAsync(() => vapi.rerankModels(), [])
  const [edit, setEdit] = useState<{ id?: string; data: RerankModelInput } | null>(null)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')

  const remove = async (m: RerankModel) => {
    if (!confirm(`'${m.name}' 리랭크 모델을 삭제할까요?`)) return
    setError('')
    try { await vapi.deleteRerankModel(m.id); void models.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>리랭크 모델</h1>
          <p>
            벡터 검색으로 가져온 후보 청크를 질의와 함께 다시 점수 매기는 cross-encoder 모델을 등록합니다.
            "질의 테스트"에서 리랭크 모델을 고르면 후보를 재정렬해 상위 결과만 보여 줍니다.
            TEI <code>/rerank</code>, Cohere 형식 <code>/rerank</code>(vLLM·Infinity·Xinference·Jina·Cohere), NVIDIA NIM <code>/v1/ranking</code>(Nemotron 리랭크)을 지원합니다.
          </p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>리랭크 모델 등록</button>
      </div>
      <ErrorBanner error={error || models.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>형식 / 주소</th><th>모델 ID</th><th>최대 입력</th><th>배치</th><th>문서 텍스트</th><th>헬스</th><th>상태</th><th /></tr></thead>
          <tbody>
            {models.data?.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.is_external && <> <Badge kind="warn">외부</Badge></>}</td>
                <td>{PROVIDER_LABEL[m.provider] ?? m.provider}{m.engine && m.engine !== m.provider && <span className="muted small"> · {m.engine}</span>}<div className="small muted">{m.base_url}</div></td>
                <td className="mono small">{m.model_id || '-'}</td>
                <td>{m.max_input_tokens.toLocaleString()}</td>
                <td>{m.batch_size}</td>
                <td className="mono small">{m.document_template.replace(/\n/g, ' ⏎ ')}</td>
                <td className="small">
                  {m.last_health.ok === undefined ? <span className="muted">미확인</span> : m.last_health.ok
                    ? <><Badge kind={m.last_health.sane === false ? 'warn' : 'ok'}>정상 {m.last_health.latency_ms}ms</Badge>{m.last_health.sane === false && <div style={{ color: 'var(--warn)' }}>관련 문장 점수가 더 낮음</div>}</>
                    : <Badge kind="err">실패</Badge>}
                  {m.last_health.ok === false && <div style={{ color: 'var(--danger)', maxWidth: 280 }}>{m.last_health.message}</div>}
                </td>
                <td>{m.blocked ? <Badge kind="err">차단(폐쇄망)</Badge> : m.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEdit({ id: m.id, data: strip(m) })}>수정</button>
                  <button className="sm" disabled={busy === m.id || !m.enabled} onClick={async () => { setBusy(m.id); try { await vapi.rerankHealth(m.id) } finally { setBusy(undefined); void models.reload() } }}>{busy === m.id ? '확인 중…' : '헬스체크'}</button>
                  <button className="sm danger" onClick={() => void remove(m)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {models.data?.length === 0 && <div className="empty">리랭크 모델이 없습니다.</div>}
      </div>
      <div className="banner info small" style={{ marginTop: 12 }}>
        자체 서빙 예: <code>docker run -p 8081:80 ghcr.io/huggingface/text-embeddings-inference:latest --model-id BAAI/bge-reranker-v2-m3</code> (TEI) ·
        {' '}<code>vllm serve BAAI/bge-reranker-v2-m3 --task score</code> (vLLM, Base URL <code>http://host:8000/v1</code>)
      </div>
      {edit && <RerankForm initial={edit.data} id={edit.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void models.reload() }} />}
    </>
  )
}

function strip(m: RerankModel): RerankModelInput {
  const { id: _id, last_health: _h, blocked: _b, ...rest } = m
  return rest
}

function RerankForm({ initial, id, onClose, onSaved }: { initial: RerankModelInput; id?: string; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<RerankModelInput>(initial)
  const [extra, setExtra] = useState(JSON.stringify(initial.extra_params, null, 2))
  const [error, setError] = useState('')
  const set = <K extends keyof RerankModelInput>(k: K, v: RerankModelInput[K]) => setD((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setError('')
    try {
      const body = { ...d, extra_params: JSON.parse(extra || '{}') }
      if (id) await vapi.updateRerankModel(id, body)
      else await vapi.createRerankModel(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title={id ? '리랭크 모델 수정' : '리랭크 모델 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name || ((d.provider === 'cohere_compatible' || d.provider === 'nvidia_nim') && !d.model_id)} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-3">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">API 형식
          <select value={d.provider} onChange={(e) => set('provider', e.target.value as RerankModelInput['provider'])}>
            {(Object.keys(PROVIDER_LABEL) as RerankModel['provider'][]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="field">엔진
          <select value={d.engine} onChange={(e) => set('engine', e.target.value)}>{[...ENGINES, 'mock'].map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        {d.provider !== 'mock' && (
          <label className="field">Base URL
            <input value={d.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder={d.provider === 'tei' ? 'http://localhost:8081' : 'http://localhost:8000/v1'} />
            <span className="small muted">{'{Base URL}'}{d.provider === 'nvidia_nim' ? '/ranking' : '/rerank'} 로 호출</span>
          </label>
        )}
        <label className="field">모델 ID{d.provider === 'tei' && <span className="small muted"> (TEI는 선택)</span>}
          <input value={d.model_id} onChange={(e) => set('model_id', e.target.value)} placeholder={d.provider === 'nvidia_nim' ? 'nvidia/llama-nemotron-rerank-1b-v2' : 'BAAI/bge-reranker-v2-m3'} />
        </label>
        {d.provider !== 'mock' && <label className="field">API 키 환경변수<input value={d.api_key_env} onChange={(e) => set('api_key_env', e.target.value)} placeholder="키 없는 자체 서빙이면 비움" /></label>}
        <label className="field">최대 입력 토큰 (질의+문서)<input type="number" value={d.max_input_tokens} onChange={(e) => set('max_input_tokens', Number(e.target.value))} /></label>
        <label className="field">배치 크기 (한 요청당 후보 수)<input type="number" value={d.batch_size} onChange={(e) => set('batch_size', Number(e.target.value))} /></label>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <span className="small muted">리랭크에 넣을 문서 텍스트 — 사용 가능: <code>{'{text}'}</code> <code>{'{title}'}</code> <code>{'{section_path}'}</code> <code>{'{document_title}'}</code></span>
        <div className="row">{TEMPLATES.map((t) => <button key={t.label} className={`sm ${d.document_template === t.template ? 'primary' : ''}`} onClick={() => set('document_template', t.template)}>{t.label}</button>)}</div>
        <textarea rows={2} value={d.document_template} onChange={(e) => set('document_template', e.target.value)} />
      </div>
      <label className="field" style={{ marginTop: 8 }}>추가 요청 파라미터 (JSON, 요청 본문에 병합)<textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={d.provider === 'tei' ? '{"raw_scores": false}' : d.provider === 'nvidia_nim' ? '{"truncate": "NONE"}' : '{"max_tokens_per_doc": 4096}'} /></label>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="check"><input type="checkbox" checked={d.is_external} onChange={(e) => set('is_external', e.target.checked)} />외부(상용) API — 폐쇄망 모드에서 차단</label>
        <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
      </div>
    </Modal>
  )
}
