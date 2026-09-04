# Hive

An Electron desktop app that combines AI models served via Amazon Bedrock's Mantle endpoint with AWS Transcribe for intelligent media transcription, AI-powered content creation, and multi-agent collaborative pipelines.

## Features

- 🤖 **Work Tab** — AI agent with code execution, web browsing, file I/O, image generation, and persistent memory via AgentCore
- 🐝 **Swarm Tab** — Multi-agent pipelines for articles, keynotes, speeches, and demo storyboards with quality rubric evaluation
- 💬 **Chat Tab** — Conversational AI analysis with conversation history and file attachments
- 🎵 **Transcribe Tab** — Audio/video transcription via AWS Transcribe with speaker labels, timestamps, and a searchable history of past transcripts
- 🎨 **StoryBrand Tab** — Upload a keynote script or outline and see every paragraph colour-coded against the seven StoryBrand elements, with a qualitative audit and self-contained HTML export
- 🧠 **18 Agent Skills** — Copy editing, copywriting, research, marketing psychology, StoryBrand messaging, document creation, generative art, and more
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

Creating the Web Search Gateway item also starts web search straight away rather than waiting for the next launch, and the row only turns green if it genuinely came up — if it didn't, it says so, names the reason, and offers a retry.

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

Hive remembers its window size and position between launches (and won't restore onto a monitor you've since unplugged).

**Works offline:** browsing, searching, loading and deleting conversations; Work tab history; creating and editing skills; saving settings; showflow new/open/save/import/export; downloading and copying an existing transcript; switching theme; reading a file into the StoryBrand tab, and opening, searching and exporting a saved StoryBrand analysis.

**Paused until the connection returns:** sending messages (Work, Chat), running Swarm pipelines, transcription, StoryBrand analysis, Save & Test Credentials, Setup Check, AgentCore Memory operations, and web search.

While offline you'll see a banner below the navbar, and the controls that need AWS are disabled with a tooltip explaining why. Both clear automatically on reconnect, and the banner has a **Retry now** button if you'd rather not wait for the next check.

The same applies when AWS rejects your credentials rather than the network being down: the banner says so and points you at Settings, and the AWS controls are disabled just as they are offline — the call would fail either way, so it's better to stop it than to lose a long prompt or a queued pipeline to it. The exception is the controls you need to *fix* it: Save & Test Credentials and Setup Check stay available. Hive keeps checking in the background and clears everything automatically once your new credentials work, so there's nothing to dismiss or restart.

Hive does not warn you *before* credentials expire. It used to try, by reading an expiry out of the session token, but AWS session tokens are opaque blobs with no readable expiry and no API that returns one — so that warning never actually fired. Instead Hive checks once a minute and tells you promptly when they've gone, rather than pretending to predict it.

Two behaviours worth knowing:

- **Expired credentials no longer throw you out of the app.** Hive used to replace the whole UI with the credentials page a few seconds after noticing, which meant losing your tab, your scroll position and anything you had typed. It now tells you, disables what can't work, and leaves you where you were.
- **Launching offline still opens the main app.** If credentials are already saved, Hive can't verify them without a connection, but it no longer treats that as "your credentials are bad" and sends you to the credentials page. You get the full UI with your work available.
- **An in-flight transcription is not lost.** A job already accepted by AWS runs to completion server-side regardless of what Hive is doing, so losing the connection — or having your credentials expire mid-job — pauses Hive's polling rather than failing the job. It resumes automatically when the connection returns or when you save new credentials, and the transcript arrives as normal. Cancelling while offline still works: the job deletion is queued and sent on reconnect so it stops billing.

An in-flight Work or Swarm run is deliberately left to fail on its own rather than being cancelled the moment the network drops, since a brief blip often resolves inside the AWS SDK's own retries. If it does fail, the error says Hive is offline rather than showing a raw network error.

## Which Tab Should I Use?

