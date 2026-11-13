import type {
  ApiKey,
  CollectionContents,
  User,
  IndexPlan,
  IndexTarget,
  ChunkSettings, DocumentDetail, DocumentSummary, EmbeddingModel, LLMModel, ParseJob, Parser, Prompt, PromptPreview,
  Project, ProjectTree, PromptVersion, QueryResult, RerankModel, RunDetail, RunSummary, VectorCollection, VectorIndex, VectorStore,
} from './types'

export const UNAUTHORIZED_EVENT = 'cs:unauthorized'

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
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    // 세션 만료·로그아웃·계정 중지: 앱이 로그인 화면으로 돌아가도록 알린다
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
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
  health: () => get<{ ok: boolean; allow_external_llm: boolean; studio_url: string }>('/api/health'),
  // documents
  documents: (f: { parser_id?: string; source?: string; q?: string; project_id?: string; unassigned?: boolean; include_descendants?: boolean } = {}) =>
    get<DocumentSummary[]>(`/api/documents${qs(f)}`),
  document: (id: string) => get<DocumentDetail>(`/api/documents/${id}`),
  deleteDocument: (id: string) => del(`/api/documents/${id}`),
  documentFileUrl: (id: string) => `/api/documents/${id}/file`,
  documentPageImageUrl: (id: string, pageNo: number) => `/api/documents/${id}/page-image/${pageNo}`,
  ingestBatch: (form: FormData) => post<{ imported: DocumentSummary[]; failed: { title: string; reason: string }[] }>('/api/ingest/batch', form),
  ingestFailures: () => get<{ id: string; source_name: string; reason: string; created_at: string }[]>('/api/ingest/failures'),
  testParse: (form: FormData) => post<ParseJob[]>('/api/test-parse', form),
  parseJobs: (ids?: string[]) => get<ParseJob[]>(`/api/parse-jobs${qs({ ids: ids?.join(',') })}`),
  parseJobRawUrl: (id: string) => `/api/parse-jobs/${id}/raw`,

  // parsers
  adapters: () => get<{ name: string; description: string }[]>('/api/adapters'),
  parsers: () => get<Parser[]>('/api/parsers'),
  createParser: (p: ParserInput) => post<Parser>('/api/parsers', p),
  updateParser: (id: string, p: ParserInput) => put<Parser>(`/api/parsers/${id}`, p),
  parserHealth: (id: string) => post<Parser['last_health']>(`/api/parsers/${id}/health`),
  parserJobs: (id: string) => get<ParseJob[]>(`/api/parsers/${id}/jobs`),

  // models
  modelsMeta: () => get<{ providers: { name: string; label: string; engines: string[] }[]; strategies: string[]; allow_external_llm: boolean }>('/api/models/meta'),
  models: (usableOnly = false) => get<LLMModel[]>(`/api/models${qs({ usable_only: usableOnly })}`),
  createModel: (m: ModelInput) => post<LLMModel>('/api/models', m),
  updateModel: (id: string, m: ModelInput) => put<LLMModel>(`/api/models/${id}`, m),
  modelHealth: (id: string) => post<LLMModel['last_health']>(`/api/models/${id}/health`),

  // prompts
  promptDefaults: () => get<{ system_template: string; user_template: string; output_schema: Record<string, unknown>; variables: Record<string, string>; statuses: string[] }>('/api/prompts/defaults'),
  prompts: () => get<Prompt[]>('/api/prompts'),
  prompt: (id: string) => get<Prompt>(`/api/prompts/${id}`),
  createPrompt: (name: string, description = '') => post<Prompt>('/api/prompts', { name, description }),
  updatePrompt: (id: string, description: string, doc_types: string[]) => put<Prompt>(`/api/prompts/${id}`, { description, doc_types }),
  createVersion: (promptId: string, v: VersionInput) => post<PromptVersion>(`/api/prompts/${promptId}/versions`, v),
  setVersionStatus: (versionId: string, status: string) => patch<PromptVersion>(`/api/prompts/versions/${versionId}/status`, { status }),
  rollbackVersion: (versionId: string) => post<PromptVersion>(`/api/prompts/versions/${versionId}/rollback`),
  forkVersion: (versionId: string, name: string) => post<Prompt>(`/api/prompts/versions/${versionId}/fork`, { name }),
  previewPrompt: (body: { document_id: string; system_template: string; user_template: string; few_shots: unknown[]; model_id?: string; settings: Partial<ChunkSettings>; params: Record<string, unknown> }) =>
    post<PromptPreview>('/api/prompts/preview', body),

  // runs
  startRun: (body: { document_id: string; method: string; prompt_version_id?: string; model_id?: string; params: Record<string, unknown>; settings: Partial<ChunkSettings> }) =>
    post<RunSummary>('/api/runs', body),
  runs: (documentId?: string) => get<RunSummary[]>(`/api/runs${qs({ document_id: documentId })}`),
  run: (id: string) => get<RunDetail>(`/api/runs/${id}`),
  deleteRun: (id: string) => del(`/api/runs/${id}`),
  feedback: (runId: string, chunkId: string, value: 'up' | 'down' | null) =>
    post<RunDetail['feedback']>(`/api/runs/${runId}/feedback`, { chunk_id: chunkId, value }),
}

