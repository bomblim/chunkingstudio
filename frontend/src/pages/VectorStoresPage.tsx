import { useState } from 'react'
import { vapi, type VectorStoreInput } from '../api'
import { Badge, ErrorBanner, Modal, useAsync } from '../components/ui'

const EMPTY: VectorStoreInput = { name: '', kind: 'milvus', uri: 'http://localhost:19530', token_env: '', db_name: '', enabled: true }

export default function VectorStoresPage() {
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [edit, setEdit] = useState<{ id?: number; data: VectorStoreInput } | null>(null)
  const [busy, setBusy] = useState<number>()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>벡터 저장소</h1>
          <p>청크를 적재할 Milvus 연결을 관리합니다. 메모리 저장소는 Milvus 없이 흐름을 확인하기 위한 개발용입니다.</p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>저장소 등록</button>
      </div>
      <div className="banner info small">로컬 Milvus 실행: <code>docker compose -f deploy/milvus/docker-compose.yml up -d</code></div>
      <ErrorBanner error={stores.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>종류</th><th>URI / DB</th><th>연결</th><th>컬렉션</th><th>상태</th><th /></tr></thead>
          <tbody>
            {stores.data?.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b></td>
                <td>{s.kind === 'milvus' ? 'Milvus' : '메모리(개발용)'}</td>
                <td className="mono small">{s.kind === 'milvus' ? <>{s.uri}{s.db_name && ` / ${s.db_name}`}</> : '-'}</td>
                <td className="small">
                  {s.last_health.ok === undefined ? <span className="muted">미확인</span> : s.last_health.ok ? <Badge kind="ok">정상 {s.last_health.server_version} · {s.last_health.latency_ms}ms</Badge> : <Badge kind="err">실패</Badge>}
                  {s.last_health.ok === false && <div style={{ color: 'var(--danger)', maxWidth: 320 }}>{s.last_health.message}</div>}
                </td>
                <td className="small">{s.last_health.collections?.length ? s.last_health.collections.join(', ') : <span className="muted">-</span>}</td>
                <td>{s.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                <td className="row">
                  <button className="sm" onClick={() => { const { id, last_health: _h, ...rest } = s; setEdit({ id, data: rest }) }}>수정</button>
                  <button className="sm" disabled={busy === s.id || !s.enabled} onClick={async () => { setBusy(s.id); try { await vapi.vectorStoreHealth(s.id) } finally { setBusy(undefined); void stores.reload() } }}>{busy === s.id ? '확인 중…' : '연결 테스트'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <StoreForm initial={edit.data} id={edit.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void stores.reload() }} />}
    </>
  )
}

function StoreForm({ initial, id, onClose, onSaved }: { initial: VectorStoreInput; id?: number; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<VectorStoreInput>(initial)
  const [error, setError] = useState('')
  const set = <K extends keyof VectorStoreInput>(k: K, v: VectorStoreInput[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = async () => {
    setError('')
    try {
      if (id) await vapi.updateVectorStore(id, d)
      else await vapi.createVectorStore(d)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title={id ? '저장소 수정' : '저장소 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-2">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">종류
          <select value={d.kind} onChange={(e) => set('kind', e.target.value as VectorStoreInput['kind'])}>
            <option value="milvus">Milvus</option><option value="memory">메모리 (개발용)</option>
          </select>
        </label>
        {d.kind === 'milvus' && (
          <>
            <label className="field">URI<input value={d.uri} onChange={(e) => set('uri', e.target.value)} placeholder="http://localhost:19530" /></label>
            <label className="field">DB 이름 (비우면 default)<input value={d.db_name} onChange={(e) => set('db_name', e.target.value)} /></label>
            <label className="field">인증 토큰 환경변수<input value={d.token_env} onChange={(e) => set('token_env', e.target.value)} placeholder='MILVUS_TOKEN (값: "user:password" 또는 API 키)' /></label>
          </>
        )}
      </div>
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
    </Modal>
  )
}
