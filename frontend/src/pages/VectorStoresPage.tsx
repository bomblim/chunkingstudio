import { useState } from 'react'
import { vapi, type VectorStoreInput } from '../api'
import { Badge, ErrorBanner, Modal, useAsync } from '../components/ui'

const EMPTY: VectorStoreInput = { name: '', kind: 'milvus', uri: 'http://localhost:19530', token_env: '', db_name: '', tls_ca_path: '', tls_server_name: '', collection: '', is_default: false, enabled: true }

export default function VectorStoresPage() {
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [edit, setEdit] = useState<{ id?: number; data: VectorStoreInput } | null>(null)
  const [busy, setBusy] = useState<number>()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>벡터 저장소</h1>
          <p>
            청크를 적재할 곳(연결 + 컬렉션)을 관리합니다. 프로젝트 설정에서 저장소를 지정하면 그 프로젝트 문서는 이 컬렉션에 적재되고,
            미분류 문서와 저장소를 지정하지 않은 프로젝트는 <b>기본 저장소</b>에 적재됩니다.
          </p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>저장소 등록</button>
      </div>
      <div className="banner info small">로컬 Milvus 실행: <code>docker compose -f deploy/milvus/docker-compose.yml up -d</code></div>
      <ErrorBanner error={stores.error} />
      <div className="card">
        <table className="list">
          <thead><tr><th>이름</th><th>적재 컬렉션</th><th>사용 프로젝트</th><th>종류 · URI</th><th>연결</th><th>상태</th><th /></tr></thead>
          <tbody>
            {stores.data?.map((s) => {
              const known = s.last_health.collections
              return (
                <tr key={s.id}>
                  <td><b>{s.name}</b>{s.is_default && <> <Badge kind="accent">기본</Badge></>}</td>
                  <td>
                    <span className="mono">{s.collection}</span>
                    {known && !known.includes(s.collection) && <div className="small muted">아직 없음 (첫 적재 때 생성)</div>}
                  </td>
                  <td className="small">
                    {s.projects.length ? s.projects.join(', ') : null}
                    {s.is_default && <div className="muted">미분류 문서 · 저장소 미지정 프로젝트</div>}
                    {!s.projects.length && !s.is_default && <span className="muted">-</span>}
                  </td>
                  <td className="small">
                    {s.kind === 'milvus' ? 'Milvus' : '메모리(개발용)'}
                    {s.kind === 'milvus' && (
                      <div className="mono">{s.uri}{s.db_name && ` / ${s.db_name}`}{s.uri.toLowerCase().startsWith('https://') && <span className="badge" style={{ marginLeft: 6 }} title={s.tls_ca_path ? `CA: ${s.tls_ca_path}` : '공인 CA로 검증'}>TLS</span>}</div>
                    )}
                  </td>
                  <td className="small">
                    {s.last_health.ok === undefined ? <span className="muted">미확인</span> : s.last_health.ok ? <Badge kind="ok">정상 {s.last_health.server_version} · {s.last_health.latency_ms}ms</Badge> : <Badge kind="err">실패</Badge>}
                    {s.last_health.ok === false && <div style={{ color: 'var(--danger)', maxWidth: 320 }}>{s.last_health.message}</div>}
                    {!!known?.length && <div className="muted" title={known.join(', ')}>서버 컬렉션 {known.length}개</div>}
                  </td>
                  <td>{s.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}</td>
                  <td className="row">
                    <button className="sm" onClick={() => { const { id, last_health: _h, projects: _p, ...rest } = s; setEdit({ id, data: rest }) }}>수정</button>
                    <button className="sm" disabled={busy === s.id || !s.enabled} onClick={async () => { setBusy(s.id); try { await vapi.vectorStoreHealth(s.id) } finally { setBusy(undefined); void stores.reload() } }}>{busy === s.id ? '확인 중…' : '연결 테스트'}</button>
                  </td>
                </tr>
              )
            })}
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
  const wasDefault = initial.is_default
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
    <Modal title={id ? '저장소 수정' : '저장소 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name || !d.collection} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-2">
        <label className="field">이름<input value={d.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">종류
          <select value={d.kind} onChange={(e) => set('kind', e.target.value as VectorStoreInput['kind'])}>
            <option value="milvus">Milvus</option><option value="memory">메모리 (개발용)</option>
          </select>
        </label>
        <label className="field">적재 컬렉션 이름
          <input className="mono" value={d.collection} onChange={(e) => set('collection', e.target.value)} placeholder="예: cs_defense_rules" />
          <span className="small muted">영문자·밑줄로 시작, 영문자·숫자·밑줄만. 없으면 첫 적재 때 만들어집니다.</span>
        </label>
        {d.kind === 'milvus' && (
          <>
            <label className="field">URI<input value={d.uri} onChange={(e) => set('uri', e.target.value)} placeholder="http://localhost:19530" /></label>
            <label className="field">DB 이름 (비우면 default)<input value={d.db_name} onChange={(e) => set('db_name', e.target.value)} /></label>
            <label className="field">인증 토큰 환경변수<input value={d.token_env} onChange={(e) => set('token_env', e.target.value)} placeholder='MILVUS_TOKEN (값: "user:password" 또는 API 키)' /></label>
            {d.uri.toLowerCase().startsWith('https://') && (
              <>
                <label className="field">CA 인증서 경로 (사설 CA일 때)<input value={d.tls_ca_path} onChange={(e) => set('tls_ca_path', e.target.value)} placeholder="/data/tls/ca.pem (서버 기준 경로)" /></label>
                <label className="field">인증서 서버 이름 (선택)<input value={d.tls_server_name} onChange={(e) => set('tls_server_name', e.target.value)} placeholder="인증서 SAN과 URI 호스트가 다를 때" /></label>
              </>
            )}
          </>
        )}
      </div>
      {id && initial.collection && d.collection !== initial.collection && (
        <div className="banner warn small" style={{ marginTop: 8 }}>컬렉션 이름을 바꾸면 이후 적재는 새 컬렉션으로 갑니다. 기존 컬렉션의 데이터는 옮겨지지 않습니다.</div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 16 }}>
        <label className="check"><input type="checkbox" checked={d.enabled} disabled={wasDefault} onChange={(e) => set('enabled', e.target.checked)} />활성</label>
        <label className="check" title={wasDefault ? '다른 저장소를 기본으로 지정하면 해제됩니다' : undefined}>
          <input type="checkbox" checked={d.is_default} disabled={wasDefault} onChange={(e) => setD((x) => ({ ...x, is_default: e.target.checked, enabled: e.target.checked ? true : x.enabled }))} />
          기본 저장소 (미분류 문서·저장소 미지정 프로젝트가 적재되는 곳)
        </label>
      </div>
    </Modal>
  )
}
