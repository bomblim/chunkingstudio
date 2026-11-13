import { useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { LogoIcon, icons } from './components/Icons'
import ApiGuidePage from './pages/ApiGuidePage'
import DocumentsPage from './pages/DocumentsPage'
import DocumentViewerPage from './pages/DocumentViewerPage'
import EmbeddingModelsPage from './pages/EmbeddingModelsPage'
import RerankModelsPage from './pages/RerankModelsPage'
import IndexesPage from './pages/IndexesPage'
import ModelsPage from './pages/ModelsPage'
import ParsersPage from './pages/ParsersPage'
import PlaygroundPage from './pages/PlaygroundPage'
import PromptsPage from './pages/PromptsPage'
import VectorStoresPage from './pages/VectorStoresPage'

const COLLAPSE_KEY = 'cs.sidebar.collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}

const nav = (to: string, label: string, icon: ReactNode) => (
  <NavLink to={to} title={label} aria-label={label} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
    <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>
  </NavLink>
)

export default function App() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* 저장 불가(사생활 보호 모드 등)는 무시 */ }
    return !c
  })

  return (
    <div className={`app ${collapsed ? 'nav-collapsed' : ''}`}>
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
        {nav('/documents', '문서', icons.documents)}
        {nav('/playground', '청킹', icons.chunking)}
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
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/documents" replace />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentViewerPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/api-guide" element={<ApiGuidePage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/parsers" element={<ParsersPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/indexes" element={<IndexesPage />} />
          <Route path="/embedding-models" element={<EmbeddingModelsPage />} />
          <Route path="/rerank-models" element={<RerankModelsPage />} />
          <Route path="/vector-stores" element={<VectorStoresPage />} />
          <Route path="*" element={<div className="empty">페이지를 찾을 수 없습니다</div>} />
        </Routes>
      </main>
    </div>
  )
}
