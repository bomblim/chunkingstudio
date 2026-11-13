import { useState } from 'react'
import { authApi } from '../api'
import { LogoIcon } from '../components/Icons'
import { ErrorBanner } from '../components/ui'
import type { User } from '../types'

/** 로그인 / 최초 관리자 만들기(사용자가 하나도 없을 때) */
export default function LoginPage({ setup, onDone }: { setup: boolean; onDone: (u: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    if (setup && password !== again) { setError('비밀번호가 서로 다릅니다'); return }
    setBusy(true)
    try {
      onDone(setup ? await authApi.setup(username, password, displayName) : await authApi.login(username, password))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <LogoIcon size={30} />
          <h1 style={{ margin: 0 }}>Chunking Studio</h1>
        </div>
        {setup ? (
          <p className="small muted" style={{ marginTop: 0 }}>
            등록된 사용자가 없습니다. <b>최초 관리자 계정</b>을 만드세요. 이후 사용자는 <b>관리 → 사용자</b>에서 추가합니다.
          </p>
        ) : <p className="small muted" style={{ marginTop: 0 }}>아이디와 비밀번호로 로그인하세요.</p>}
        <ErrorBanner error={error} />
        <label className="field">아이디
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={setup ? '영문·숫자·._@- 3자 이상' : undefined} />
        </label>
        {setup && <label className="field">이름 (선택)<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="화면에 표시할 이름" /></label>}
        <label className="field">비밀번호
          <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={setup ? '8자 이상' : undefined} />
        </label>
        {setup && <label className="field">비밀번호 확인<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>}
        <button className="primary" type="submit" disabled={busy || !username || !password || (setup && !again)} style={{ marginTop: 8, width: '100%' }}>
          {busy ? '확인 중…' : setup ? '관리자 만들고 시작' : '로그인'}
        </button>
      </form>
    </div>
  )
}
