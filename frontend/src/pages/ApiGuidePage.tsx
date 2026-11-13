import { useState } from 'react'
import { api, kapi } from '../api'
import { askConfirm, Badge, ErrorBanner, Modal, fmtDate, useAsync } from '../components/ui'
import type { ApiKey } from '../types'

/** 외부 시스템용 파이프라인 API 안내: 업로드 → 파싱 → 청킹 → 적재 (curl 예시) */

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 클립보드 권한이 없으면 무시 */ }
  }
  return (
    <div className="api-code">
      <div className="api-code-head">
        <span className="small muted">{label ?? 'bash'}</span>
        <button className="sm ghost" onClick={() => void copy()}>{copied ? '복사됨' : '복사'}</button>
      </div>
      <pre className="code-box">{code}</pre>
    </div>
  )
}

function Endpoint({ method, path, async: isAsync }: { method: string; path: string; async?: boolean }) {
  return (
    <div className="row" style={{ gap: 8, margin: '6px 0' }}>
      <Badge kind={method === 'GET' ? 'ok' : 'accent'}>{method}</Badge>
      <code>{path}</code>
      {isAsync && <Badge kind="warn">비동기</Badge>}
    </div>
  )
}

function Fields({ rows }: { rows: [string, string, string][] }) {
  return (
    <table className="list" style={{ margin: '6px 0 10px' }}>
      <thead><tr><th style={{ width: 170 }}>필드</th><th style={{ width: 90 }}>필수</th><th>설명</th></tr></thead>
      <tbody>{rows.map(([f, req, desc]) => <tr key={f}><td className="mono small">{f}</td><td className="small">{req}</td><td className="small">{desc}</td></tr>)}</tbody>
    </table>
  )
}

function Status({ flow, done, failed }: { flow: string; done: string; failed: string }) {
  return (
    <div className="banner info small" style={{ margin: '6px 0 10px' }}>
      <b>상태(status)</b>: <code>{flow}</code><br />
      완료(<code>done</code>) 시 {done} · 실패(<code>failed</code>) 시 {failed}
    </div>
  )
}

