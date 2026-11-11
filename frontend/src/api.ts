import type {
  ChunkSettings, DocumentDetail, DocumentSummary, EmbeddingModel, LLMModel, ParseJob, Parser, Prompt, PromptPreview,
  Project, ProjectTree, PromptVersion, QueryResult, RunDetail, RunSummary, VectorIndex, VectorStore,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(url, init)
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (data?.detail) msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    } catch {
      /* 본문 없음 */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>
}

const get = <T,>(url: string) => request<T>('GET', url)
const post = <T,>(url: string, body?: unknown) => request<T>('POST', url, body)
const put = <T,>(url: string, body?: unknown) => request<T>('PUT', url, body)
const patch = <T,>(url: string, body?: unknown) => request<T>('PATCH', url, body)
const del = (url: string) => request<void>('DELETE', url)

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export type ParserInput = Omit<Parser, 'id' | 'last_health' | 'monitor' | 'test_callable'>
export type ModelInput = Omit<LLMModel, 'id' | 'last_health' | 'blocked' | 'strategy_chain'>
export type VersionInput = Pick<PromptVersion, 'system_template' | 'user_template' | 'few_shots' | 'output_schema' | 'note'>

export const api = {
  // documents
  documents: (f: { parser_id?: number; source?: string; q?: string; project_id?: number; unassigned?: boolean; include_descendants?: boolean } = {}) =>
    get<DocumentSummary[]>(`/api/documents${qs(f)}`),
  document: (id: number) => get<DocumentDetail>(`/api/documents/${id}`),
  deleteDocument: (id: number) => del(`/api/documents/${id}`),
  documentFileUrl: (id: number) => `/api/documents/${id}/file`,
  ingestBatch: (form: FormData) => post<{ imported: DocumentSummary[]; failed: { title: string; reason: string }[] }>('/api/ingest/batch', form),
  ingestFailures: () => get<{ id: number; source_name: string; reason: string; created_at: string }[]>('/api/ingest/failures'),
  testParse: (form: FormData) => post<ParseJob[]>('/api/test-parse', form),
  parseJobs: (ids?: number[]) => get<ParseJob[]>(`/api/parse-jobs${qs({ ids: ids?.join(',') })}`),
  parseJobRawUrl: (id: number) => `/api/parse-jobs/${id}/raw`,

  // parsers
  adapters: () => get<{ name: string; description: string }[]>('/api/adapters'),
  parsers: () => get<Parser[]>('/api/parsers'),
  createParser: (p: ParserInput) => post<Parser>('/api/parsers', p),
  updateParser: (id: number, p: ParserInput) => put<Parser>(`/api/parsers/${id}`, p),
  parserHealth: (id: number) => post<Parser['last_health']>(`/api/parsers/${id}/health`),
  parserJobs: (id: number) => get<ParseJob[]>(`/api/parsers/${id}/jobs`),

  // models
  modelsMeta: () => get<{ providers: { name: string; label: string; engines: string[] }[]; strategies: string[]; allow_external_llm: boolean }>('/api/models/meta'),
  models: (usableOnly = false) => get<LLMModel[]>(`/api/models${qs({ usable_only: usableOnly })}`),
  createModel: (m: ModelInput) => post<LLMModel>('/api/models', m),
  updateModel: (id: number, m: ModelInput) => put<LLMModel>(`/api/models/${id}`, m),
  modelHealth: (id: number) => post<LLMModel['last_health']>(`/api/models/${id}/health`),

  // prompts
  promptDefaults: () => get<{ system_template: string; user_template: string; output_schema: Record<string, unknown>; variables: Record<string, string>; statuses: string[] }>('/api/prompts/defaults'),
  prompts: () => get<Prompt[]>('/api/prompts'),
  prompt: (id: number) => get<Prompt>(`/api/prompts/${id}`),
  createPrompt: (name: string, description = '') => post<Prompt>('/api/prompts', { name, description }),
  updatePrompt: (id: number, description: string, doc_types: string[]) => put<Prompt>(`/api/prompts/${id}`, { description, doc_types }),
  createVersion: (promptId: number, v: VersionInput) => post<PromptVersion>(`/api/prompts/${promptId}/versions`, v),
  setVersionStatus: (versionId: number, status: string) => patch<PromptVersion>(`/api/prompts/versions/${versionId}/status`, { status }),
  rollbackVersion: (versionId: number) => post<PromptVersion>(`/api/prompts/versions/${versionId}/rollback`),
  forkVersion: (versionId: number, name: string) => post<Prompt>(`/api/prompts/versions/${versionId}/fork`, { name }),
  previewPrompt: (body: { document_id: number; system_template: string; user_template: string; few_shots: unknown[]; model_id?: number; settings: Partial<ChunkSettings>; params: Record<string, unknown> }) =>
    post<PromptPreview>('/api/prompts/preview', body),

  // runs
  startRun: (body: { document_id: number; method: string; prompt_version_id?: number; model_id?: number; params: Record<string, unknown>; settings: Partial<ChunkSettings> }) =>
    post<RunSummary>('/api/runs', body),
  runs: (documentId?: number) => get<RunSummary[]>(`/api/runs${qs({ document_id: documentId })}`),
  run: (id: number) => get<RunDetail>(`/api/runs/${id}`),
  deleteRun: (id: number) => del(`/api/runs/${id}`),
  feedback: (runId: number, chunkId: string, value: 'up' | 'down' | null) =>
    post<RunDetail['feedback']>(`/api/runs/${runId}/feedback`, { chunk_id: chunkId, value }),
}

