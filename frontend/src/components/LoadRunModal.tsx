import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DEFAULT_EMBED_TEMPLATE, api, vapi } from '../api'
import type { VectorIndex } from '../types'
import { Badge, ErrorBanner, Modal, fmtDate, shortId, useAsync } from './ui'

/** 청킹 실행 하나를 그 문서 프로젝트의 컬렉션에 적재하는 창 (청킹 화면에서 연다) */
function useRunPicker(presetRun?: string) {
  const docs = useAsync(() => api.documents(), [])
  const [docId, setDocId] = useState<string>()
  const [runId, setRunId] = useState<string | undefined>(presetRun)
  const runs = useAsync(() => (docId ? api.runs(docId) : Promise.resolve([])), [docId])
  useEffect(() => {
    if (presetRun && !docId) void api.run(presetRun).then((r) => setDocId(r.document_id))
  }, [presetRun, docId])
  useEffect(() => {
    if (!docId && !presetRun && docs.data?.length) setDocId(docs.data[0].id)
  }, [docs.data, docId, presetRun])
  const doneRuns = runs.data?.filter((r) => r.status === 'done' && (r.totals.chunk_count ?? 0) > 0) ?? []
  useEffect(() => {
    if (runs.data && !doneRuns.some((r) => r.id === runId)) setRunId(doneRuns[0]?.id)
  }, [runs.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = doneRuns.find((r) => r.id === runId)
  const picker = (
    <div className="grid-2">
      <label className="field">문서
        <select value={docId ?? ''} onChange={(e) => { setDocId(e.target.value); setRunId(undefined) }}>
          {docs.data?.map((d) => <option key={d.id} value={d.id}>{d.title} ({shortId(d.id)})</option>)}
        </select>
      </label>
      <label className="field">청킹 실행 (완료된 것만)
        <select value={runId ?? ''} onChange={(e) => setRunId(e.target.value)}>
          {doneRuns.map((r) => <option key={r.id} value={r.id}>{shortId(r.id)} · {r.method === 'llm' ? `LLM ${r.prompt_label} · ${r.model_name}` : '규칙 baseline'} · 청크 {r.totals.chunk_count}개 · {fmtDate(r.created_at)}</option>)}
        </select>
        {runs.data && !doneRuns.length && <span className="small" style={{ color: 'var(--warn)' }}>완료된 청킹 실행이 없습니다. <Link to={`/playground?doc=${docId}`}>청킹 화면에서 실행 →</Link></span>}
      </label>
    </div>
  )
  return { docId, runId, run, picker }
}

export function LoadRunModal({ presetRun, onClose, onCreated }: { presetRun?: string; onClose: () => void; onCreated: (ix: VectorIndex) => void }) {
  const { docId, runId, run, picker } = useRunPicker(presetRun)
  const meta = useAsync(() => vapi.indexMeta(), [])
  const models = useAsync(() => vapi.embeddingModels(true), [])
  const target = useAsync(() => (docId ? vapi.indexTarget({ document_id: docId }) : Promise.resolve(null)), [docId])
  const [modelId, setModelId] = useState<string>()
  const [template, setTemplate] = useState(DEFAULT_EMBED_TEMPLATE)
  const [metric, setMetric] = useState('COSINE')
  const [error, setError] = useState('')

  const t = target.data
  const existing = t?.existing_index ?? null
  useEffect(() => {
    if (existing) {
      setModelId(existing.embedding_model_id)
      setTemplate(existing.embed_template)
      setMetric(existing.metric)
    } else if (!modelId && models.data?.length) setModelId(models.data[0].id)
  }, [existing?.id, models.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const model = models.data?.find((m) => m.id === modelId)
  const tooLong = model && run?.totals.max_tokens && run.totals.max_tokens > model.max_input_tokens
  const already = existing && docId && existing.document_ids.includes(docId)

  const submit = async () => {
    if (!runId || !modelId) return
    setError('')
    try {
      onCreated(await vapi.createIndex({ run_id: runId, embedding_model_id: modelId, embed_template: template, metric }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal wide title="청크 적재 (임베딩 → 벡터 저장소)" onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!runId || !modelId || !t?.store || !t.store.enabled} onClick={() => void submit()}>적재 시작</button></>}>
      <ErrorBanner error={error || target.error} />
      {picker}
      <div className="card" style={{ margin: '8px 0', padding: 10 }}>
        <div className="small muted">적재 위치 — 문서가 속한 프로젝트의 적재 컬렉션 (프로젝트 설정에서 변경)</div>
        {t?.store ? (
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <b>{t.store.name}</b><span className="mono">{t.store.collection}</span>
            {t.source.kind === 'default'
              ? <Badge kind="accent">기본 컬렉션 · {t.source.reason}</Badge>
              : <span className="small muted">프로젝트 '{t.source.project_name}' 설정</span>}
            {!t.store.enabled && <Badge kind="warn">비활성 저장소</Badge>}
            <span className="small muted">{existing ? `기존 청크 ${existing.chunk_count}개` : '컬렉션 새로 생성'}</span>
          </div>
        ) : t && <div className="banner warn small" style={{ margin: '4px 0 0' }}>적재할 컬렉션이 없습니다. '벡터 저장소'에서 기본 컬렉션을 지정하세요.</div>}
        {already && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>이 문서는 이미 적재되어 있습니다. 적재하면 이 문서의 이전 청크를 지우고 선택한 실행으로 교체합니다.</div>}
      </div>
      <div className="grid-3">
        <label className="field">임베딩 모델
          <select value={modelId ?? ''} disabled={!!existing} onChange={(e) => setModelId(e.target.value)}>
            {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.dimension ? ` (${m.dimension}d)` : ''}</option>)}
          </select>
        </label>
        <label className="field">유사도
          <select value={metric} disabled={!!existing} onChange={(e) => setMetric(e.target.value)}>{meta.data?.metrics.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
      </div>
      {existing && <div className="small muted">기존 컬렉션에 추가하므로 그 컬렉션의 임베딩 모델({existing.embedding_model_name})·텍스트 템플릿·유사도를 그대로 씁니다.</div>}
      <div className="field" style={{ marginTop: 8 }}>
        <span className="small muted">임베딩 텍스트 템플릿 — 원문(text)은 그대로 저장하고, 벡터는 이 템플릿으로 만든 텍스트로 계산합니다</span>
        <div className="row">{meta.data?.templates.map((tp) => <button key={tp.label} disabled={!!existing} className={`sm ${template === tp.template ? 'primary' : ''}`} onClick={() => setTemplate(tp.template)}>{tp.label}</button>)}</div>
        <textarea rows={3} value={template} disabled={!!existing} onChange={(e) => setTemplate(e.target.value)} />
        <span className="small muted">사용 가능: {meta.data?.template_fields.map((f) => <code key={f} style={{ marginRight: 6 }}>{`{${f}}`}</code>)}</span>
      </div>
      {tooLong && <div className="banner warn" style={{ marginTop: 8 }}>가장 큰 청크(~{run?.totals.max_tokens} 토큰)가 임베딩 모델 최대 입력({model?.max_input_tokens} 토큰)을 넘습니다. 잘리거나 실패할 수 있습니다.</div>}
      {t?.store?.kind === 'memory' && <div className="banner info small" style={{ marginTop: 8 }}>메모리 저장소는 개발용입니다. 필터 검색은 지원하지 않습니다.</div>}
    </Modal>
  )
}

