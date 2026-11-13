export type ElementType =
  | 'title' | 'heading' | 'paragraph' | 'list' | 'table' | 'figure' | 'caption'
  | 'header' | 'footer' | 'footnote' | 'code' | 'formula' | 'other'

export interface BBox { x0: number; y0: number; x1: number; y1: number }

export interface TableCell { row: number; col: number; rowspan: number; colspan: number; text: string }

export interface DocElement {
  element_id: string
  type: ElementType
  text: string
  page: number | null
  bbox: BBox | null
  reading_order: number
  level: number | null
  parent_id: string | null
  confidence: number | null
  table: { cells: TableCell[]; html: string | null; markdown: string | null } | null
  figure: { image_ref: string | null; caption: string | null; vlm_description: string | null } | null
  extra: Record<string, unknown>
}

export interface DocPage { page_no: number; width: number | null; height: number | null; image_ref: string | null }

export interface StandardDocument {
  doc_id: string | null
  source_file: string | null
  parser_id: string | null
  parser_version: string | null
  parsed_at: string | null
  pages: DocPage[]
  elements: DocElement[]
}

export interface DocStats {
  element_count: number
  page_count: number
  char_count: number
  type_counts: Record<string, number>
  chars_per_page: Record<string, number>
  empty_pages: number[]
  low_confidence_count: number
  table_count: number
  figure_count: number
  has_bbox: boolean
}

export interface DocumentSummary {
  id: number
  title: string
  parser_id: number | null
  parser_name: string
  parser_version: string
  file_hash: string
  source: 'runtime' | 'test'
  doc_type: string
  revision: number
  project_id: number | null
  project_path?: string[]
  last_run?: { id: number; status: string; method: string; chunk_count: number | null; ok: boolean | null; created_at: string }
  stats: DocStats
  created_at: string
}

export interface DocumentDetail extends DocumentSummary {
  content: StandardDocument
  has_source_file: boolean
  source_kind: 'pdf' | 'image' | ''
  source_file_path: string
  revisions: { id: number; revision: number; created_at: string }[]
}

export interface Parser {
  id: number
  name: string
  description: string
  version: string
  owner: string
  input_formats: string[]
  adapter: string
  adapter_config: Record<string, unknown>
  param_schema: { name: string; type: string; default?: unknown; description?: string }[]
  api_url: string
  api_auth_header: string
  api_auth_env: string
  api_timeout_sec: number
  api_mode: 'sync' | 'async' | 'upstage'
  api_config: UpstageConfig & Record<string, unknown>
  api_status_url: string
  api_file_field: string
  max_file_mb: number
  enabled: boolean
  last_health: { ok?: boolean; message?: string; elapsed_ms?: number; checked_at?: string }
  monitor: { test_calls: number; failed: number; error_rate: number | null; avg_elapsed_ms: number | null }
  test_callable: boolean
}

export interface ParseJob {
  id: number
  parser_id: number
  parser_name?: string
  file_name: string
  status: 'queued' | 'parsing' | 'converting' | 'done' | 'failed'
  error_kind: string
  error: string
  elapsed_ms: number
  document_id: number | null
  created_at: string
}

export interface LLMModel {
  id: number
  name: string
  provider: 'openai_compatible' | 'anthropic' | 'mock'
  engine: string
  base_url: string
  model_id: string
  api_key_env: string
  is_external: boolean
  context_length: number
  max_output_tokens: number
  structured_output: string
  input_price_per_1m: number
  output_price_per_1m: number
  extra_params: Record<string, unknown>
  enabled: boolean
  blocked: boolean
  strategy_chain: string[]
  last_health: { ok?: boolean; message?: string; latency_ms?: number; strategy?: string; checked_at?: string }
}

export interface PromptVersion {
  id: number
  prompt_id: number
  version: number
  system_template: string
  user_template: string
  few_shots: { input: string; output: unknown }[]
  output_schema: Record<string, unknown>
  note: string
  status: 'draft' | 'testing' | 'approved' | 'production'
  created_at: string
}

export interface Prompt {
  id: number
  name: string
  description: string
  doc_types: string[]
  forked_from_version_id: number | null
  versions: PromptVersion[]
  latest_version: number | null
  production_version_id: number | null
}

export interface ChunkSettings {
  max_tokens: number
  min_tokens: number
  window_tokens: number | null
  exclude_types: string[]
  scope: { mode: 'all' | 'section' | 'pages'; section_id?: string; page_from?: number; page_to?: number }
  auto_fix: boolean
  retries: number
  doc_type: string
}

export interface Chunk {
  chunk_id: string
  start_id: string
  end_id: string
  element_ids: string[]
  title: string
  summary: string
  keywords: string[]
  reason: string
  text: string
  tokens: number
  pages: number[]
  section_path: string
  source: 'llm' | 'fallback' | 'rule'
  window: number | null
}

export interface Issue {
  level: 'error' | 'warning'
  code: string
  message: string
  chunk_id?: string
  window?: number
  element_ids?: string[]
}

export interface WindowAttempt {
  kind: 'call' | 'repair'
  attempt: number
  ok: boolean
  error?: string
  strategy?: string
  latency_ms?: number
  input_tokens?: number | null
  output_tokens?: number | null
  request?: Record<string, unknown>
  raw?: string
}

export interface WindowLog {
  index: number
  first_id: string
  last_id: string
  element_count: number
  tokens: number
  system: string
  user: string
  attempts: WindowAttempt[]
  issues: Issue[]
  warnings: string[]
  fallback: boolean
  raw_response: string
  strategy?: string
  stitch?: string
  parsed_chunks: Record<string, unknown>[]
}

