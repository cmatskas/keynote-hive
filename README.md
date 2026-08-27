# Hive

An Electron desktop app that combines AI models served via Amazon Bedrock's Mantle endpoint with AWS Transcribe for intelligent media transcription, AI-powered content creation, and multi-agent collaborative pipelines.

## Features

- 🤖 **Work Tab** — AI agent with code execution, web browsing, file I/O, image generation, and persistent memory via AgentCore
- 🐝 **Swarm Tab** — Multi-agent pipelines for articles, keynotes, speeches, and demo storyboards with quality rubric evaluation
- 💬 **Chat Tab** — Conversational AI analysis with conversation history and file attachments
- 🎵 **Transcribe Tab** — Audio/video transcription via AWS Transcribe with speaker labels, timestamps, and a searchable history of past transcripts
- 🧠 **17 Agent Skills** — Copy editing, copywriting, research, marketing psychology, document creation, generative art, and more
- 🎯 **Quality Rubrics** — Weighted criteria with penalty scoring, brief-specific adaptation, and adaptive learning from past runs
- ⚙️ **Model Management** — Configure Mantle-served models and assign pipeline roles (creator/worker/formatter) from the UI
- 📊 **Quality Analytics** — Dashboard showing pass rates, criteria heatmaps, and actionable insights across pipeline runs

## Quick Start

### Download Pre-built Binaries (Recommended)