export type EmbeddingModelInput = Omit<EmbeddingModel, 'id' | 'last_health' | 'blocked'>
export type RerankModelInput = Omit<RerankModel, 'id' | 'last_health' | 'blocked'>
export type VectorStoreInput = Omit<VectorStore, 'id' | 'last_health' | 'collections'>
export type CollectionInput = { name: string; description: string; is_default: boolean }

/** 적재 화면의 기본 임베딩 텍스트 템플릿: "제목 + 요약 + 본문" (서버 EMBED_TEMPLATES와 같은 값) */
export const DEFAULT_EMBED_TEMPLATE = '{title}\n{summary}\n\n{text}'

export const vapi = {
  embeddingModels: (usableOnly = false) => get<EmbeddingModel[]>(`/api/embedding-models${qs({ usable_only: usableOnly })}`),
  createEmbeddingModel: (m: EmbeddingModelInput) => post<EmbeddingModel>('/api/embedding-models', m),
  updateEmbeddingModel: (id: string, m: EmbeddingModelInput) => put<EmbeddingModel>(`/api/embedding-models/${id}`, m),
  embeddingHealth: (id: string) => post<EmbeddingModel['last_health']>(`/api/embedding-models/${id}/health`),
  rerankModels: (usableOnly = false) => get<RerankModel[]>(`/api/rerank-models${qs({ usable_only: usableOnly })}`),
  rerankMeta: () => get<{ providers: string[]; template_fields: string[] }>('/api/rerank-models/meta'),
  createRerankModel: (m: RerankModelInput) => post<RerankModel>('/api/rerank-models', m),
  updateRerankModel: (id: string, m: RerankModelInput) => put<RerankModel>(`/api/rerank-models/${id}`, m),
  deleteRerankModel: (id: string) => del(`/api/rerank-models/${id}`),
  rerankHealth: (id: string) => post<RerankModel['last_health']>(`/api/rerank-models/${id}/health`),

  vectorStores: () => get<VectorStore[]>('/api/vector-stores'),
  createVectorStore: (s: VectorStoreInput) => post<VectorStore>('/api/vector-stores', s),
  updateVectorStore: (id: string, s: VectorStoreInput) => put<VectorStore>(`/api/vector-stores/${id}`, s),
  createCollection: (storeId: string, c: CollectionInput) => post<VectorCollection>(`/api/vector-stores/${storeId}/collections`, c),
  updateCollection: (id: string, c: CollectionInput) => put<VectorCollection>(`/api/vector-collections/${id}`, c),
  deleteCollection: (id: string) => del(`/api/vector-collections/${id}`),
  collectionContents: (id: string, q: { document_id?: string; limit?: number; offset?: number }) =>
    get<CollectionContents>(`/api/vector-collections/${id}/contents${qs(q)}`),
  /** 컬렉션 비우기: 실제 컬렉션과 적재 기록 삭제(등록·프로젝트 지정은 유지) */
  emptyCollection: (id: string) => post<{ collection: string; dropped: boolean; removed_indexes: number; removed_chunks: number }>(`/api/vector-collections/${id}/empty`, {}),
  vectorStoreHealth: (id: string) => post<VectorStore['last_health']>(`/api/vector-stores/${id}/health`),

  indexMeta: () => get<{ templates: { label: string; template: string }[]; template_fields: string[]; metrics: string[]; modes: string[] }>('/api/indexes/meta'),
  indexes: () => get<VectorIndex[]>('/api/indexes'),
  index: (id: string) => get<VectorIndex>(`/api/indexes/${id}`),
  /** 저장소·컬렉션은 문서의 프로젝트 설정으로 정해진다(미분류는 기본 저장소) */
  indexTarget: (q: { document_id?: string; project_id?: string }) => get<IndexTarget>(`/api/index-target${qs(q)}`),
  createIndex: (body: { run_id: string; embedding_model_id: string; embed_template: string; metric: string }) =>
    post<VectorIndex>('/api/indexes', body),
  appendRun: (id: string, runId: string) => post<VectorIndex>(`/api/indexes/${id}/append`, { run_id: runId }),
  deleteIndex: (id: string, dropCollection: boolean) => del(`/api/indexes/${id}${qs({ drop_collection: dropCollection })}`),
  query: (id: string, body: { query: string; top_k: number; filter: string; principals?: string[] | null; rerank_model_id?: string | null; rerank_candidates?: number | null }) => post<QueryResult>(`/api/indexes/${id}/query`, body),
}