| | **Work** | **Swarm** | **Chat** | **StoryBrand** |
|---|---|---|---|---|
| **Best for** | One-off tasks with back-and-forth iteration | Polished, publication-ready content | Quick questions and document analysis | Diagnosing the story structure of a script you already have |
| **Agent count** | 1 (you + the agent) | 6–7 specialized agents | 1 (single model call) | 1 (single model call) |
| **Tools** | Code execution, web browsing, file I/O, image generation | Code execution, web browsing, file I/O, image generation | None — text only | None — text only |
| **Output files** | `.docx`, `.pptx`, `.xlsx`, images | `.docx`, `.pptx` (formatted by dedicated agent) | None | Self-contained `.html` |
| **Iteration** | Unlimited — keep refining across messages | Guided — review points between agents | Conversational | Revise the script elsewhere, re-upload as a new revision |
| **Memory** | Persistent across conversations (via AgentCore Memory) | Per-pipeline only | Per-conversation only | Every analysis saved locally and searchable |
| **Cost** | Medium (one model, multiple tool calls) | Higher (multiple models, 6–7 agent turns) | Lowest (single model call) | Lowest (single model call) |

**Rules of thumb:**
- "Create me a document / analyze this file / build something" → **Work**
- "Write a polished article / keynote / speech from this brief" → **Swarm**
- "What does this document say? / Explain X / Summarize Y" → **Chat**
- "Does my keynote actually tell a story? / Where are the gaps?" → **StoryBrand**

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

**Long files.** AWS Transcribe accepts media up to 4 hours long (and 2GB), and processing takes real time roughly proportional to the length of the audio, so a long recording can legitimately take a while — the progress line shows elapsed time, and Hive polls less often as a job goes on rather than hammering AWS for hours. Hive waits up to 5 hours, which clears Transcribe's own maximum with room for queueing.

If a job somehow outlasts even that, Hive stops watching but **does not** call it a failure, because the job is still running on AWS and will still produce a transcript you have already paid for. It's recorded as still-on-AWS and named, and **Find past transcriptions** collects the result once it finishes. The same is true if you were offline for longer than Hive's pause budget.

## StoryBrand Tab