Download: [GitHub Release](https://github.com/cmatskas/keynote-hive/releases).
Subsequent updates will be pushed automatically for in place updates

### Build from Source

```bash
git clone https://github.com/cmatskas/hive-xplat.git
cd hive-xplat
npm install
npm start          # development
npm run build      # production (all platforms)
```

### Getting Started

1. **Launch Hive.** On first run it opens straight to Settings → Credentials since nothing is configured yet.
2. **Configure AWS credentials.** Most users authenticate with their own personal AWS account's Admin-role credentials (e.g. via Isengard/Merlon) — paste them into Settings → Credentials (auto-detected from any format) and click "Save & Test Credentials." Hive works with any valid AWS credentials; an Admin-level role simply means every permission below is already covered without needing to configure anything IAM-related by hand.
3. **Setup Check runs automatically.** The first time credentials resolve successfully, Hive checks your account for a few things it needs (Web Search Gateway role, the two transcription S3 buckets, AgentCore Memory, Code Interpreter permissions) and shows a checklist for anything missing — see [Setup Check](#setup-check) below. Create what you need, skip what you don't, right from the app.
4. **Add your Mantle API key.** Generate a long-term [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) in the AWS console and paste it into Settings → Configuration → Mantle API Key — this is the one thing that can't be automated, since it's a secret tied to your own account.
5. **Start using the Work tab.**

If your credentials happen to resolve to Hive's shared admin AWS account, an **Admin** tab also appears automatically in Settings — see [Admin Tab](#admin-tab-aws-keynote-only) below. Regular users never see this tab and don't need to do anything with it.

## AWS Permissions Required

The list below documents what Hive actually calls, for anyone auditing or scoping a dedicated IAM role. In practice, most Hive users authenticate with an Admin-level role (via Isengard/Merlon) that already covers all of it — this list isn't a manual grant checklist to walk through, just a reference for what each feature needs under the hood:
- **Bedrock Mantle**: A long-term [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) configured in Settings → Mantle API Key. All model invocation (Work, Chat, Swarm) goes through Amazon Bedrock's Mantle endpoint via this key — no IAM-based `InvokeModel`/`Converse` permissions are needed for model calls themselves.
- **Transcribe**: `StartTranscriptionJob`, `GetTranscriptionJob`, `ListTranscriptionJobs` (for Transcribe tab; the last is used by **Find past transcriptions**)
- **S3**: `GetObject`, `PutObject`, `DeleteObject` on your buckets (for Transcribe tab)
- **S3**: `ListBucket` on the transcription output bucket — only needed by **Find past transcriptions**, which scans that bucket to rebuild Hive's index. Everything else in the Transcribe tab works without it.
- **AgentCore**: `bedrock-agentcore:StartCodeInterpreterSession`, `bedrock-agentcore:InvokeCodeInterpreter`, `bedrock-agentcore:StopCodeInterpreterSession`, `bedrock-agentcore:StartBrowserSession`, `bedrock-agentcore:StopBrowserSession` (for Work/Swarm code execution and web browsing)
- **AgentCore Gateway**: `bedrock-agentcore:CreateGateway`, `bedrock-agentcore:CreateGatewayTarget`, `bedrock-agentcore:ListGateways`, `bedrock-agentcore:GetGateway`, `bedrock-agentcore:ListGatewayTargets`, `bedrock-agentcore:GetGatewayTarget`, `bedrock-agentcore:InvokeGateway`, `bedrock-agentcore:InvokeWebSearch` (for web search via AgentCore Web Search Tool)
- **Setup Check** (see below): `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `s3:CreateBucket`, `bedrock-agentcore:GetMemory`, `bedrock-agentcore:CreateMemory` — only used by the in-app Setup Check to provision the items above on your behalf; not needed for Hive's normal runtime operation

<details>
<summary>Optional permissions</summary>

- **SageMaker**: `InvokeEndpoint` (for SDXL image generation)
- **Transcribe**: `DeleteTranscriptionJob` — lets the Transcribe tab's **Cancel** button delete a cancelled job so it stops billing. Without it, Cancel still works (Hive stops polling and the UI resets); the job just finishes server-side unobserved.
</details>

If you're on a scoped-down role rather than Admin and Setup Check reports "Action Required" for **Code Interpreter Permission**, run [`scripts/grant-hive-permissions.sh`](scripts/grant-hive-permissions.sh) against your AWS account — it grants exactly the runtime permissions listed above (not the Setup Check-only ones) by attaching a new, standalone IAM policy to your role. It never modifies anything already on your role, and can be fully undone (instructions printed at the end of the script). See the script's own header comment for full usage, or Settings → Configuration → Run Setup Check → **View Instructions** for the exact command copied to your situation.

## Setup Check

The first time you launch Hive after saving AWS credentials, it checks your account for a few things it needs — a Web Search Gateway execution role, the two transcription S3 buckets, an AgentCore Memory resource, and Code Interpreter permissions — and shows a checklist for anything missing. Most items are independent and created directly from the app; one (Code Interpreter Permission) is check-only, since it's a permission gap Hive can't grant on your behalf — see below.

- **Web Search Gateway**: creates the IAM role (`hive-web-search-gateway`) that lets AgentCore Gateway run the Web Search Tool target. The Gateway itself is still created on first web search use, exactly as before — this just removes the manual "open the console and create a role" step.
- **Transcription Input Bucket**: the S3 bucket the Transcribe tab uploads your media to.
- **Transcription Output Bucket**: the S3 bucket AWS Transcribe writes the finished transcript into. Transcription needs both, and neither can ship with a default, because S3 bucket names are unique across all of AWS. Both fields in Settings → Configuration pre-fill with an account-scoped suggestion (`hive-media-<accountId>` and `hive-transcripts-<accountId>`) that you can accept or overwrite, and Setup Check creates whichever bucket doesn't exist yet, saving the name it used back into Settings. If either is left unset, Hive refuses the transcription up front with a message naming the missing setting rather than failing partway through against AWS.
- **AgentCore Memory**: creates a Memory resource with semantic + summarization strategies for Work tab conversation memory.
- **Code Interpreter Permission**: verifies your current AWS credentials can start an AgentCore Code Interpreter session (needed for Work/Swarm code execution and document attachments), by attempting a real, immediately-stopped session. Unlike the other items, there's nothing for Hive to *create* here — a failure means your own IAM role/user is missing a permission, not that a resource doesn't exist yet. If this reports "Action Required," click **View Instructions** for a ready-to-copy command that runs [`scripts/grant-hive-permissions.sh`](scripts/grant-hive-permissions.sh) — see [AWS Permissions Required](#aws-permissions-required) above for what it grants and why Hive doesn't attempt this automatically.

Re-run it anytime via Settings → Configuration → **Run Setup Check**. It's safe to run repeatedly — every item is checked before anything is created, so re-running never duplicates existing resources.

Web search is currently only available in `us-east-1` — Hive always creates and calls the Gateway in that region regardless of your configured `region` setting. If Gateway creation or search calls fail after Setup Check reports it as ready, check Settings → Web Search for the current status and a retry button — the underlying error (permissions, throttling, region mismatch) is surfaced there.

## Admin Tab (`aws-keynote` only)

Hive has a second, separate setup tier for managing resources shared across the whole team rather than per-user — currently a shared Managed Knowledge Base and its AgentCore Gateway access list. This lives in a distinct **Admin** tab in Settings, visually marked (amber "ADMIN" badge) and hidden by default.

> **Known limitation — not yet usable.** Amazon Bedrock Managed Knowledge Base is not currently available in the `aws-keynote` account/region. The Admin tab's Knowledge Base and Gateway status checks will report "missing" until AWS enables Managed Knowledge Base for that account — there is nothing to fix on Hive's side. This feature is tabled until that changes; no shared Gateway or Knowledge Base has been created yet.

**Visibility is gated by AWS account ID, not a setting.** The Admin tab only appears when the AWS credentials currently loaded in Hive resolve (via `sts:GetCallerIdentity`) to the specific shared admin account Hive's shared resources live in. Regular users authenticating with their own personal account never see this tab. This is a UX convenience, not the actual security boundary — every action inside the tab still requires real AWS permissions in that account, so even if the tab were somehow force-shown, nothing in it would succeed without genuinely being signed in as that account.

**To use it:** temporarily swap your personal credentials in Settings → Credentials for the shared admin account's credentials, click "Save & Test Credentials," and the Admin tab appears. Swap back to your own credentials afterward for normal day-to-day use.

**What it does (once Managed Knowledge Base is available):**
- Shows the shared Knowledge Base's status and whether its dedicated Gateway (`hive-shared-gateway` — intentionally a separate Gateway from each user's own per-account `hive-web-search` Gateway used for web search; the two are unrelated and never share a name, account, or target) has a Knowledge Base target attached. Read-only checks — the KB itself is not created from here; that's a deliberate one-time console action given the real decisions involved — connectors, embedding model, storage — that shouldn't be automated.
- **Manage Access** — a 3-step wizard for granting or revoking an individual IAM role's access to the shared Gateway:
  1. Choose grant or revoke
  2. Enter the requesting role's ARN
  3. Review the exact resulting resource-policy JSON before applying — nothing is changed until this step's explicit **Apply** click

Every policy change is scoped to a single named statement Hive manages (`HiveAdminGrantedPrincipals`) and leaves any other pre-existing statements on the policy untouched. Revoking the last granted principal removes the statement entirely rather than leaving an empty grant behind.

**Configuration constants** (hardcoded in source, not settings — a regular user should never be able to change these from the UI, and they only ever need updating by whoever maintains the `aws-keynote` account):
- **Admin account ID** (`AWS_KEYNOTE_ACCOUNT_ID` in `src/main/models/awsValidator.js`): the account ID the visibility gate above checks against.
- **Shared Gateway URL/ARN**: not yet set — will be added once the Gateway is created (blocked on Managed Knowledge Base availability, see above). Once set, it will be surfaced read-only in the Admin tab itself, not just in source, so it's discoverable without reading code.

If either constant ever needs to change (e.g. the admin account changes, or the shared Gateway is recreated), that requires a source change and a new Hive release — there is no way to update them from the UI by design.

## Working Offline

Hive stays usable without a connection. Everything it stores — conversations, Work tab history, skills, showflows, settings — lives in plain files in the app's data directory, so none of it needs AWS to read or write.

**Works offline:** browsing, searching, loading and deleting conversations; Work tab history; creating and editing skills; saving settings; showflow new/open/save/import/export; downloading and copying an existing transcript; switching theme.

**Paused until the connection returns:** sending messages (Work, Chat), running Swarm pipelines, transcription, Save & Test Credentials, Setup Check, AgentCore Memory operations, and web search.

While offline you'll see a banner below the navbar, and the controls that need AWS are disabled with a tooltip explaining why. Both clear automatically on reconnect — there's nothing to retry by hand.

Two behaviours worth knowing:

- **Launching offline still opens the main app.** If credentials are already saved, Hive can't verify them without a connection, but it no longer treats that as "your credentials are bad" and sends you to the credentials page. You get the full UI with your work available.
- **An in-flight transcription is not lost.** A job already accepted by AWS runs to completion server-side regardless of what Hive is doing, so losing the connection — or having your credentials expire mid-job — pauses Hive's polling rather than failing the job. It resumes automatically when the connection returns or when you save new credentials, and the transcript arrives as normal. Cancelling while offline still works: the job deletion is queued and sent on reconnect so it stops billing.

An in-flight Work or Swarm run is deliberately left to fail on its own rather than being cancelled the moment the network drops, since a brief blip often resolves inside the AWS SDK's own retries. If it does fail, the error says Hive is offline rather than showing a raw network error.

## Which Tab Should I Use?

| | **Work** | **Swarm** | **Chat** |
|---|---|---|---|
| **Best for** | One-off tasks with back-and-forth iteration | Polished, publication-ready content | Quick questions and document analysis |
| **Agent count** | 1 (you + the agent) | 6–7 specialized agents | 1 (single model call) |
| **Tools** | Code execution, web browsing, file I/O, image generation | Code execution, web browsing, file I/O, image generation | None — text only |
| **Output files** | `.docx`, `.pptx`, `.xlsx`, images | `.docx`, `.pptx` (formatted by dedicated agent) | None |
| **Iteration** | Unlimited — keep refining across messages | Guided — review points between agents | Conversational |
| **Memory** | Persistent across conversations (via AgentCore Memory) | Per-pipeline only | Per-conversation only |
| **Cost** | Medium (one model, multiple tool calls) | Higher (multiple models, 6–7 agent turns) | Lowest (single model call) |

**Rules of thumb:**
- "Create me a document / analyze this file / build something" → **Work**
- "Write a polished article / keynote / speech from this brief" → **Swarm**
- "What does this document say? / Explain X / Summarize Y" → **Chat**

## Work Tab

Your personal AI agent with a persistent sandbox. Attach files, ask for documents, iterate across multiple messages — the agent remembers everything within a conversation.

**How it works:**
1. Type a prompt or attach files (Word, PDF, Excel, PowerPoint, images)
2. The agent activates relevant skills, writes and executes Python code in a secure sandbox, browses the web, and generates images
3. Output files (`.docx`, `.pptx`, `.xlsx`) are saved to `~/Documents/Hive/`

**Key capabilities:**
- Files persist across messages — attach a document in message 1, ask for edits in message 5
- Each conversation gets its own isolated sandbox and file state
- The agent auto-installs Python packages as needed (`python-docx`, `python-pptx`, `openpyxl`, etc.)
- Word documents include line numbers, headers, and "Amazon Confidential" footers automatically
- System notifications alert you when long-running tasks complete

<details>
<summary>Tips for best results</summary>

- For document creation, be specific: "Create a Word doc with an executive summary, 3 sections with headers, and a recommendations table"
- Attach reference files — the agent reads them and uses them as context
- Use the sidebar to switch between conversations without losing state
- If the agent's code fails, it automatically retries with a fix
</details>

## Swarm Tab

Multi-agent pipelines where teams of specialized AI agents collaborate to produce polished content. Each pipeline has researchers, writers, editors, quality gates, and formatters.

| Template | Agents | Output |
|---|---|---|
| Article / Blog Post | 7 | Researched, edited `.docx` |
| Keynote / Presentation | 7 | Slide deck `.pptx` with speaker notes |
| Speech / Talk | 6 | Timed speech with stage directions |
| Demo / Storyboard | 6 | Scene-by-scene storyboard deck |

**How it works:**
1. Pick a template → write a brief → optionally attach files or a workspace folder
2. Agents run sequentially: Researcher → Planner → Quality Gate → Writer → Editor → Final Check → Formatter
3. At review points, the pipeline pauses for your feedback (you'll get a system notification)
4. The formatter generates the final document and saves it locally

<details>
<summary>Quality system</summary>

- Each template has a weighted rubric (12–15 criteria) with penalty scoring for competitor references
- Rubrics adapt to your specific brief before evaluation
- The system learns from past runs — frequently-failing criteria get extra attention in future pipelines
- View pass rates, criteria heatmaps, and insights in Settings → Analytics
</details>

## Chat Tab

Conversational AI for analysis and Q&A. Lighter than the Work tab — no code execution or file generation, no tool loop, just a single model call.

- Attach documents for the model to analyze inline
- Full conversation history with save/load
- Choose any configured model

## Transcribe Tab

Audio and video transcription powered by AWS Transcribe.

- Drag and drop media files or browse to select
- Speaker diarization with labels
- Timestamps per segment
- Export transcription as text

Past transcriptions are kept in a sidebar you can search, rename and reopen — drag its inner edge to widen it if names are getting truncated, and hover any entry for its full details. Search looks inside the transcripts themselves, not just the names — so you can find a recording by a phrase someone said in it, and each result shows the matching line with its timestamp — so a transcript you've already paid for never has to be re-run. Each one is stored locally (so the list works offline) and mirrored alongside the transcript in your own output bucket, which means the history can be rebuilt from AWS even if Hive's local data is lost. Names default to the media file name and are editable while the job runs or any time afterwards.

Opening a past transcript shows the transcript only — no player. The player is handed the local file you dropped in, and by the time you reopen a transcript that file may have moved or gone, so the header names the source file instead.

**Find past transcriptions** (in the sidebar) asks AWS for anything Hive doesn't already know about — transcripts made before Hive kept a history, or everything after a reinstall or a move to a new machine. It reads the sidecar files in your output bucket first, which restore each entry complete with its name, and then falls back to AWS Transcribe's own job history for jobs whose output went elsewhere. Existing entries are never overwritten, so a name you typed is safe. It's deliberately a button rather than automatic, since it makes real AWS calls. If your role lacks `s3:ListBucket` the scan is skipped and the reason is reported, rather than quietly looking like there's nothing to find.

Deleting is deliberately two-step. Removing a transcription from the list is local by default; a separate checkbox also deletes the transcript and the job from AWS. That option is never pre-checked, because the AWS copy is what makes a transcript recoverable later and deleting it can't be undone.

Transcription runs in the background — it doesn't block the UI. Progress appears inline in the transcript pane, a spinner on the Transcribe nav item shows a job is running from whichever tab you're on, and an OS notification fires on completion or failure (clicking it brings you back to the Transcribe tab). A **Cancel** button stops an in-flight job: it aborts the upload if it's still running and deletes the Transcribe job so it stops billing. Only one transcription runs at a time — starting a second while one is in flight is rejected rather than overwriting the first.

If the connection drops or your credentials expire while a job is running, Hive pauses instead of failing — see [Working Offline](#working-offline).

## Agent Skills

17 bundled skills available in Settings → Skills:

| Category | Skills |
|---|---|
| Documents | `docx`, `pptx`, `xlsx`, `pdf` |
| Writing | `copywriting`, `copy-editing`, `doc-coauthoring` |
| Research | `research-first`, `customer-research`, `analysis-framework` |
| Strategy | `task-planner`, `launch-strategy`, `marketing-psychology` |
| Creative | `algorithmic-art`, `demo-storyboard` |
| Utility | `self-correction`, `web-browse` |

Skills are loaded on demand — the Work tab agent activates them when your task matches. Swarm agents have skills pre-assigned per role.

Create custom skills in Settings → Skills → New Skill. Each skill is a `SKILL.md` file with YAML frontmatter and markdown instructions.

## Model Configuration

Settings → Models lets you manage Bedrock (Mantle) models, define the order they appear in the drop downs, and assign swarm pipeline roles:

| Role | Purpose | Default |
|---|---|---|
| Creator | Writing, quality evaluation — best model | User defined |
| Worker | Research, planning, editing — balanced | User defined |
| Formatter | Document generation — cheapest capable | User defined |

All models are invoked via Amazon Bedrock's Mantle endpoint — Claude models go through Mantle's Anthropic Messages API, other models (e.g. GPT-5.x, Google Gemma) through Mantle's OpenAI-compatible API. Add or remove models and reassign roles from the UI.

> **Note:** You'll need to reconfigure all your models using the Mantle Model ID. Inference profiles are no longer needed!

> **xAI Grok models are now supported (as of `@strands-agents/sdk` 1.12.0).** They previously failed on every route with a validation error or a 500 — that was a real routing bug in the SDK's Mantle base-path table (fixed upstream, [harness-sdk#3691](https://github.com/strands-agents/harness-sdk/pull/3691)), not a client-side or account-side issue. Confirmed fixed end-to-end through Hive's own `createAgent()` path with 5 consecutive live test runs against `xai.grok-4.3`. One caveat carried over from the upstream fix's own testing: Grok models on Mantle have shown intermittent flakiness independent of routing (timeouts on an otherwise-correct path during some windows) — if a Grok call fails, it's worth retrying before assuming something regressed. Grok also needs a noticeably larger output token budget than other models before producing visible text (internal reasoning tokens consume part of the budget), so a very low `maxTokens` may surface as `MaxTokensError` rather than a routing failure.

## Development

```bash
npm test               # unit tests
npm run test:watch     # watch mode
npm run test:coverage  # coverage report
npm run test:integration  # live Mantle integration tests (requires MANTLE_API_KEY, makes real API calls, incurs costs)
```

### Live Mantle integration tests

`tests/integration/mantle-live.js` calls the real Mantle endpoint through Hive's actual `createAgent()` routing logic — one minimal request per model family (Anthropic, `openai.gpt-5.*`, other OpenAI-compatible). It runs as a plain Node script rather than a Jest test, since `@strands-agents/sdk` ships as pure ESM with no CJS build — every other test file in this repo works around that by mocking the SDK entirely, but this script's whole purpose is to exercise the real, unmocked SDK against the real endpoint, so that workaround isn't available here. Unlike the rest of the test suite, it deliberately makes real HTTP calls: unit tests can only verify Hive's own routing logic, never whether Mantle's actual API still matches that logic *today*. That gap is exactly what let two Anthropic-routing incidents (v3.0.1 and v3.1.2) reach production before being caught by a user report instead of a test.

Run it with `MANTLE_API_KEY=<your key> npm run test:integration`. It exits cleanly (code 0) with a clear message if `MANTLE_API_KEY` isn't set, so it never blocks normal development or `npm test`. Set `REQUIRE_MANTLE_KEY=1` to make a missing key a hard failure instead — this is what CI uses so a misconfigured secret can't silently skip the check.

**In CI**, this runs in two places, both requiring the `MANTLE_API_KEY` repository secret to be configured in GitHub Settings → Secrets:
- **Release pipeline** (`.github/workflows/release.yml`) — a `test` job (unit tests + this check) gates both the macOS and Windows build/publish jobs. A release cannot ship if Mantle routing is broken.
- **Scheduled tests** (`.github/workflows/scheduled-tests.yml`) — runs daily (07:00 UTC) independently of any push or release, so a Mantle routing change is caught within a day even between releases. Also runnable on demand from the Actions tab.

### Project Structure

```
src/
├── main/models/       # Backend: orchestrator, tools, skills, rubrics, settings
├── renderer/          # Frontend: tab controllers, UI logic
├── pages/             # HTML
└── styles/            # CSS
skills/                # 17 bundled agent skills
tests/                 # Jest test suites
```

## System Requirements

- **Windows**: 10/11, 4GB RAM, 200MB disk
- **macOS**: 10.12+, Intel or Apple Silicon, 4GB RAM, 200MB disk
- **Node.js**: 20+ (for building from source)

## Release Notes

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full version history.

## License

MIT — see [LICENSE](LICENSE)

## Support

- 📧 aws-tech-keynotes@amazon.com
- 🐛 [GitHub Issues](https://github.com/cmatskas/hive-xplat/issues)

---

