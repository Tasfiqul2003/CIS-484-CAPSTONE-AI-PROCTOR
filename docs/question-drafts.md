# Professor question draft review

Implemented November 16, 2026 in `question_drafts.py`, isolated from the normal
approved `questions` table. QuestionBank now contains a separate **AI question
drafts** section. The existing import, saved-question listing and deletion paths
remain available. No original prompt/Modelfile baseline was replaced.

The owning professor chooses an existing exam topic, difficulty 1–5, and 1–10
drafts. Generate calls the already configured Ollama URL/model with a new targeted
draft-only system prompt, saved rubric and bounded course-material summaries.
Model responses are proposals: the professor inspects and edits text/topic/
difficulty and explicitly selects **Approve into question bank** or **Reject
draft**. Only approval inserts one normal bank question in authored order.
Generation and review require an unpublished exam with no active attempts;
publishing remains a separate existing action. Existing saved bank rows are not
rewritten, and live exam code never reads the draft table.

## API and limits

All routes use the existing professor cookie authentication and server ownership
checks under `/exam/templates/{exam_id}/question-drafts`:

- `GET` returns bounded draft history, permitted topics, and `can_edit`.
- `POST /generate` accepts UUID `request_id`, topic, difficulty and count.
- `POST /{draft_id}/approve` accepts the reviewed `question_text`, topic and
  difficulty. There is no automatic approval or bulk unchecked insertion.
- `POST /{draft_id}/reject` accepts `{}` and never inserts a bank row.

Topic is constrained to the professor's exam topic coverage. Question text is
nonblank and at most 4,000 characters; topic at most 200. Output must have exactly
the requested number of distinct questions with the requested topic/difficulty
and no extra fields. The provider receives at most 16,000 serialized rubric
characters and 20,000 material-summary characters (at most 20 materials, 4,000 per
excerpt). The response transport is bounded to 128,000 bytes and 90 seconds; a
missing/slow/invalid provider produces an explicit error without invented drafts.
No model call is made by imports or the draft listing. Up to 100 pending drafts
per exam are allowed. The listing prioritizes pending drafts within its 500-row
bound so old approved history cannot hide all current work.

The generation-request ledger reserves an input hash and two-minute lease before
provider work. Exam row locks serialize approval and generation reservations;
model work runs outside the database transaction. Retrying the same UUID/settings
returns the saved/pending/failed result without another model call; reusing a UUID
with changed settings returns 409. An interrupted/expired job becomes failed when
checked, and a fresh explicit generation request is required. There is no new
background worker, scheduler or endless retry loop.

After inference, the route re-reads the signed cookie and account activation,
professor ownership, publication, active attempts, topic coverage, request lease,
rubric and material context. Changed/revoked context discards the proposals.
Approval stores an approval-content hash and resulting bank UUID in the same
transaction as the insert. Identical approval retries return that UUID; conflicting
approval content returns 409. Reject is idempotent. Deleting a previously approved
bank question does not cause a later approval retry to recreate it automatically.
Student/model text is data, never authority. Model output can still be inaccurate
or contain inappropriate content; the professor approval gate is mandatory.

## Migration and operations

`020_question_drafts.sql` adds `question_generation_requests` and `question_drafts`
with additive keys/checks/indexes, exam/professor foreign keys and an optional
approved-bank reference. It changes no existing bank rows, prompts, model weights,
accounts or application data. The initial implementation did not apply migrations. The subsequent authorized
local runtime task applied the reviewed additive migrations through the existing
ledger/backup procedure before the live verification recorded below. Missing storage returns an
unavailable error. Removing the new router/UI stops this feature without changing
approved questions; retaining the additive tables preserves its review audit.
No destructive rollback/deletion is run automatically.

Implementation verification used offline synthetic providers. The separately
authorized live localhost/Ollama verification is recorded below. No installs,
model downloads, real media, shared infrastructure, publication, commit or push
was used for this feature.
The provider endpoint/configuration inherits existing deployment controls. It is
not a new cloud integration and receives no database credentials.

## Verification

Synthetic API tests use actual signed professor cookies and SQLite with an
injected async generator. They verify ownership/roles/expiry, proposal isolation,
matching UUID retries, input rebinding, edited approval, authored order, duplicate
approval prevention, rejection, invalid model output, provider outage, published/
active exam restriction, context/account/topic/lease changes, foreign-key deletion
behavior and interrupted generation. SQLite tests do not prove PostgreSQL lock
behavior or live migration execution.

