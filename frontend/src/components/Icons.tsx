import type { ReactNode } from 'react'

/** 선 아이콘(24 그리드, currentColor). 메뉴·로고용 */
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** 로고: favicon과 같은 파일(public/favicon.svg)을 그대로 쓴다 */
export function LogoIcon({ size = 22 }: { size?: number }) {
  return <img src="/favicon.svg" width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }} />
}

export const icons = {
  documents: <Svg><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Svg>,
  chunking: <Svg><rect x="4" y="4" width="16" height="5" rx="1.5" /><rect x="4" y="11" width="10" height="4" rx="1.5" /><rect x="4" y="17" width="13" height="3" rx="1.2" /></Svg>,
  api: <Svg><path d="m8 8-4 4 4 4M16 8l4 4-4 4" /><path d="m13.5 5-3 14" /></Svg>,
  query: <Svg><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>,
  parser: <Svg><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="m10 12-2 2 2 2M14 12l2 2-2 2" /></Svg>,
  model: <Svg><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></Svg>,
  prompt: <Svg><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><path d="M9 10h6M9 13.5h4" /></Svg>,
  embedding: <Svg><circle cx="6" cy="18" r="1.6" /><path d="M6 18 18 6M18 6h-5M18 6v5" /><path d="M6 18l5-1.5" /></Svg>,
  rerank: <Svg><path d="M7 4v16M4 17l3 3 3-3" /><path d="M13 6h7M13 11h5M13 16h3" /></Svg>,
  store: <Svg><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></Svg>,
  collapse: <Svg size={16}><path d="m15 6-6 6 6 6" /></Svg>,
  expand: <Svg size={16}><path d="m9 6 6 6-6 6" /></Svg>,
}
