import { useState } from 'react'
import { vapi, type CollectionInput, type VectorStoreInput } from '../api'
import { Badge, ConfirmModal, ErrorBanner, Modal, useAsync } from '../components/ui'
import type { VectorCollection, VectorStore } from '../types'

const EMPTY: VectorStoreInput = { name: '', kind: 'milvus', uri: 'http://localhost:19530', token_env: '', db_name: '', tls_ca_path: '', tls_server_name: '', enabled: true }

export default function VectorStoresPage() {
  const stores = useAsync(() => vapi.vectorStores(), [])
  const [edit, setEdit] = useState<{ id?: string; data: VectorStoreInput } | null>(null)
  const [collEdit, setCollEdit] = useState<{ store: VectorStore; coll?: VectorCollection } | null>(null)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [emptying, setEmptying] = useState<{ store: VectorStore; coll: VectorCollection } | null>(null)

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    setNotice('')
    try { await fn(); void stores.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const empty = (c: VectorCollection) =>
    act(async () => {
      setBusy(c.id)
      try {
        const r = await vapi.emptyCollection(c.id)
        setNotice(r.dropped || r.removed_indexes
          ? `'${r.collection}' 컬렉션을 비웠습니다 (청크 ${r.removed_chunks}개, 적재 기록 ${r.removed_indexes}건 삭제).`
          : `'${r.collection}' 컬렉션은 이미 비어 있습니다.`)
      } finally {
        setBusy(undefined)
      }
    })
  const makeDefault = (c: VectorCollection) => act(() => vapi.updateCollection(c.id, { name: c.name, description: c.description, is_default: true }))
  const remove = (c: VectorCollection) => {
    if (!confirm(`'${c.name}' 컬렉션 등록을 삭제할까요?\nMilvus에 적재된 실제 데이터는 지워지지 않습니다.`)) return
    void act(() => vapi.deleteCollection(c.id))
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>벡터 저장소</h1>
          <p>
            Milvus 연결과, 연결마다 청크를 적재할 <b>컬렉션</b>을 관리합니다. 프로젝트 설정에서 컬렉션을 지정하면 그 프로젝트 문서는 해당 컬렉션에 적재되고,
            미분류 문서와 컬렉션을 지정하지 않은 프로젝트는 <b>기본 컬렉션</b>에 적재됩니다.
          </p>
        </div>
        <button className="primary" onClick={() => setEdit({ data: { ...EMPTY } })}>연결 등록</button>
      </div>
      <div className="banner info small">로컬 Milvus 실행: <code>docker compose -f deploy/milvus/docker-compose.yml up -d</code></div>
      <ErrorBanner error={error || stores.error} />
      {notice && <div className="banner info">{notice}</div>}

      {stores.data?.map((s) => {
        const known = s.last_health.collections
        return (
          <div key={s.id} className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <h2 style={{ margin: 0 }}>{s.name}</h2>
                  <Badge>{s.kind === 'milvus' ? 'Milvus' : '메모리(개발용)'}</Badge>
                  {s.enabled ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}
                </div>
                {s.kind === 'milvus' && (
                  <div className="mono small muted" style={{ marginTop: 2 }}>
                    {s.uri}{s.db_name && ` / ${s.db_name}`}
                    {s.uri.toLowerCase().startsWith('https://') && <span className="badge" style={{ marginLeft: 6 }} title={s.tls_ca_path ? `CA: ${s.tls_ca_path}` : '공인 CA로 검증'}>TLS</span>}
                  </div>
                )}
                <div className="small" style={{ marginTop: 4 }}>
                  {s.last_health.ok === undefined ? <span className="muted">연결 미확인</span> : s.last_health.ok ? <Badge kind="ok">정상 {s.last_health.server_version} · {s.last_health.latency_ms}ms</Badge> : <Badge kind="err">연결 실패</Badge>}
                  {s.last_health.ok === false && <span style={{ color: 'var(--danger)', marginLeft: 6 }}>{s.last_health.message}</span>}
                </div>
              </div>
              <button className="sm" onClick={() => { const { id, last_health: _h, collections: _c, ...rest } = s; setEdit({ id, data: rest }) }}>연결 수정</button>
              <button className="sm" disabled={busy === s.id || !s.enabled} onClick={async () => { setBusy(s.id); try { await vapi.vectorStoreHealth(s.id) } finally { setBusy(undefined); void stores.reload() } }}>{busy === s.id ? '확인 중…' : '연결 테스트'}</button>
              <button className="sm primary" onClick={() => setCollEdit({ store: s })}>컬렉션 추가</button>
            </div>

            <table className="list" style={{ marginTop: 10 }}>
              <thead><tr><th>컬렉션</th><th>설명</th><th>사용 프로젝트</th><th>적재 청크</th><th /></tr></thead>
              <tbody>
                {s.collections.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="mono"><b>{c.name}</b></span>{c.is_default && <> <Badge kind="accent">기본</Badge></>}
                      {known && !known.includes(c.name) && <div className="small muted">서버에 아직 없음 (첫 적재 때 생성)</div>}
                    </td>
                    <td className="small">{c.description || <span className="muted">-</span>}</td>
                    <td className="small">
                      {c.projects.length ? c.projects.join(', ') : null}
                      {c.is_default && <div className="muted">미분류 문서 · 컬렉션 미지정 프로젝트</div>}
                      {!c.projects.length && !c.is_default && <span className="muted">-</span>}
                    </td>
                    <td>{c.chunk_count ?? <span className="muted">-</span>}</td>
                    <td className="row">
                      <button className="sm" onClick={() => setCollEdit({ store: s, coll: c })}>수정</button>
                      <button className="sm" disabled={!s.enabled || busy === c.id} title="적재된 청크를 모두 지웁니다 (등록·프로젝트 지정은 유지)" onClick={() => setEmptying({ store: s, coll: c })}>{busy === c.id ? '비우는 중…' : '비우기'}</button>
                      {!c.is_default && <button className="sm" disabled={!s.enabled} onClick={() => void makeDefault(c)}>기본으로</button>}
                      {!c.is_default && <button className="sm danger" disabled={c.projects.length > 0} title={c.projects.length ? '사용 중인 프로젝트가 있어 삭제할 수 없습니다' : undefined} onClick={() => remove(c)}>삭제</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!s.collections.length && <div className="empty">컬렉션이 없습니다. "컬렉션 추가"로 적재할 컬렉션을 등록하세요.</div>}
          </div>
        )
      })}

      {edit && <StoreForm initial={edit.data} id={edit.id} hasDefault={!!stores.data?.find((s) => s.id === edit.id)?.collections.some((c) => c.is_default)}
        onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void stores.reload() }} />}
      {emptying && (
        <ConfirmModal title="컬렉션 비우기" danger confirmLabel="비우기" onClose={() => setEmptying(null)}
          onConfirm={async () => { const c = emptying.coll; setEmptying(null); await empty(c) }}>
          <p style={{ marginTop: 0 }}>
            <b>{emptying.store.name}</b>의 <span className="mono"><b>{emptying.coll.name}</b></span> 컬렉션을 비울까요?
          </p>
          <div className="banner warn small">
            적재된 청크{emptying.coll.chunk_count ? <b> {emptying.coll.chunk_count}개</b> : ''}가 벡터 저장소에서 모두 지워지고 <b>되돌릴 수 없습니다</b>.
          </div>
          {emptying.coll.projects.length > 0 && <p className="small">이 컬렉션을 쓰는 프로젝트: <b>{emptying.coll.projects.join(', ')}</b> — 질의하려면 다시 적재해야 합니다.</p>}
          {emptying.coll.is_default && <p className="small">기본 컬렉션입니다. 미분류 문서와 컬렉션을 지정하지 않은 프로젝트의 청크도 함께 지워집니다.</p>}
          <p className="small muted" style={{ marginBottom: 0 }}>컬렉션 등록과 프로젝트 지정은 그대로 남고, 다음 적재 때 컬렉션이 새로 만들어집니다.</p>
        </ConfirmModal>
      )}
      {collEdit && <CollectionForm store={collEdit.store} coll={collEdit.coll} onClose={() => setCollEdit(null)} onSaved={() => { setCollEdit(null); void stores.reload() }} />}
    </>
  )
}