export type EmbeddingModelInput = Omit<EmbeddingModel, 'id' | 'last_health' | 'blocked'>
export type VectorStoreInput = Omit<VectorStore, 'id' | 'last_health'>

export const vapi = {
  embeddingModels: (usableOnly = false) => get<EmbeddingModel[]>(`/api/embedding-models${qs({ usable_only: usableOnly })}`),
  createEmbeddingModel: (m: EmbeddingModelInput) => post<EmbeddingModel>('/api/embedding-models', m),
  updateEmbeddingModel: (id: number, m: EmbeddingModelInput) => put<EmbeddingModel>(`/api/embedding-models/${id}`, m),
  embeddingHealth: (id: number) => post<EmbeddingModel['last_health']>(`/api/embedding-models/${id}/health`),

  vectorStores: () => get<VectorStore[]>('/api/vector-stores'),
  createVectorStore: (s: VectorStoreInput) => post<VectorStore>('/api/vector-stores', s),
  updateVectorStore: (id: number, s: VectorStoreInput) => put<VectorStore>(`/api/vector-stores/${id}`, s),
  vectorStoreHealth: (id: number) => post<VectorStore['last_health']>(`/api/vector-stores/${id}/health`),

  indexMeta: () => get<{ templates: { label: string; template: string }[]; template_fields: string[]; metrics: string[]; modes: string[] }>('/api/indexes/meta'),
  indexes: () => get<VectorIndex[]>('/api/indexes'),
  index: (id: number) => get<VectorIndex>(`/api/indexes/${id}`),
  createIndex: (body: { run_id: number; store_id: number; embedding_model_id: number; collection: string; name?: string; embed_template: string; metric: string; mode: string }) =>
    post<VectorIndex>('/api/indexes', body),
  appendRun: (id: number, runId: number) => post<VectorIndex>(`/api/indexes/${id}/append`, { run_id: runId }),
  deleteIndex: (id: number, dropCollection: boolean) => del(`/api/indexes/${id}${qs({ drop_collection: dropCollection })}`),
  query: (id: number, body: { query: string; top_k: number; filter: string }) => post<QueryResult>(`/api/indexes/${id}/query`, body),
}

export type ProjectInput = Pick<Project, 'name' | 'description' | 'parent_id' | 'sort_order' | 'method' | 'prompt_id' | 'prompt_version_id' | 'model_id' | 'params' | 'settings' | 'doc_type'>

export const papi = {
  projects: () => get<ProjectTree>('/api/projects'),
  project: (id: number) => get<Project>(`/api/projects/${id}`),
  createProject: (p: Partial<ProjectInput> & { name: string }) => post<Project>('/api/projects', p),
  updateProject: (id: number, p: ProjectInput) => put<Project>(`/api/projects/${id}`, p),
  deleteProject: (id: number, moveToParent: boolean) => del(`/api/projects/${id}${qs({ move_to_parent: moveToParent })}`),
  runAll: (id: number, body: { include_descendants: boolean; only_without_run: boolean }) =>
    post<{ run_ids: number[]; document_count: number; method: string }>(`/api/projects/${id}/run-all`, body),
  moveDocuments: (documentIds: number[], projectId: number | null) =>
    post<{ moved: number }>('/api/documents/move', { document_ids: documentIds, project_id: projectId }),
  patchDocument: (id: number, body: { title?: string; doc_type?: string; project_id?: number; clear_project?: boolean }) =>
    patch<DocumentSummary>(`/api/documents/${id}`, body),
}
