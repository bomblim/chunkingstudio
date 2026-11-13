import { useState } from 'react'
import { usersApi } from '../api'
import { Badge, ConfirmModal, ErrorBanner, Modal, fmtDate, useAsync } from '../components/ui'
import type { User } from '../types'

/** 관리 → 사용자: 화면 로그인 계정(아이디·비밀번호) 관리 */
export default function UsersPage({ me, onMeChange }: { me: User; onMeChange: (u: User) => void }) {
  const users = useAsync(() => usersApi.list(), [])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setError('')
    setNotice('')
    try { await fn(); if (msg) setNotice(msg); void users.reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>사용자</h1>
          <p>Studio 화면에 로그인할 계정을 관리합니다. 외부 시스템의 API 호출은 사용자 계정이 아니라 <b>API 안내 → API 키 관리</b>의 키를 씁니다.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>사용자 추가</button>
      </div>
      <ErrorBanner error={error || users.error} />
      {notice && <div className="banner info">{notice}</div>}
      <div className="card">
        <table className="list">
          <thead><tr><th>아이디</th><th>이름</th><th>상태</th><th>마지막 로그인</th><th>등록</th><th /></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td className="mono"><b>{u.username}</b>{u.id === me.id && <> <Badge kind="accent">나</Badge></>}</td>
                <td>{u.display_name}</td>
                <td>{u.enabled ? <Badge kind="ok">사용</Badge> : <Badge>중지</Badge>}</td>
                <td className="small">{u.last_login_at ? fmtDate(u.last_login_at) : <span className="muted">없음</span>}</td>
                <td className="small muted">{fmtDate(u.created_at)}</td>
                <td className="row">
                  <button className="sm" onClick={() => setEditing(u)}>수정</button>
                  {u.id !== me.id && (
                    <button className="sm" onClick={() => void act(() => usersApi.update(u.id, { enabled: !u.enabled }),
                      u.enabled ? `'${u.username}' 계정을 사용 중지했습니다(즉시 로그아웃됨).` : `'${u.username}' 계정을 다시 사용하도록 했습니다.`)}>
                      {u.enabled ? '사용 중지' : '사용'}
                    </button>
                  )}
                  {u.id !== me.id && <button className="sm danger" onClick={() => setDeleting(u)}>삭제</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <UserForm onClose={() => setCreating(false)} onSaved={(u) => { setCreating(false); setNotice(`'${u.username}' 사용자를 추가했습니다.`); void users.reload() }} />}
      {editing && <UserForm user={editing} isMe={editing.id === me.id} onClose={() => setEditing(null)}
        onSaved={(u) => { setEditing(null); if (u.id === me.id) onMeChange(u); setNotice(`'${u.username}' 정보를 저장했습니다.`); void users.reload() }} />}
      {deleting && (
        <ConfirmModal title="사용자 삭제" danger confirmLabel="삭제" onClose={() => setDeleting(null)}
          onConfirm={async () => { const u = deleting; setDeleting(null); await act(() => usersApi.remove(u.id), `'${u.username}' 사용자를 삭제했습니다.`) }}>
          <p style={{ marginTop: 0 }}><b>{deleting.display_name}</b> (<span className="mono">{deleting.username}</span>) 계정을 삭제할까요?</p>
          <p className="small muted" style={{ marginBottom: 0 }}>로그인 중이면 즉시 로그아웃되고, 되돌릴 수 없습니다. 잠시 막기만 하려면 "사용 중지"를 쓰세요.</p>
        </ConfirmModal>
      )}
    </>
  )
}

function UserForm({ user, isMe, onClose, onSaved }: { user?: User; isMe?: boolean; onClose: () => void; onSaved: (u: User) => void }) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [displayName, setDisplayName] = useState(user?.display_name ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const save = async () => {
    setError('')
    try {
      if (user) onSaved(await usersApi.update(user.id, { display_name: displayName, ...(password ? { password } : {}) }))
      else onSaved(await usersApi.create(username, password, displayName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title={user ? `사용자 수정 — ${user.username}` : '사용자 추가'} onClose={onClose}
      footer={<><button onClick={onClose}>취소</button><button className="primary" disabled={user ? false : !username || !password} onClick={() => void save()}>저장</button></>}>
      <ErrorBanner error={error} />
      <form className="col" onSubmit={(e) => { e.preventDefault(); void save() }}>
        {!user && <label className="field">아이디<input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="영문·숫자·._@- 3자 이상" autoComplete="off" /></label>}
        <label className="field">이름<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="화면에 표시할 이름 (비우면 아이디)" /></label>
        <label className="field">{user ? '새 비밀번호 (바꿀 때만 입력)' : '비밀번호 (8자 이상)'}
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {user && password && !isMe && <div className="small muted">비밀번호를 바꾸면 이 사용자는 다른 기기에서도 로그아웃됩니다.</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