function StoreForm({ initial, id, hasDefault, onClose, onSaved }: { initial: VectorStoreInput; id?: string; hasDefault: boolean; onClose: () => void; onSaved: () => void }) {
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
    <Modal title={id ? '연결 수정' : '연결 등록'} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name} onClick={() => void save()}>저장</button></>}>
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
            {d.uri.toLowerCase().startsWith('https://') && (
              <>
                <label className="field">CA 인증서 경로 (사설 CA일 때)<input value={d.tls_ca_path} onChange={(e) => set('tls_ca_path', e.target.value)} placeholder="/data/tls/ca.pem (서버 기준 경로)" /></label>
                <label className="field">인증서 서버 이름 (선택)<input value={d.tls_server_name} onChange={(e) => set('tls_server_name', e.target.value)} placeholder="인증서 SAN과 URI 호스트가 다를 때" /></label>
              </>
            )}
          </>
        )}
      </div>
      <label className="check" style={{ marginTop: 8 }} title={hasDefault ? '기본 컬렉션이 있는 연결은 비활성화할 수 없습니다' : undefined}>
        <input type="checkbox" checked={d.enabled} disabled={hasDefault} onChange={(e) => set('enabled', e.target.checked)} />활성
      </label>
      {!id && <div className="small muted" style={{ marginTop: 6 }}>저장한 뒤 "컬렉션 추가"로 적재할 컬렉션을 등록하세요.</div>}
    </Modal>
  )
}

