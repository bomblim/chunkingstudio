import type { DocElement } from '../types'
import { TYPE_COLORS } from '../colors'

/** PV-04: 표 렌더링 (셀 구조 → 표, 없으면 markdown 원문) */
export function TableView({ el }: { el: DocElement }) {
  const cells = el.table?.cells ?? []
  if (!cells.length) return <pre>{el.table?.markdown ?? el.table?.html ?? el.text}</pre>
  const rows = Math.max(...cells.map((c) => c.row)) + 1
  const grid: (typeof cells)[] = Array.from({ length: rows }, () => [])
  for (const c of cells) grid[c.row].push(c)
  return (
    <table className="md-table">
      <tbody>
        {grid.map((r, i) => (
          <tr key={i}>{r.sort((a, b) => a.col - b.col).map((c) => <td key={c.col} rowSpan={c.rowspan} colSpan={c.colspan}>{c.text}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

export function TypeTag({ type }: { type: string }) {
  return <span className="badge" style={{ background: `${TYPE_COLORS[type] ?? '#888'}22`, color: TYPE_COLORS[type] ?? '#888' }}>{type}</span>
}

/** PV-03: Element 상세 */
export function ElementDetail({ el }: { el: DocElement }) {
  return (
    <div className="col">
      <div className="row"><b className="mono">{el.element_id}</b><TypeTag type={el.type} />{el.level ? <span className="badge">L{el.level}</span> : null}</div>
      <dl className="kv">
        <dt>페이지</dt><dd>{el.page ?? '-'}</dd>
        <dt>읽기 순서</dt><dd>{el.reading_order}</dd>
        <dt>부모</dt><dd className="mono">{el.parent_id ?? '-'}</dd>
        <dt>신뢰도</dt><dd>{el.confidence ?? '-'}</dd>
        <dt>bbox</dt><dd className="mono">{el.bbox ? `${el.bbox.x0.toFixed(1)}, ${el.bbox.y0.toFixed(1)}, ${el.bbox.x1.toFixed(1)}, ${el.bbox.y1.toFixed(1)}` : '-'}</dd>
      </dl>
      {el.type === 'table' ? <TableView el={el} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{el.text}</div>}
      <details>
        <summary className="small muted">Raw JSON</summary>
        <pre className="code-box">{JSON.stringify(el, null, 2)}</pre>
      </details>
    </div>
  )
}