export type ProjectInput = Pick<Project, 'name' | 'description' | 'parent_id' | 'sort_order' | 'method' | 'prompt_id' | 'prompt_version_id' | 'model_id' | 'params' | 'settings' | 'doc_type' | 'vector_collection_id' | 'meta' | 'permissions' | 'permission_mode'>

export const papi = {
  projects: () => get<ProjectTree>('/api/projects'),
  project: (id: string) => get<Project>(`/api/projects/${id}`),
  createProject: (p: Partial<ProjectInput> & { name: string }) => post<Project>('/api/projects', p),
  updateProject: (id: string, p: ProjectInput) => put<Project>(`/api/projects/${id}`, p),
  deleteProject: (id: string, moveToParent: boolean) => del(`/api/projects/${id}${qs({ move_to_parent: moveToParent })}`),
  runAll: (id: string, body: { include_descendants: boolean; only_without_run: boolean }) =>
    post<{ run_ids: string[]; document_count: number; method: string }>(`/api/projects/${id}/run-all`, body),
  indexPlan: (id: string, includeDescendants = true) =>
    get<IndexPlan>(`/api/projects/${id}/index-plan${qs({ include_descendants: includeDescendants })}`),
  indexAll: (id: string, body: { embedding_model_id: string; embed_template: string; metric: string; mode: 'append' | 'recreate'; include_descendants: boolean }) =>
    post<{ indexes: VectorIndex[]; document_count: number; skipped: IndexPlan['skipped'] }>(`/api/projects/${id}/index-all`, body),
  moveDocuments: (documentIds: string[], projectId: string | null) =>
    post<{ moved: number }>('/api/documents/move', { document_ids: documentIds, project_id: projectId }),
  patchDocument: (id: string, body: { title?: string; doc_type?: string; project_id?: string; clear_project?: boolean }) =>
    patch<DocumentSummary>(`/api/documents/${id}`, body),
}

/** 외부용 API 키 관리 */
export const kapi = {
  apiKeys: () => get<ApiKey[]>('/api/api-keys'),
  createApiKey: (name: string) => post<ApiKey & { key: string }>('/api/api-keys', { name }),
  deleteApiKey: (id: string) => del(`/api/api-keys/${id}`),
}

/** 화면 로그인 */
export const authApi = {
  status: () => get<{ user: User | null; setup_required: boolean }>('/api/auth/status'),
  setup: (username: string, password: string, display_name: string) => post<User>('/api/auth/setup', { username, password, display_name }),
  login: (username: string, password: string) => post<User>('/api/auth/login', { username, password }),
  logout: () => post<void>('/api/auth/logout'),
  changePassword: (current_password: string, new_password: string) => post<void>('/api/auth/password', { current_password, new_password }),
}

/** 사용자 관리 */
export const usersApi = {
  list: () => get<User[]>('/api/users'),
  create: (username: string, password: string, display_name: string) => post<User>('/api/users', { username, password, display_name }),
  update: (id: string, body: { display_name?: string; enabled?: boolean; password?: string }) => patch<User>(`/api/users/${id}`, body),
  remove: (id: string) => del(`/api/users/${id}`),
}