The in-memory Chromium question-bank suite intercepts every API and checks that
generation leaves the saved bank unchanged, edited approval adds a question,
rejection adds none, a lost generation response retries the same UUID, and outages/
published exams produce truthful states. It starts no application server and
performs no model inference. TypeScript `--noEmit` passed. Synthetic tests do not establish model quality or PostgreSQL concurrency.
Subsequent actual local HTTP/Ollama and PostgreSQL-backed behavior is recorded
below; multi-user load behavior and deployment outside P3 remain unverified.

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_question_drafts.py -q -p no:cacheprovider
```

From `frontend`, with the existing bundled Playwright path:

```powershell
$env:AVATAR_NODE_MODULES_PATH='C:\Users\Paulo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node tests/question-drafts-browser.test.mjs
```

Measured on P3: **25 backend draft tests passed in 1.13 seconds**; **3 mocked
Chromium question-bank scenarios passed**; TypeScript and tracked-file diff
whitespace checks passed. No live Ollama or PostgreSQL execution is claimed.


## Professor-owned context configuration

New exams previously had empty topic coverage and rubric with no authenticated
editing route. That prerequisite is now handled through GET/PUT
`/exam/templates/{exam_id}/question-drafts/context`, using the existing columns.
The Question Bank draft section includes **Professor topics and assessment
rubric**. GET returns the saved context unchanged. Edits remain in the editor
until the professor explicitly saves; legacy rubric JSON remains visible for
review rather than being silently replaced. PUT requires an unpublished exam
without active attempts, owning-professor authorization, an exam row lock and
the GET response's `expected_context_hash`. Concurrent changes produce 409.

Topics are 1–50 unique nonblank entries of at most 200 characters. Rubric criteria
are 1–20 unique names with bounded descriptions and finite positive maximum scores
at most 1000; rubric JSON is at most 16000 characters. Only the structured criteria
format is accepted on save. No new migration or direct database repair is needed.
The generator requests the same strict JSON schema it validates and disables
optional model thinking for this bounded draft-only operation, using Ollama's
documented [thinking control](https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx).
Original prompt/model baselines remain unchanged.

Context API additions passed 10 more synthetic cases (35 total draft tests),
including preservation on read, explicit save, stale hash, ownership/publication,
new empty exams and malformed topics/rubrics. The browser fixture now also checks
that editing alone performs no context save and explicit save supplies the loaded
hash and structured criteria.


## Authorized live local verification — November 16, 2026

After the reviewed backup/migration/restart performed by the parent runtime task,
`scripts/verify_question_drafts_live.py --run-local-http` ran through the actual
localhost frontend proxy, FastAPI, PostgreSQL and configured local Ollama. The
test used only existing protected synthetic professor accounts and one newly
created unpublished scratch exam. Credentials stayed in memory; response bodies,
cookies, generated question text and rubric content were not printed or logged.

All **19 HTTP stages passed** from 6:49:18 to 6:49:41 p.m. Eastern:

- The owner created an unpublished exam and configured its topic/rubric through
  the new authenticated context API, with no direct database updates.
- Actual Ollama generation returned two pending drafts in **22.219 seconds**.
  The normal bank still contained zero questions after generation.
- Repeating the same generation UUID returned the same draft identities in
  **0.016 seconds**, without another generation operation.
- Explicit approval of reviewed/edited text created one bank question; retrying
  approval returned the same bank UUID. Rejecting the other draft left exactly
  **one approved question** in the normal bank.
- The other professor received expected 404 responses for the draft list and a
  known draft approval request. The scratch exam remained unpublished.
- Cleanup verified the exact created exam ID, unique synthetic title and draft
  status, then deleted only that owned scratch exam through the normal API
  (HTTP 200). Its synthetic questions/drafts were removed with the exam.

The entire scenario took **23.234 seconds**. Protected evidence is in
`private-data/p3-local/verification/question-drafts-live-20261116T234918Z.json`,
containing stage names, status codes, timings, counts and the owned synthetic ID;
it contains no credentials, cookies, generated question text or rubric payload.
The harness uses a fixed localhost target, disables environment proxy inheritance
and redirects, and never publishes, starts an assessed attempt, captures media,
calls shared infrastructure or changes persistent data outside its own scratch
exam. Cleanup succeeded. No additional backend fix or restart was needed.

Measured latest offline context suite: **35 backend draft/context tests passed**,
**4 mocked Chromium scenarios passed**, and TypeScript passed. Live success here
demonstrates this synthetic professor workflow and measured small generation;
it does not certify generated-question quality, every topic/model or sustained
concurrent operation.


## Selected-exam request isolation

The draft panel, professor context editor and parent saved-question bank now
scope reads, generation, approval/rejection, saves, uploads and deletion to the
exam and request generation that initiated them. Selecting another exam aborts
all owned requests and clears old exam-only state. Late results cannot replace
the new exam's topics, private rubric, context hash, question list or preview, or
invoke an old reload/success callback or upload alert. Existing edits within the
same exam and generation retry IDs are preserved. Reads and mutations have bounded
waits, including JSON response bodies; question generation has a 100-second client
budget around the existing 90-second provider operation.

Focused follow-up evidence: **5 new mocked request-race browser groups passed**,
covering context read/save, draft read/generate/approve/reject/error, parent bank
read, and upload/delete across exam changes. Test responses are fully read before
being held and deliberately ignore later aborts, exercising ownership guards
rather than relying on browser cancellation alone. The existing **5 question-
draft/context browser groups** and TypeScript also passed after these fixes.
No backend, model, real records or application services were used in these checks.

Browser cancellation does not promise to undo a mutation the server already
accepted. Its response is kept out of the newly selected exam; reload the original
exam to observe the persisted outcome and use its existing idempotent request
identity when retrying.
