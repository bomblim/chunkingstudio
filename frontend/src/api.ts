import type {
  ChunkSettings, DocumentDetail, DocumentSummary, LLMModel, ParseJob, Parser, Prompt, PromptPreview,
  PromptVersion, RunDetail, RunSummary,
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
  documents: (f: { parser_id?: number; source?: string; q?: string } = {}) =>
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