export default function ApiGuidePage() {
  const health = useAsync(() => api.health(), [])
  const [showKeys, setShowKeys] = useState(false)
  const configured = health.data?.studio_url || ''
  const B = (configured || window.location.origin).replace(/\/+$/, '')

  const pollFn = `# 상태가 done/failed가 될 때까지 2초 간격으로 조회 (jq 필요)
wait_done() {  # 사용: wait_done <조회 URL>
  while :; do
    body=$(curl -s -H "$AUTH" "$1"); status=$(echo "$body" | jq -r '.status // "error"')
    echo "status=$status" >&2
    case "$status" in done|failed) echo "$body"; return ;; error) echo "$body" >&2; return 1 ;; esac
    sleep 2
  done
}`

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API 안내</h1>
          <p>외부 시스템에서 Studio 파이프라인을 호출하는 방법입니다. 순서대로 <b>문서 업로드 → 파싱 → 청킹 → 저장소 적재 → 질의</b>를 실행합니다. API로 들어온 문서는 문서 목록에 유입 <b>API</b>로 표시됩니다.</p>
        </div>
        <button className="primary" onClick={() => setShowKeys(true)}>API 키 관리</button>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 10 }}>
          <div className="field grow" style={{ maxWidth: 420 }}>
            <span>Studio 주소 (BASE)</span>
            <code style={{ fontSize: 14, display: 'block' }}>{B}</code>
            <span className="small muted" style={{ display: 'block' }}>
              {configured ? <>서버 <code>.env</code>의 <code>CS_STUDIO_URL</code> 값</> : <><code>CS_STUDIO_URL</code> 미설정 — 지금 브라우저 주소를 표시합니다. 서버 <code>.env</code>에 정의하세요</>}
            </span>
          </div>
          <div className="small muted grow">
            외부용 API는 <code>/api/v1/…</code>이며 <b>API 키가 필요합니다</b>. 우측 상단 <b>API 키 관리</b>에서 발급한 키를
            <code>Authorization: Bearer &lt;키&gt;</code>(또는 <code>X-API-Key</code>) 헤더로 보내세요. 키가 없거나 틀리면 <code>401</code>입니다.
            비동기 단계는 <b>작업 ID를 바로 돌려주고</b>, 상태 조회 API로 끝났는지 확인합니다. 예시의 JSON 처리에는 <code>jq</code>를 씁니다.
          </div>
        </div>
        <CodeBlock code={`BASE=${B}
API_KEY=csk_발급받은_키              # API 키 관리에서 발급 (발급 때 한 번만 표시)
AUTH="Authorization: Bearer $API_KEY"

# 필요한 ID 확인 — 모든 ID는 UUID 문자열입니다
curl -s -H "$AUTH" "$BASE/api/v1/parsers"           | jq '.[] | {id, name, enabled}'      # parser_id
curl -s -H "$AUTH" "$BASE/api/v1/projects"          | jq '.projects[] | {id, path}'      # project_id
curl -s -H "$AUTH" "$BASE/api/v1/embedding-models?usable_only=true" | jq '.[] | {id, name}'  # embedding_model_id

# 아래 예시에서 쓸 값 (위 결과의 id로 바꾸세요)
PARSER_ID=0193a8c2-0000-7000-8000-000000000001
PROJECT_ID=0193a8c2-0000-7000-8000-000000000002
EMB_ID=0193a8c2-0000-7000-8000-000000000003`} />
        <CodeBlock label="bash — 상태 조회 도우미 (아래 예시에서 사용)" code={pollFn} />
      </div>

      {/* 1. 문서 업로드 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>1. 문서 업로드</h2>
        <p className="small muted">원본 파일만 올리고 <code>file_id</code>를 받습니다. 같은 내용의 파일은 저장소에 한 번만 보관됩니다.</p>
        <Endpoint method="POST" path="/api/v1/files" />
        <Fields rows={[['file', '필수', 'multipart 파일 (PDF·이미지·MD 등, 파서가 지원하는 형식)']]} />
        <CodeBlock code={`FILE_ID=$(curl -s -H "$AUTH" -X POST "$BASE/api/v1/files" -F "file=@./사내규정.pdf" | jq -r .id)
echo "file_id=$FILE_ID"`} />
        <CodeBlock label="응답 (201)" code={`{"id": "0193a8c2-7f4e-7b21-9a3d-5c2e8f1b4d70", "file_name": "사내규정.pdf", "file_hash": "9148e9ae…", "size": 482133,
 "content_type": "application/pdf", "created_at": "…", "updated_at": "…"}`} />
        <Endpoint method="GET" path="/api/v1/files/{file_id}" />
      </div>

      {/* 2. 파싱 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>2. 파싱</h2>
        <p className="small muted">업로드한 파일을 등록된 문서 파서(API)로 파싱해 표준 스키마 문서를 만듭니다. 작업 ID를 받은 뒤 상태를 조회하면 완료 시 <code>document_id</code>가 채워집니다.</p>
        <Endpoint method="POST" path="/api/v1/parse-jobs" async />
        <Fields rows={[
          ['file_id', '필수', '1단계에서 받은 파일 ID'],
          ['parser_id', '필수', '사용할 문서 파서 (API URL이 등록된 파서)'],
          ['project_id', '선택', '문서를 넣을 프로젝트. 청킹 프로파일·적재 컬렉션이 이 프로젝트 설정을 따릅니다 (없으면 미분류)'],
          ['doc_type', '선택', '문서 유형 (프롬프트의 {{doc_type}})'],
          ['params', '선택', '파서 파라미터 (JSON 객체)'],
        ]} />
        <CodeBlock code={`JOB_ID=$(curl -s -H "$AUTH" -X POST "$BASE/api/v1/parse-jobs" -H "Content-Type: application/json" \\
  -d "{\\"file_id\\": \\"$FILE_ID\\", \\"parser_id\\": \\"$PARSER_ID\\", \\"project_id\\": \\"$PROJECT_ID\\"}" | jq -r .id)

# 상태 조회 → document_id
DOC_ID=$(wait_done "$BASE/api/v1/parse-jobs/$JOB_ID" | jq -r .document_id)
echo "document_id=$DOC_ID"`} />
        <Endpoint method="GET" path="/api/v1/parse-jobs/{job_id}" />
        <Status flow="queued → parsing → converting → done | failed" done={'document_id'} failed={'error_kind(parser_error · timeout · adapter_error), error'} />
        <CodeBlock label="응답 예 (상태 조회)" code={`{"id": "0193a8c3-…", "status": "done", "document_id": "0193a8c3-…", "parser_id": "0193a8c2-…",
 "parser_name": "upstage-parser", "file_name": "사내규정.pdf", "elapsed_ms": 9875, "error_kind": "", "error": "",
 "project_id": "0193a8c2-…", …}`} />
        <details>
          <summary className="small">이미 파싱된 결과(JSON)가 있다면 — 파서 결과 바로 넣기 (동기)</summary>
          <Endpoint method="POST" path="/api/v1/ingest" />
          <p className="small muted">파서가 만든 결과를 그대로 보내면 해당 파서의 어댑터로 표준 스키마로 바꿔 바로 문서를 만듭니다(응답의 <code>id</code>가 document_id).</p>
          <CodeBlock code={`curl -s -H "$AUTH" -X POST "$BASE/api/v1/ingest" -H "Content-Type: application/json" \\
  -d "{\\"parser_id\\": \\"$PARSER_ID\\", \\"title\\": \\"사내규정.pdf\\", \\"project_id\\": \\"$PROJECT_ID\\", \\"payload\\": $(cat parsed.json)}" | jq '{id, title}'`} />
        </details>
      </div>

      {/* 3. 청킹 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>3. 청킹</h2>
        <p className="small muted"><code>method</code>를 생략하면 문서가 속한 <b>프로젝트의 청킹 프로파일</b>(방식·프롬프트·LLM 모델·설정, 상위 상속)로 실행합니다. 미분류 문서는 방식을 직접 지정해야 합니다.</p>
        <Endpoint method="POST" path="/api/v1/runs" async />
        <Fields rows={[
          ['document_id', '필수', '2단계에서 받은 문서 ID'],
          ['method', '선택', '생략: 프로젝트 프로파일 / llm / rule_structure(규칙 baseline)'],
          ['model_id, prompt_version_id', 'llm일 때', '직접 지정 시 청킹 모델·프롬프트 버전'],
          ['settings', '선택', '청킹 설정 덮어쓰기 (예: {"max_tokens": 512})'],
        ]} />
        <CodeBlock code={`RUN_ID=$(curl -s -H "$AUTH" -X POST "$BASE/api/v1/runs" -H "Content-Type: application/json" \\
  -d "{\\"document_id\\": \\"$DOC_ID\\"}" | jq -r .id)

wait_done "$BASE/api/v1/runs/$RUN_ID" | jq '{status, totals, error}'`} />
        <Endpoint method="GET" path="/api/v1/runs/{run_id}" />
        <Status flow="queued → running → done | failed" done={'totals.chunk_count, chunks(청크 목록), validation'} failed={'error'} />
        <details>
          <summary className="small">프로젝트 문서 전체를 한 번에 — 일괄 청킹</summary>
          <Endpoint method="POST" path="/api/v1/projects/{project_id}/run-all" async />
          <CodeBlock code={`curl -s -H "$AUTH" -X POST "$BASE/api/v1/projects/$PROJECT_ID/run-all" -H "Content-Type: application/json" \\
  -d '{"include_descendants": true, "only_without_run": false}' | jq '{run_ids, document_count}'
# 각 run_id를 GET /api/runs/{run_id} 로 조회`} />
        </details>
      </div>

      {/* 4. 저장소 적재 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>4. 저장소 적재</h2>
        <p className="small muted">청킹 결과를 임베딩해 벡터 저장소에 넣습니다. 적재할 컬렉션은 문서 프로젝트에 지정된 컬렉션(미분류·미지정은 기본 컬렉션)으로 자동 결정되고, 같은 문서의 이전 청크는 교체됩니다.</p>
        <Endpoint method="POST" path="/api/v1/indexes" async />
        <Fields rows={[
          ['run_id', '필수', '3단계에서 받은 청킹 실행 ID (완료된 것)'],
          ['embedding_model_id', '필수', '임베딩 모델 (컬렉션에 이미 적재된 게 있으면 같은 모델이어야 함)'],
          ['embed_template', '선택', '임베딩 텍스트 템플릿 (기본 {text}, 예: "{title}\\n{summary}\\n\\n{text}")'],
          ['metric', '선택', 'COSINE(기본) · IP · L2 — 컬렉션을 새로 만들 때만 적용'],
        ]} />
        <CodeBlock code={`INDEX_ID=$(curl -s -H "$AUTH" -X POST "$BASE/api/v1/indexes" -H "Content-Type: application/json" \\
  -d "{\\"run_id\\": \\"$RUN_ID\\", \\"embedding_model_id\\": \\"$EMB_ID\\"}" | jq -r .id)

wait_done "$BASE/api/v1/indexes/$INDEX_ID" | jq '{status, store_name, collection, chunk_count, error}'`} />
        <Endpoint method="GET" path="/api/v1/indexes/{index_id}" />
        <Status flow="queued → running → done | failed" done={'chunk_count(컬렉션 전체 청크 수), run_ids'} failed={'error'} />
        <p className="small muted" style={{ marginTop: 0 }}>진행 중에는 <code>progress</code>에 <code>{'{phase: embedding | inserting, done, total}'}</code>가 표시됩니다. 적재 위치는 미리 <code>GET /api/v1/index-target?document_id=…</code>로 확인할 수 있습니다.</p>
        <details>
          <summary className="small">프로젝트 문서 전체를 한 번에 — 일괄 적재 (문서마다 최근 성공한 청킹)</summary>
          <Endpoint method="POST" path="/api/v1/projects/{project_id}/index-all" async />
          <CodeBlock code={`curl -s -H "$AUTH" -X POST "$BASE/api/v1/projects/$PROJECT_ID/index-all" -H "Content-Type: application/json" \\
  -d "{\\"embedding_model_id\\": \\"$EMB_ID\\", \\"mode\\": \\"append\\"}" | jq '{indexes: [.indexes[] | {id, collection}], document_count, skipped}'
# 각 인덱스 id를 GET /api/indexes/{id} 로 조회 (stats.batch에 문서별 진행·실패 내역)`} />
        </details>
      </div>

      {/* 5. 질의 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>5. 질의</h2>
        <p className="small muted">적재한 컬렉션에서 질의와 가까운 청크를 찾습니다(동기). 인덱스 ID는 4단계 응답이나 <code>GET /api/v1/indexes</code>(컬렉션별 목록)에서 확인합니다.</p>
        <Endpoint method="POST" path="/api/v1/indexes/{index_id}/query" />
        <Fields rows={[
          ['query', '필수', '질의 문장'],
          ['top_k', '선택', '돌려받을 청크 수 (기본 5, 최대 100)'],
          ['filter', '선택', 'Milvus 필터식 (예: document_id == "0193a8c3-…" · metadata["doc_type"] == "사내 규정")'],
          ['principals', '선택', '사용자 권한 주체 목록. 주면 공개 청크와 이 주체가 허용된 청크만 검색 ([]: 공개만, 생략: 필터 없음)'],
          ['rerank_model_id', '선택', '리랭크 모델 ID. 주면 벡터 후보를 다시 점수 매겨 top_k만 반환'],
          ['rerank_candidates', '선택', '리랭크할 후보 수 (기본 top_k×4, 최소 20, 최대 200)'],
        ]} />
        <CodeBlock code={`curl -s -H "$AUTH" -X POST "$BASE/api/v1/indexes/$INDEX_ID/query" -H "Content-Type: application/json" \\
  -d '{"query": "출장비 승인 절차", "top_k": 5, "principals": ["group:경영지원"]}' \\
  | jq '.hits[] | {score, title, document_id, text}'

# 리랭크 적용
curl -s -H "$AUTH" -X POST "$BASE/api/v1/indexes/$INDEX_ID/query" -H "Content-Type: application/json" \\
  -d '{"query": "출장비 승인 절차", "top_k": 5, "rerank_model_id": "<리랭크 모델 ID>", "rerank_candidates": 40}' \\
  | jq '.hits[] | {rerank_score, score, vector_rank, title}'`} />
        <CodeBlock label="응답 (200)" code={`{"query": "출장비 승인 절차", "embed_ms": 35, "search_ms": 12, "metric": "COSINE",
 "rerank": {"model_name": "bge-reranker-v2-m3", "candidates": 40, "latency_ms": 180} | null,
 "applied_filter": "metadata[\\"public\\"] == true or json_contains_any(...)", "warnings": [],
 "hits": [{"id": "…", "score": 0.81, "vector_rank": 1, "rerank_score": 0.93,
           "chunk_id": "C3", "run_id": "0193a8c3-…", "document_id": "0193a8c3-…", "title": "…", "section_path": "…",
           "text": "청크 원문", "metadata": {"document_title": "…", "pages": [2], "permissions": [...], …}}]}`} />
        <p className="small muted" style={{ margin: 0 }}>전체 API 목록: <a href={`${B}/docs`} target="_blank" rel="noreferrer">{B}/docs</a> (인터넷 연결 필요) · 스펙: <code>{B}/openapi.json</code></p>
      </div>
      {showKeys && <ApiKeysModal onClose={() => setShowKeys(false)} />}
    </>
  )
}

/** API 키 발급·삭제 (팝업) */
function ApiKeysModal({ onClose }: { onClose: () => void }) {
  const keys = useAsync(() => kapi.apiKeys(), [])
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<ApiKey & { key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setError('')
    setBusy(true)
    try {
      setIssued(await kapi.createApiKey(name))
      setCopied(false)
      setName('')
      void keys.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (k: ApiKey) => {
    if (!(await askConfirm(`'${k.name}' 키(${k.prefix}…)를 삭제할까요?\n이 키를 쓰는 외부 시스템은 바로 호출할 수 없게 됩니다.`, { title: 'API 키 삭제', confirmLabel: '삭제', danger: true }))) return
    setError('')
    try {
      await kapi.deleteApiKey(k.id)
      if (issued?.id === k.id) setIssued(null)
      void keys.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const copy = async () => {
    if (!issued) return
    try { await navigator.clipboard.writeText(issued.key); setCopied(true) } catch { /* 클립보드 권한 없음 */ }
  }

  return (
    <Modal wide title="API 키 관리" onClose={onClose} footer={<button onClick={onClose}>닫기</button>}>
      <ErrorBanner error={error || keys.error} />
      <p className="small muted" style={{ marginTop: 0 }}>
        외부 시스템이 <code>/api/v1</code>을 호출할 때 쓰는 키입니다. 시스템마다 키를 따로 발급해 두면, 필요 없어진 키만 삭제해 바로 막을 수 있습니다.
      </p>
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void create() }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="키 이름 (예: ERP 연동, 챗봇 서버)" aria-label="키 이름" maxLength={200} />
        <button className="primary" type="submit" disabled={busy || !name.trim()}>{busy ? '발급 중…' : '키 발급'}</button>
      </form>

      {issued && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          <div><b>'{issued.name}' 키가 발급되었습니다.</b> 이 창을 닫으면 다시 볼 수 없으니 지금 복사해 안전한 곳에 보관하세요.</div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <code className="grow" style={{ wordBreak: 'break-all', userSelect: 'all' }}>{issued.key}</code>
            <button className="sm" type="button" onClick={() => void copy()}>{copied ? '복사됨' : '복사'}</button>
          </div>
        </div>
      )}

      <table className="list" style={{ marginTop: 12 }}>
        <thead><tr><th>이름</th><th>키</th><th>발급</th><th>마지막 사용</th><th /></tr></thead>
        <tbody>
          {keys.data?.map((k) => (
            <tr key={k.id}>
              <td><b>{k.name}</b></td>
              <td className="mono small">{k.prefix}…</td>
              <td className="small">{fmtDate(k.created_at)}</td>
              <td className="small">{k.last_used_at ? fmtDate(k.last_used_at) : <span className="muted">사용 안 함</span>}</td>
              <td><button className="sm danger" type="button" onClick={() => void remove(k)}>삭제</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys.data?.length === 0 && <div className="empty">발급한 키가 없습니다. 키가 없으면 <code>/api/v1</code> 호출은 모두 401로 거절됩니다.</div>}
    </Modal>
  )
}
