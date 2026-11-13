import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { authApi, UNAUTHORIZED_EVENT } from './api'
import { LogoIcon, icons } from './components/Icons'
import { DialogHost, ErrorBanner, Modal } from './components/ui'
import ApiGuidePage from './pages/ApiGuidePage'
import DocumentsPage from './pages/DocumentsPage'
import DocumentViewerPage from './pages/DocumentViewerPage'
import EmbeddingModelsPage from './pages/EmbeddingModelsPage'
import LoginPage from './pages/LoginPage'
import RerankModelsPage from './pages/RerankModelsPage'
import StoragePage from './pages/StoragePage'
import IndexesPage from './pages/IndexesPage'
import ModelsPage from './pages/ModelsPage'
import ParsersPage from './pages/ParsersPage'
import PlaygroundPage from './pages/PlaygroundPage'
import PromptsPage from './pages/PromptsPage'
import UsersPage from './pages/UsersPage'
import VectorStoresPage from './pages/VectorStoresPage'
import type { User } from './types'

const COLLAPSE_KEY = 'cs.sidebar.collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}

const nav = (to: string, label: string, icon: ReactNode) => (
  <NavLink to={to} title={label} aria-label={label} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
    <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>
  </NavLink>
)

/** 로그인 상태 확인 → 로그인(또는 최초 관리자 만들기) 화면 / 본 화면 */
export default function App() {
  const [auth, setAuth] = useState<{ user: User | null; setup_required: boolean } | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    authApi.status().then(setAuth, (e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    // 세션이 끊기면(만료·다른 곳에서 로그아웃·계정 중지) 로그인 화면으로
    const onUnauthorized = () => setAuth((a) => (a?.user ? { user: null, setup_required: false } : a))
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  if (!auth) return <div className="login-wrap">{error ? <ErrorBanner error={error} /> : <span className="muted">불러오는 중…</span>}</div>
  if (!auth.user) return <LoginPage setup={auth.setup_required} onDone={(user) => setAuth({ user, setup_required: false })} />
  return <Shell user={auth.user} onUserChange={(user) => setAuth({ user, setup_required: false })}
    onLogout={async () => { await authApi.logout().catch(() => undefined); setAuth({ user: null, setup_required: false }) }} />
}

function Shell({ user, onUserChange, onLogout }: { user: User; onUserChange: (u: User) => void; onLogout: () => void }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [pwOpen, setPwOpen] = useState(false)
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* 저장 불가(사생활 보호 모드 등)는 무시 */ }
    return !c
  })

  return (
    <div className={`app ${collapsed ? 'nav-collapsed' : ''}`}>
      <DialogHost />
      <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="주 메뉴">
        <div className="brand">
          <LogoIcon />
          <span className="brand-name">Chunking Studio</span>
          <button className="ghost sm nav-toggle" onClick={toggle} aria-expanded={!collapsed}
            aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'} title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}>
            {collapsed ? icons.expand : icons.collapse}
          </button>
        </div>
        <div className="nav-section"><span>파이프라인</span></div>
        {nav('/documents', '문서 및 파싱', icons.documents)}
        {nav('/playground', '청킹', icons.chunking)}
        {nav('/storage', '저장소', icons.storage)}
        {nav('/api-guide', 'API 안내', icons.api)}
        <div className="nav-section"><span>검색</span></div>
        {nav('/indexes', '질의 테스트', icons.query)}
        <div className="nav-section"><span>관리</span></div>
        {nav('/parsers', '문서 파서', icons.parser)}
        {nav('/models', '청킹 모델', icons.model)}
        {nav('/prompts', '청킹 프롬프트', icons.prompt)}
        {nav('/embedding-models', '임베딩 모델', icons.embedding)}
        {nav('/rerank-models', '리랭크 모델', icons.rerank)}
        {nav('/vector-stores', '벡터 저장소', icons.store)}
        {nav('/users', '사용자', icons.users)}
        <div className="nav-user">
          <button className="nav-link nav-user-name" onClick={() => setPwOpen(true)} title={`${user.display_name} (${user.username}) — 비밀번호 변경`}>
            <span className="nav-icon">{icons.user}</span><span className="nav-label">{user.display_name}</span>
          </button>
          <button className="nav-link" onClick={onLogout} title="로그아웃" aria-label="로그아웃">
            <span className="nav-icon">{icons.logout}</span><span className="nav-label">로그아웃</span>
          </button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/documents" replace />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentViewerPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/api-guide" element={<ApiGuidePage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/parsers" element={<ParsersPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/indexes" element={<IndexesPage />} />
          <Route path="/embedding-models" element={<EmbeddingModelsPage />} />
          <Route path="/rerank-models" element={<RerankModelsPage />} />
          <Route path="/vector-stores" element={<VectorStoresPage />} />
          <Route path="/users" element={<UsersPage me={user} onMeChange={onUserChange} />} />
          <Route path="*" element={<div className="empty">페이지를 찾을 수 없습니다</div>} />
        </Routes>
      </main>
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  )
}

/** 내 비밀번호 변경 */
function PasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const submit = async () => {
    setError('')
    if (next !== again) { setError('새 비밀번호가 서로 다릅니다'); return }
    try {
      await authApi.changePassword(cur, next)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal title="비밀번호 변경" onClose={onClose} footer={done ? <button className="primary" onClick={onClose}>닫기</button> : <><button onClick={onClose}>취소</button><button className="primary" disabled={!cur || !next || !again} onClick={() => void submit()}>변경</button></>}>
      <ErrorBanner error={error} />
      {done ? <div className="banner info">비밀번호를 바꿨습니다.</div> : (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <label className="field">현재 비밀번호<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
          <label className="field">새 비밀번호 (8자 이상)<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
          <label className="field">새 비밀번호 확인<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  )
}
