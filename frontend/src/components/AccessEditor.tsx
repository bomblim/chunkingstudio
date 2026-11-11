import { useState } from 'react'
import type { ProjectAccess, ProjectMeta } from '../types'
import { Badge } from './ui'

type MetaType = 'string' | 'number' | 'boolean' | 'list'
interface Row { key: string; type: MetaType; value: string }

const typeOf = (v: ProjectMeta[string]): MetaType =>
  Array.isArray(v) ? 'list' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string'
const toText = (v: ProjectMeta[string]) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v))

export function metaToRows(meta: ProjectMeta | null): Row[] {
  return Object.entries(meta ?? {}).map(([key, v]) => ({ key, type: typeOf(v), value: toText(v) }))
}

export function rowsToMeta(rows: Row[]): { meta: ProjectMeta | null; error: string } {
  const out: ProjectMeta = {}
  for (const r of rows) {
    const key = r.key.trim()
    if (!key) continue
    if (key in out) return { meta: null, error: `메타데이터 키가 중복됩니다: ${key}` }
    if (r.type === 'number') {
      const n = Number(r.value)
      if (r.value.trim() === '' || Number.isNaN(n)) return { meta: null, error: `'${key}' 값이 숫자가 아닙니다` }
      out[key] = n
    } else if (r.type === 'boolean') out[key] = r.value === 'true'
    else if (r.type === 'list') out[key] = r.value.split(',').map((s) => s.trim()).filter(Boolean)
    else out[key] = r.value
  }
  return { meta: Object.keys(out).length ? out : null, error: '' }
}

/** 프로젝트 메타데이터 키-값 편집. 상위에서 물려받는 값은 읽기 전용으로 함께 보여준다. */
export function MetaEditor({ rows, onChange, inherited }: {
  rows: Row[]
  onChange: (rows: Row[]) => void
  inherited?: { meta: ProjectMeta; names: Record<string, string> }
}) {
  const own = new Set(rows.map((r) => r.key.trim()))
  const inheritedOnly = Object.entries(inherited?.meta ?? {}).filter(([k]) => !own.has(k))
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="col" style={{ gap: 6 }}>
      {inheritedOnly.length > 0 && (
        <div className="small muted">
          상속: {inheritedOnly.map(([k, v]) => <span key={k} className="badge" style={{ marginRight: 4 }} title={`${inherited?.names[k] ?? ''}에서 상속`}>{k}={toText(v)}</span>)}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <input aria-label="메타데이터 키" placeholder="키 (예: 보안등급)" value={r.key} onChange={(e) => set(i, { key: e.target.value })} style={{ width: 160 }} />
          <select aria-label="값 형식" value={r.type} onChange={(e) => set(i, { type: e.target.value as MetaType, value: e.target.value === 'boolean' ? 'true' : r.value })}>
            <option value="string">문자열</option><option value="number">숫자</option><option value="boolean">예/아니오</option><option value="list">목록(쉼표)</option>
          </select>
          {r.type === 'boolean' ? (
            <select aria-label="메타데이터 값" value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="grow">
              <option value="true">예 (true)</option><option value="false">아니오 (false)</option>
            </select>
          ) : (
            <input aria-label="메타데이터 값" className="grow" placeholder={r.type === 'list' ? '예: 육군, 해군' : '값'} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          )}
          {inherited?.meta && r.key.trim() in inherited.meta && <Badge kind="warn" title="상위 값을 덮어씀">재정의</Badge>}
          <button className="sm ghost" aria-label="삭제" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div><button className="sm" onClick={() => onChange([...rows, { key: '', type: 'string', value: '' }])}>+ 항목 추가</button></div>
    </div>
  )
}

const PRINCIPAL_RE = /^[^\s"'\\[\],]{1,200}$/

/** 권한 주체(principal) 목록 편집 */
export function PermissionEditor({ value, onChange, mode, onModeChange, effective }: {
  value: string[]
  onChange: (v: string[]) => void
  mode: 'inherit' | 'override'
  onModeChange: (m: 'inherit' | 'override') => void
  effective?: ProjectAccess
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const add = () => {
    const items = input.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    const bad = items.find((x) => !PRINCIPAL_RE.test(x))
    if (bad) { setError(`형식 오류: ${bad} (따옴표·대괄호·역슬래시 불가)`); return }
    onChange([...new Set([...value, ...items])].sort())
    setInput('')
    setError('')
  }
  const inherited = effective && mode === 'inherit'
    ? effective.permissions.filter((p) => !value.includes(p) && effective.permission_source_names[p])
    : []
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <label className="check small"><input type="radio" checked={mode === 'inherit'} onChange={() => onModeChange('inherit')} />상위 권한 + 이 목록</label>
        <label className="check small"><input type="radio" checked={mode === 'override'} onChange={() => onModeChange('override')} />이 목록으로 재정의 (상위 권한 무시)</label>
      </div>
      <div className="row" style={{ gap: 4 }}>
        {inherited.map((p) => <span key={p} className="badge" title={`${effective?.permission_source_names[p]}에서 상속`}>{p} <span className="muted">(상속)</span></span>)}
        {value.map((p) => (
          <span key={p} className="badge accent">{p} <button className="ghost sm" style={{ padding: 0 }} aria-label={`${p} 삭제`} onClick={() => onChange(value.filter((x) => x !== p))}>✕</button></span>
        ))}
        {!value.length && !inherited.length && <span className="small muted">권한 없음 = 제한 없음(전체 공개)</span>}
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="grow mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="group:인사팀, user:hong, role:admin"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} aria-label="권한 주체 추가" />
        <button className="sm" onClick={add} disabled={!input.trim()}>추가</button>
      </div>
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}
