import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  variables: Record<string, string>
  rows?: number
  label?: string
}

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** PM-01: {{변수}} 하이라이트 + `{{` 입력 시 자동완성 */
export function TemplateEditor({ value, onChange, variables, rows = 10, label }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const [ac, setAc] = useState<{ query: string; start: number; top: number; left: number } | null>(null)
  const [active, setActive] = useState(0)

  const highlighted = useMemo(() => {
    const out: (string | { name: string; raw: string })[] = []
    let last = 0
    for (const m of value.matchAll(VAR_RE)) {
      out.push(value.slice(last, m.index))
      out.push({ name: m[1], raw: m[0] })
      last = m.index! + m[0].length
    }
    out.push(value.slice(last))
    return out
  }, [value])

  const options = ac ? Object.keys(variables).filter((v) => v.startsWith(ac.query)) : []

  const updateAc = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const m = /\{\{\s*([a-zA-Z_]*)$/.exec(before)
    if (!m || !taRef.current) {
      setAc(null)
      return
    }
    const ta = taRef.current
    const lines = before.split('\n')
    const lineHeight = 19.4
    const top = Math.min(lines.length * lineHeight + 8 - ta.scrollTop, ta.clientHeight)
    setAc({ query: m[1], start: caret - m[0].length, top, left: 12 })
    setActive(0)
  }

  const insert = (name: string) => {
    if (!ac || !taRef.current) return
    const caret = taRef.current.selectionStart
    const next = value.slice(0, ac.start) + `{{${name}}}` + value.slice(caret)
    onChange(next)
    setAc(null)
    requestAnimationFrame(() => {
      const pos = ac.start + name.length + 4
      taRef.current?.setSelectionRange(pos, pos)
      taRef.current?.focus()
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ac || !options.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % options.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(options[active]) }
    else if (e.key === 'Escape') setAc(null)
  }

  return (
    <div className="col" style={{ gap: 4 }}>
      {label && <span className="small muted">{label}</span>}
      <div className="tpl">
        <pre ref={preRef} aria-hidden>
          {highlighted.map((part, i) =>
            typeof part === 'string' ? <Fragment key={i}>{part}</Fragment> : (
              <mark key={i} className={part.name in variables ? '' : 'unknown'}>{part.raw}</mark>
            ),
          )}
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          rows={rows}
          value={value}
          spellCheck={false}
          onChange={(e) => { onChange(e.target.value); updateAc(e.target.value, e.target.selectionStart) }}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => setAc(null), 150)}
          onScroll={(e) => { if (preRef.current) preRef.current.scrollTop = e.currentTarget.scrollTop }}
        />
        {ac && options.length > 0 && (
          <div className="ac" style={{ top: ac.top + 4, left: ac.left }}>
            {options.map((o, i) => (
              <div key={o} className={i === active ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); insert(o) }}>
                <b>{`{{${o}}}`}</b> <span className="muted small">{variables[o]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** PM-04: 줄 단위 diff (LCS) */
export function LineDiff({ a, b }: { a: string; b: string }) {
  const rows = useMemo(() => diffLines(a.split('\n'), b.split('\n')), [a, b])
  return (
    <div className="diff">
      {rows.map((r, i) => (
        <div key={i} className={r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}>{r.t === ' ' ? '  ' : `${r.t} `}{r.s || ' '}</div>
      ))}
    </div>
  )
}

function diffLines(a: string[], b: string[]) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: ' ' | '+' | '-'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] })
    else out.push({ t: '+', s: b[j++] })
  }
  while (i < n) out.push({ t: '-', s: a[i++] })
  while (j < m) out.push({ t: '+', s: b[j++] })
  return out
}
