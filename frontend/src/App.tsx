import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import DocumentsPage from './pages/DocumentsPage'
import DocumentViewerPage from './pages/DocumentViewerPage'
import ModelsPage from './pages/ModelsPage'
import ParsersPage from './pages/ParsersPage'
import PlaygroundPage from './pages/PlaygroundPage'
import PromptsPage from './pages/PromptsPage'

const nav = (to: string, label: string) => (
  <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>{label}</NavLink>
)

export default function App() {
  return (
    <div className="app">
      <nav className="sidebar" aria-label="주 메뉴">
        <div className="brand">Chunking Studio<small>RAG 청킹 실험·검증</small></div>
        <div className="nav-section">실험</div>
        {nav('/documents', '문서')}
        {nav('/playground', 'Prompt Playground')}
        {nav('/prompts', '프롬프트')}
        <div className="nav-section">관리</div>
        {nav('/parsers', 'Parser Registry')}
        {nav('/models', '모델 레지스트리')}
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/documents" replace />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentViewerPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/parsers" element={<ParsersPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="*" element={<div className="empty">페이지를 찾을 수 없습니다</div>} />
        </Routes>
      </main>
    </div>
  )
}