function CollectionForm({ store, coll, onClose, onSaved }: { store: VectorStore; coll?: VectorCollection; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<CollectionInput>({ name: coll?.name ?? '', description: coll?.description ?? '', is_default: coll?.is_default ?? false })
  const [error, setError] = useState('')
  const save = async () => {
    setError('')
    try {
      if (coll) await vapi.updateCollection(coll.id, d)
      else await vapi.createCollection(store.id, d)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title={`${coll ? '컬렉션 수정' : '컬렉션 추가'} — ${store.name}`} onClose={onClose} footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={!d.name} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <div className="grid-2">
        <label className="field">컬렉션 이름
          <input className="mono" value={d.name} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} placeholder="예: cs_defense_rules" />
          <span className="small muted">영문자·밑줄로 시작, 영문자·숫자·밑줄만. 서버에 없으면 첫 적재 때 만들어집니다.</span>
        </label>
        <label className="field">설명 (선택)<input value={d.description} onChange={(e) => setD((x) => ({ ...x, description: e.target.value }))} placeholder="예: 방산규정집" /></label>
      </div>
      {coll && d.name !== coll.name && (
        <div className="banner warn small" style={{ marginTop: 8 }}>이름을 바꾸면 이후 적재는 새 이름의 컬렉션으로 갑니다. 기존 컬렉션의 데이터는 옮겨지지 않습니다.</div>
      )}
      <label className="check" style={{ marginTop: 8 }} title={coll?.is_default ? '다른 컬렉션을 기본으로 지정하면 해제됩니다' : undefined}>
        <input type="checkbox" checked={d.is_default} disabled={coll?.is_default || !store.enabled} onChange={(e) => setD((x) => ({ ...x, is_default: e.target.checked }))} />
        기본 컬렉션 (미분류 문서·컬렉션 미지정 프로젝트가 적재되는 곳, 전체에서 하나)
      </label>
    </Modal>
  )
}