Upload a keynote script or a detailed outline and Hive classifies every paragraph against the seven [StoryBrand SB7](https://storybrand.com/) elements, then shows the script back to you colour-coded — Character in blue, Problem in red, Guide in green, Plan in gold, Call to Action in orange, Stakes in purple, Success in teal. A sticky card beside the text explains whichever element you're currently reading, and a Colour/Plain toggle drops the colours when you just want to read.

Above the script, a **flow ribbon** shows the shape of the talk: one segment per run of consecutive paragraphs sharing an element, in the same colours, sized by how many words each run takes. Click a segment to jump to that section, hover for its paragraph range and share of the script, and the run you're reading stays highlighted as you scroll. It's sequential rather than a chart of totals on purpose — totals tell you a keynote is 20% Problem, but not that the Problem all arrives in the first two minutes and never returns.

Accepts `.txt`, `.md`, `.docx` and `.pptx`, or text pasted straight in. **Your text is read locally and never rewritten.** Extraction happens on your machine — no model and no sandbox is involved in splitting the document into paragraphs — and the analysis only ever returns a mapping of paragraph number to element. Every word displayed is the word you uploaded. PDF isn't supported; export to `.docx` or paste the text.

Alongside the colours you get a qualitative **audit** in three parts. Each of the seven elements is marked strong, weak or missing with a 0–10 score, what was found, what's wrong and a specific fix. The **4 Rules of Messaging** get a pass or fail each — zero cognitive load, linked to survival, memorable and repeatable, audience as hero — with the line that earned the verdict. And the **5 Soundbites** (Problem, Empathy, Answer, Change, End Result) are extracted where present and drafted where missing.

Then a separate **AWS brand alignment** check scores the script out of 100 across five dimensions: persona, positioning, personality traits, voice tenets and writing craft. It calls out where StoryBrand and the AWS brand naturally agree — a guide and a champion are the same move — and flags the places where the clearest possible line costs some brand character, showing both options rather than silently choosing. Visual questions like slide colour are marked out of scope and left to the brand team.

The audit and the brand check are separate model calls from the classification, run at the same time. If one comes back unusable you keep everything else, and the panel says which part was unavailable rather than showing a blank section that reads like a clean verdict. An outline's bullet and its sub-points are treated as one unit, so a nested list doesn't become a wall of one-line colour changes.

**The view is read-only, and deliberately so.** Hive isn't a script editor — you revise in whatever you actually write in, then re-upload. Uploading a file Hive has analysed before automatically links the new analysis to the previous one and labels it "Revision 2 of 2", so you can see whether a rewrite fixed the section it was meant to. Pasted text is never chained, since it has no filename to match on. **Re-analyse** re-runs the model over the same text, which is useful for switching model or when a classification looks wrong.

Analyses are saved locally, listed newest-first with a colour bar showing the shape of the story, and searchable by phrase — not just by name, so you can find a keynote by something said in it. Everything except the one analysis call works offline. **Export** writes a single self-contained HTML file with no external references, so it renders identically on someone else's machine or in two years.

Classification is not deterministic, which is why each analysis is stored rather than recomputed: what you saw yesterday is what you see today. Re-analysing the same script can move a transitional paragraph between elements, and every paragraph is assigned one — there is no "unclassified" state, so a purely structural line like "Let's jump in." will land somewhere.

## Agent Skills

18 bundled skills available in Settings → Skills:

| Category | Skills |
|---|---|
| Documents | `docx`, `pptx`, `xlsx`, `pdf` |
| Writing | `copywriting`, `copy-editing`, `doc-coauthoring` |
| Research | `research-first`, `customer-research`, `analysis-framework` |
| Strategy | `task-planner`, `launch-strategy`, `marketing-psychology`, `storybrand` (StoryBrand 2.0 + AWS brand voice) |
| Creative | `algorithmic-art`, `demo-storyboard` |
| Utility | `self-correction`, `web-browse` |

Skills are loaded on demand — the Work tab agent activates them when your task matches. Swarm agents have skills pre-assigned per role.

Create custom skills in Settings → Skills → New Skill. Each skill is a `SKILL.md` file with YAML frontmatter and markdown instructions.

**When a bundled skill is updated**, Hive carries the change forward without ever overwriting your edits. If you have not touched your copy, it is replaced silently — there is nothing to reconcile, so you are not asked. If you have edited it, or if it predates this mechanism and Hive cannot tell, your copy is left exactly as it is and the skill's row shows an update badge with two options: keep yours, or take the new version. Taking it saves your copy as `SKILL.md.backup-<version>` first, so the choice is reversible. Declining is remembered, so you are not asked about that version again.

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

### Live AWS Setup Check test (manual)

`tests/integration/setup-check-live.js` calls Setup Check's real resource-creation
functions against real AWS. Like the Mantle check above, it exists because the unit
tests mock the AWS SDK entirely — they verify Hive sends what Hive *intends* to send,
but never that AWS still accepts it. That gap let a real failure reach a user: on a
brand-new install, creating the Web Search Gateway died on
`ValidationError: Value at 'description' failed to satisfy constraint`, because the
IAM role's description contained an em dash (AWS permits only printable ASCII and
Latin-1 in that field).

It covers the two Setup Check paths that send free-text metadata to AWS — the IAM
role (`CreateRole`) and AgentCore Memory (`CreateMemory`) — since those are the only
ones exposed to that class of bug. The transcription buckets are excluded: `CreateBucket`
has no free-text field, and throwaway buckets would pollute a global namespace for no
coverage gain.

```bash
npm run test:integration:aws                     # dry run — reports what it would do, creates nothing
ALLOW_AWS_WRITES=1 npm run test:integration:aws  # actually create, verify, and clean up
ALLOW_AWS_WRITES=1 INCLUDE_MEMORY=1 npm run test:integration:aws   # also test Memory (billable)
```

