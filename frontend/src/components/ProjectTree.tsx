import { useMemo, useState } from 'react'
import type { Project, ProjectTree as Tree } from '../types'

/** 선택 값: 'all'(전체) | 'unassigned'(미분류) | 프로젝트 id */
export type ProjectSelection = 'all' | 'unassigned' | string

/** 선택 값이 실제 프로젝트 id인지 */
export const isProjectId = (v: ProjectSelection | null | undefined): v is string => !!v && v !== 'all' && v !== 'unassigned'

interface Node { p: Project; children: Node[] }

export function buildTree(projects: Project[]): Node[] {
  const byParent = new Map<string | null, Project[]>()
  for (const p of projects) byParent.set(p.parent_id, [...(byParent.get(p.parent_id) ?? []), p])
  const make = (parent: string | null, seen: Set<string>): Node[] =>
    (byParent.get(parent) ?? [])
      .filter((p) => !seen.has(p.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ko'))
      .map((p) => ({ p, children: make(p.id, new Set([...seen, p.id])) }))
  return make(null, new Set())
}

/** 하위 전체 id (자기 포함) */
export function descendantIds(projects: Project[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const p of projects) if (p.parent_id !== null && out.has(p.parent_id) && !out.has(p.id)) { out.add(p.id); grew = true }
  }
  return out
}

/** 프로젝트를 들여쓰기된 select option 목록으로 */
export function projectOptions(projects: Project[], exclude?: Set<string>) {
  const out: { id: string; label: string }[] = []
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (exclude?.has(n.p.id)) continue
      out.push({ id: n.p.id, label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${n.p.name}` })
      walk(n.children, depth + 1)
    }
  }
  walk(buildTree(projects), 0)
  return out
}

export function ProjectTreeView({ tree, value, onChange, onAddChild }: {
  tree: Tree
  value: ProjectSelection
  onChange: (v: ProjectSelection) => void
  onAddChild: (parentId: string | null) => void
}) {
  const roots = useMemo(() => buildTree(tree.projects), [tree.projects])
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  const row = (label: React.ReactNode, count: number, sel: ProjectSelection, depth = 0, toggle?: React.ReactNode) => (
    <div className={`ptree-row ${value === sel ? 'selected' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => onChange(sel)}
      role="treeitem" aria-selected={value === sel}>
      <span className="ptree-toggle">{toggle}</span>
      <span className="grow ptree-label">{label}</span>
      <span className="ptree-count">{count}</span>
    </div>
  )

  const render = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      const isClosed = closed[n.p.id]
      const hasProfile = n.p.method || n.p.prompt_id || n.p.model_id || n.p.settings
      return (
        <div key={n.p.id}>
          {row(
            <>{n.p.name}{hasProfile ? <span className="ptree-dot" title="이 프로젝트에 청킹 프로파일이 지정됨">●</span> : null}</>,
            n.p.total_doc_count, n.p.id, depth,
            n.children.length ? (
              <button className="ghost sm" aria-label={isClosed ? '펼치기' : '접기'} onClick={(e) => { e.stopPropagation(); setClosed((c) => ({ ...c, [n.p.id]: !isClosed })) }}>{isClosed ? '▸' : '▾'}</button>
            ) : null,
          )}
          {!isClosed && render(n.children, depth + 1)}
        </div>
      )
    })

  return (
    <div className="ptree" role="tree" aria-label="프로젝트">
      {row(<b>전체 문서</b>, tree.total_count, 'all')}
      {render(roots, 0)}
      {row(<span className="muted">미분류</span>, tree.unassigned_count, 'unassigned')}
      <button className="sm" style={{ marginTop: 8, width: '100%' }} onClick={() => onAddChild(isProjectId(value) ? value : null)}>
        + {isProjectId(value) ? '하위 프로젝트' : '프로젝트'} 추가
      </button>
    </div>
  )
}
