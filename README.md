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

Download: [Box folder](https://amazoncorporate.box.com/s/rwc0pbifx50uf7g2xi8mxanahq5qnljn)

| Platform | File |
|---|---|
| macOS (Intel & Apple Silicon) | `Hive-2.10.0-universal.dmg` |
| Windows x64 | `Hive-Setup-x64.exe` |
| Windows ARM64 | `Hive-Setup-arm64.exe` |

### Build from Source

```bash
git clone https://github.com/cmatskas/hive-xplat.git
cd hive-xplat
npm install
npm start          # development
npm run build      # production (all platforms)
```

### First Launch

1. Open Settings → Credentials
2. Paste your AWS credentials (auto-detected from any format)
3. Click "Save & Test Credentials"
4. Start using the Work tab

## AWS Permissions Required

Your IAM user/role needs access to:
- **Bedrock Mantle**: A long-term [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) configured in Settings → Mantle API Key. All model invocation (Work, Chat, Swarm) goes through Amazon Bedrock's Mantle endpoint via this key — no IAM-based `InvokeModel`/`Converse` permissions are needed for model calls themselves.
- **Transcribe**: `StartTranscriptionJob`, `GetTranscriptionJob` (for Transcribe tab)
- **S3**: `GetObject`, `PutObject`, `DeleteObject` on your bucket (for Transcribe tab)
- **AgentCore**: `bedrock-agentcore:StartCodeInterpreterSession`, `bedrock-agentcore:InvokeCodeInterpreter`, `bedrock-agentcore:StopCodeInterpreterSession`, `bedrock-agentcore:StartBrowserSession`, `bedrock-agentcore:StopBrowserSession` (for Work/Swarm code execution and web browsing)
- **AgentCore Gateway**: `bedrock-agentcore:CreateGateway`, `bedrock-agentcore:CreateGatewayTarget`, `bedrock-agentcore:ListGateways`, `bedrock-agentcore:GetGateway`, `bedrock-agentcore:ListGatewayTargets`, `bedrock-agentcore:GetGatewayTarget`, `bedrock-agentcore:InvokeGateway`, `bedrock-agentcore:InvokeWebSearch` (for web search via AgentCore Web Search Tool) — see [AgentCore Gateway Setup (Web Search)](#agentcore-gateway-setup-web-search) below for the one-time role Hive needs to create the Gateway itself.

<details>
<summary>Optional permissions</summary>

- **SageMaker**: `InvokeEndpoint` (for SDXL image generation)
</details>

## AgentCore Gateway Setup (Web Search)

The Work and Swarm tabs' web search tool runs through an AgentCore Gateway (AWS's managed MCP tool endpoint) with a Web Search connector target. Hive creates and manages this Gateway automatically — there is no separate deployment script — but the **first time** it's created in a given AWS account/region, it needs an execution role that doesn't exist yet.

**One-time setup:**

1. Create an IAM role (e.g. `hive-web-search-gateway`) with this trust policy so AgentCore can assume it:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
       "Action": "sts:AssumeRole"
     }]
   }
   ```
2. Attach a permissions policy granting the role what it needs to run the Gateway and its Web Search target, e.g.:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": [
         "bedrock-agentcore:InvokeGateway",
         "bedrock-agentcore:InvokeWebSearch"
       ],
       "Resource": "*"
     }]
   }
   ```
3. Paste the role's ARN into Settings → Web Search → Gateway Execution Role ARN, then save. Hive creates the Gateway (`hive-web-search`) and its Web Search target on first use — this can take up to a minute or two.
4. Once the Gateway is `READY`, the role ARN is no longer needed for subsequent app launches — Hive finds and reuses the existing Gateway by name in that account/region.

Web search is currently only available in `us-east-1` — Hive always creates and calls the Gateway in that region regardless of your configured `region` setting.

If Gateway creation or search calls fail, check Settings → Web Search for the current status and a retry button — the underlying error (permissions, throttling, region mismatch) is surfaced there.

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

Settings → Models lets you manage Bedrock models and assign pipeline roles:

| Role | Purpose | Default |
|---|---|---|
| Creator | Writing, quality evaluation — best model | Claude Opus 4.6 |
| Worker | Research, planning, editing — balanced | Claude Sonnet 4.6 |
| Formatter | Document generation — cheapest capable | Claude Haiku 4.5 |

All models are invoked via Amazon Bedrock's Mantle endpoint — Claude models go through Mantle's Anthropic Messages API, other models (e.g. GPT-5.x, Google Gemma) through Mantle's OpenAI-compatible API. Add or remove models and reassign roles from the UI.

> **Known issue — xAI Grok models are not currently supported.** If you add a `xai.grok-*` model in Settings, calls to it will fail. Mantle lists these models as available (`GET /v1/models` returns them with `"status":"available"`), but every invocation route Hive tested (`/v1/chat/completions`, `/openai/v1/chat/completions`, `/openai/v1/responses`) returns either a "model isn't supported on this route" validation error or a 500 internal server error. This looks like a Mantle-side model registration/serving issue rather than something fixable from the client side — it's been reported to the Mantle team. Don't add Grok models until this is resolved upstream.

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