Credentials come from the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`,
optionally `AWS_SESSION_TOKEN`), never from Hive's own encrypted store — `safeStorage`
is bound to the signed app's identity, and a test has no business decrypting it. It
exits 0 with an explanation if credentials are absent, so it never blocks normal
development; set `REQUIRE_AWS_CREDS=1` to make that a hard failure instead.

**Safety.** Testing the real path means using the real, hardcoded resource names, so
pre-existence is checked first: anything that already exists is verified and reported
but never deleted, and only resources this run created are cleaned up. Creation
additionally requires `ALLOW_AWS_WRITES=1`, so nothing is provisioned by accident. If
interrupted between create and delete, the leftover is exactly the role Setup Check
would have created legitimately, and the next run treats it as pre-existing.

Needs `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `iam:DeleteRole`,
`iam:DeleteRolePolicy`, plus `bedrock-agentcore:CreateMemory`/`DeleteMemory` for the
memory check.

**Why this isn't in CI.** Unlike the Mantle check, this one is manual, and that's a
constraint rather than an oversight — worth recording so nobody "fixes" it in a way
that gets reverted.

Running it in GitHub Actions needs real AWS credentials in the account, and the two
ways to get them are both closed off here. Long-lived access keys are the wrong answer
for a permission set that includes `iam:CreateRole` and `iam:PutRolePolicy`, which
together let the holder mint an administrator role — that's the highest-value secret in
the repo, guarding a privilege-escalation path. And GitHub OIDC federation, which is
the correct pattern on a normal AWS account, is not available on an Amazon-managed one:
creating an IAM OIDC provider for `token.actions.githubusercontent.com` triggers Cloud
Security's IAMOpenIdProvider campaign (a critical finding with a Sev-2.5 ticket),
external identity providers aren't on the approved list, and unapproved providers are
deleted automatically. There is currently no sanctioned path for third-party CI to
authenticate into an Amazon AWS account.

The available option is a CodeBuild-hosted GitHub Actions runner, where the runner is
compute inside the account and credentials come from a role attached to it rather than
from an external identity provider. That's a deliberate piece of infrastructure work
with a security consideration attached — this repository is public, and a self-hosted
runner reachable from a fork pull request would be arbitrary code execution inside the
AWS account. It is not set up, and shouldn't be without scoping the runner to the
scheduled workflow only.

In the meantime the specific failure that motivated this test — an em dash in an IAM
`Description` — is covered offline and by construction; see below.

### AWS text constraints (offline)

AWS rejects free-text metadata fields — an IAM role `Description`, an AgentCore Memory
`description` or `name` — that contain anything outside printable ASCII and Latin-1.
This is easy to hit by accident, because an em dash, a curly quote or an ellipsis comes
free from any editor, and the failure surfaces only as a `ValidationError` from a real
AWS call. It reached a user once: a brand-new install could not create the Web Search
Gateway, because the role description Hive sends contained an em dash.

`src/main/awsText.js` fixes the mechanism — `toAwsText()` transliterates typography and
drops what it can't convert, deliberately lossy on the grounds that a mangled
description is far better than a failed resource creation.

`tests/main/awsTextInvariant.test.js` then enforces the rule against the source rather
than against copies of it. It scans every `new *Command({ ... })` construction under
`src/main` and requires each free-text field to be either wrapped in `toAwsText()` or
provably clean, and separately checks that the literals actually present in the source
survive that wrapping unchanged. Reading the literals out of the source is the point:
the earlier tests pasted their own copies of those strings, so they verified a duplicate
of the code and a newly-added description would have sailed past a green suite exactly
as the original did.

That closes the class offline, with no credentials and no AWS calls. The live check
above still covers what unit tests structurally cannot — whether AWS's own validation
rules have changed — which is why it exists and why it stays manual.

### Project Structure

```
src/
├── main/models/       # Backend: orchestrator, tools, skills, rubrics, settings
├── renderer/          # Frontend: tab controllers, UI logic
├── pages/             # HTML
└── styles/            # CSS
skills/                # 18 bundled agent skills
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

