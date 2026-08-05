# Hive

An Electron desktop app that combines AI models served via Amazon Bedrock's Mantle endpoint with AWS Transcribe for intelligent media transcription, AI-powered content creation, and multi-agent collaborative pipelines.

## Features

- 🤖 **Work Tab** — AI agent with code execution, web browsing, file I/O, image generation, and persistent memory via AgentCore
- 🐝 **Swarm Tab** — Multi-agent pipelines for articles, keynotes, speeches, and demo storyboards with quality rubric evaluation
- 💬 **Chat Tab** — Conversational AI analysis with conversation history and file attachments
- 🎵 **Transcribe Tab** — Audio/video transcription via AWS Transcribe with speaker labels and timestamps
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
3. **Setup Check runs automatically.** The first time credentials resolve successfully, Hive checks your account for a few things it needs (Web Search Gateway role, transcription S3 bucket, AgentCore Memory) and shows a checklist for anything missing — see [Setup Check](#setup-check) below. Create what you need, skip what you don't, right from the app.
4. **Add your Mantle API key.** Generate a long-term [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) in the AWS console and paste it into Settings → Configuration → Mantle API Key — this is the one thing that can't be automated, since it's a secret tied to your own account.
5. **Start using the Work tab.**

If your credentials happen to resolve to Hive's shared admin AWS account, an **Admin** tab also appears automatically in Settings — see [Admin Tab](#admin-tab-aws-keynote-only) below. Regular users never see this tab and don't need to do anything with it.

## AWS Permissions Required

The list below documents what Hive actually calls, for anyone auditing or scoping a dedicated IAM role. In practice, most Hive users authenticate with an Admin-level role (via Isengard/Merlon) that already covers all of it — this list isn't a manual grant checklist to walk through, just a reference for what each feature needs under the hood:
- **Bedrock Mantle**: A long-term [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) configured in Settings → Mantle API Key. All model invocation (Work, Chat, Swarm) goes through Amazon Bedrock's Mantle endpoint via this key — no IAM-based `InvokeModel`/`Converse` permissions are needed for model calls themselves.
- **Transcribe**: `StartTranscriptionJob`, `GetTranscriptionJob` (for Transcribe tab)
- **S3**: `GetObject`, `PutObject`, `DeleteObject` on your bucket (for Transcribe tab)
- **AgentCore**: `bedrock-agentcore:StartCodeInterpreterSession`, `bedrock-agentcore:InvokeCodeInterpreter`, `bedrock-agentcore:StopCodeInterpreterSession`, `bedrock-agentcore:StartBrowserSession`, `bedrock-agentcore:StopBrowserSession` (for Work/Swarm code execution and web browsing)
- **AgentCore Gateway**: `bedrock-agentcore:CreateGateway`, `bedrock-agentcore:CreateGatewayTarget`, `bedrock-agentcore:ListGateways`, `bedrock-agentcore:GetGateway`, `bedrock-agentcore:ListGatewayTargets`, `bedrock-agentcore:GetGatewayTarget`, `bedrock-agentcore:InvokeGateway`, `bedrock-agentcore:InvokeWebSearch` (for web search via AgentCore Web Search Tool)
- **Setup Check** (see below): `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `s3:CreateBucket`, `bedrock-agentcore:GetMemory`, `bedrock-agentcore:CreateMemory` — only used by the in-app Setup Check to provision the items above on your behalf; not needed for Hive's normal runtime operation

<details>
<summary>Optional permissions</summary>

- **SageMaker**: `InvokeEndpoint` (for SDXL image generation)
</details>

## Setup Check

The first time you launch Hive after saving AWS credentials, it checks your account for a few things it needs — a Web Search Gateway execution role, a transcription S3 bucket, and an AgentCore Memory resource — and shows a checklist for anything missing. Each item is independent: create only what you need, in any order, from directly inside the app. No AWS console required.

- **Web Search Gateway**: creates the IAM role (`hive-web-search-gateway`) that lets AgentCore Gateway run the Web Search Tool target. The Gateway itself is still created on first web search use, exactly as before — this just removes the manual "open the console and create a role" step.
- **Transcription Storage Bucket**: creates the S3 bucket configured in Settings → Configuration, if it doesn't already exist.
- **AgentCore Memory**: creates a Memory resource with semantic + summarization strategies for Work tab conversation memory.

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

**Known issue — xAI Grok models are not currently supported.** If you add a `xai.grok-*` model in Settings, calls to it will fail. Mantle lists these models as available (`GET /v1/models` returns them with `"status":"available"`), but every invocation route Hive tested (`/v1/chat/completions`, `/openai/v1/chat/completions`, `/openai/v1/responses`) returns either a "model isn't supported on this route" validation error or a 500 internal server error. This looks like a Mantle-side model registration/serving issue rather than something fixable from the client side — it's been reported to the Mantle team. Don't add Grok models until this is resolved upstream.

## Development

```bash
npm test              # unit tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run test:bedrock  # integration tests (requires AWS credentials, incurs costs)
```

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