export interface RunSummary {
  id: number
  document_id: number
  prompt_version_id: number | null
  model_id: number | null
  method: 'llm' | 'rule_structure'
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: { phase?: string; window?: number; estimated_windows?: number; elements_done?: number; elements_total?: number }
  validation: { ok?: boolean; error_count?: number; warning_count?: number; counts?: Record<string, number>; issues?: Issue[]; coverage?: { total: number; covered: number } }
  totals: {
    windows?: number; llm_calls?: number; fallback_windows?: number; input_tokens?: number; output_tokens?: number
    cost_usd?: number; latency_ms?: number; chunk_count?: number; avg_tokens?: number; min_tokens?: number
    max_tokens?: number; excluded_ids?: string[]
  }
  settings: ChunkSettings
  params: Record<string, unknown>
  error: string
  model_name: string
  prompt_label: string
  prompt_id: number | null
  created_at: string
}

export interface RunDetail extends RunSummary {
  chunks: Chunk[]
  windows: WindowLog[]
  feedback: Record<string, { value: 'up' | 'down'; comment: string }>
  snapshot: Record<string, unknown>
}

export interface PromptPreview {
  system: string
  user: string
  unknown_variables: string[]
  window_budget: number
  first_window_elements: number
  total_elements: number
  estimated_windows: number
  estimated_input_tokens: number
}

export interface EmbeddingModel {
  id: number
  name: string
  provider: 'openai_compatible' | 'mock'
  engine: string
  base_url: string
  model_id: string
  api_key_env: string
  is_external: boolean
  dimension: number | null
  max_input_tokens: number
  query_prefix: string
  document_prefix: string
  batch_size: number
  extra_params: Record<string, unknown>
  enabled: boolean
  blocked: boolean
  last_health: { ok?: boolean; message?: string; dimension?: number; latency_ms?: number; checked_at?: string }
}

export interface VectorStore {
  id: number
  name: string
  kind: 'milvus' | 'memory'
  uri: string
  token_env: string
  db_name: string
  tls_ca_path: string
  tls_server_name: string
  enabled: boolean
  last_health: { ok?: boolean; message?: string; server_version?: string; collections?: string[]; latency_ms?: number; checked_at?: string }
}

export interface VectorIndex {
  id: number
  name: string
  store_id: number
  store_name: string
  store_kind: string
  collection: string
  embedding_model_id: number
  embedding_model_name: string
  embed_template: string
  metric: string
  dimension: number | null
  run_ids: number[]
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: { phase?: string; done?: number; total?: number }
  chunk_count: number
  warnings: string[]
  stats: {
    last_run_id?: number; inserted?: number; embed_ms?: number; insert_ms?: number; embed_tokens?: number | null
    batch?: { total: number; done: number; succeeded: number; failed: { document_id: number; title: string; error: string }[]; current: string | null }
  }
  error: string
  created_at: string
}

export interface SearchHit {
  id: string
  score: number
  chunk_id: string
  run_id: number
  document_id: number
  title: string
  section_path: string
  text: string
  embed_text: string
  metadata: {
    document_title?: string; element_ids?: string[]; pages?: number[]; tokens?: number; summary?: string
    keywords?: string[]; prompt_version?: number | null; llm_model?: string | null; method?: string; text_truncated?: boolean
    project_id?: number | null; project_path?: string[]; project_meta?: Record<string, unknown>; permissions?: string[]; public?: boolean
  }
}

export interface QueryResult {
  query: string
  embed_ms: number
  search_ms: number
  metric: string
  warnings: string[]
  principals: string[] | null
  applied_filter: string | null
  hits: SearchHit[]
}

export interface UpstageConfig {
  project_id?: string
  model?: string
  config_id?: string
  purpose?: string
  include?: string
  poll_interval_sec?: number
  extra_body?: Record<string, unknown>
}

export interface ProjectProfile {
  method: 'llm' | 'rule_structure' | null
  prompt_id: number | null
  prompt_version_id: number | null
  model_id: number | null
  params: Record<string, unknown> | null
  settings: Partial<ChunkSettings> | null
  doc_type: string | null
}

export type ProjectMeta = Record<string, string | number | boolean | null | (string | number | boolean)[]>

export interface ProjectAccess {
  meta: ProjectMeta
  meta_sources: Record<string, number>
  meta_source_names: Record<string, string>
  permissions: string[]
  permission_sources: Record<string, number>
  permission_source_names: Record<string, string>
  public: boolean
}

export interface Project extends ProjectProfile {
  id: number
  name: string
  description: string
  meta: ProjectMeta | null
  permissions: string[] | null
  permission_mode: 'inherit' | 'override' | null
  access: ProjectAccess
  parent_id: number | null
  sort_order: number
  path: string[]
  doc_count: number
  total_doc_count: number
  effective: ProjectProfile & {
    sources: Record<string, number>
    source_names: Record<string, string>
    resolved_prompt_version_id: number | null
    resolved_prompt_label: string | null
    model_name: string | null
  }
}

export interface ProjectTree {
  projects: Project[]
  unassigned_count: number
  total_count: number
}

/** 프로젝트 일괄 적재 계획: 문서마다 가장 최근에 성공한 청킹 실행 */
export interface IndexPlan {
  items: { document_id: number; title: string; run_id: number; method: string; chunk_count: number | null; created_at: string; project_path: string[]; note: string }[]
  skipped: { document_id: number; title: string; reason: string }[]
  default_collection: string
}
