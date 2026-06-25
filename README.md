# Hive

An Electron desktop app that combines AWS Bedrock AI models with AWS Transcribe for intelligent media transcription, AI-powered content creation, and multi-agent collaborative pipelines.

## Features

- 🤖 **Work Tab** — AI agent with code execution, web browsing, file I/O, image generation, and persistent memory via AgentCore
- 🐝 **Swarm Tab** — Multi-agent pipelines for articles, keynotes, speeches, and demo storyboards with quality rubric evaluation
- 💬 **Chat Tab** — Conversational AI analysis with conversation history, knowledge base integration, and file attachments
- 🎵 **Transcribe Tab** — Audio/video transcription via AWS Transcribe with speaker labels and timestamps
- 🧠 **17 Agent Skills** — Copy editing, copywriting, research, marketing psychology, document creation, generative art, and more
- 🎯 **Quality Rubrics** — Weighted criteria with penalty scoring, brief-specific adaptation, and adaptive learning from past runs
- ⚙️ **Model Management** — Configure Bedrock models and assign pipeline roles (creator/worker/formatter) from the UI
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
- **Bedrock**: `InvokeModel`, `InvokeModelWithResponseStream`, `ListFoundationModels`
- **Transcribe**: `StartTranscriptionJob`, `GetTranscriptionJob` (for Transcribe tab)
- **S3**: `GetObject`, `PutObject`, `DeleteObject` on your bucket (for Transcribe tab)
- **AgentCore**: `bedrock-agentcore:StartCodeInterpreterSession`, `bedrock-agentcore:InvokeCodeInterpreter`, `bedrock-agentcore:StopCodeInterpreterSession`, `bedrock-agentcore:StartBrowserSession`, `bedrock-agentcore:StopBrowserSession` (for Work/Swarm code execution and web browsing)
- **AgentCore Gateway**: `bedrock-agentcore:CreateGateway`, `bedrock-agentcore:CreateGatewayTarget`, `bedrock-agentcore:ListGateways`, `bedrock-agentcore:GetGateway`, `bedrock-agentcore:ListGatewayTargets`, `bedrock-agentcore:GetGatewayTarget`, `bedrock-agentcore:InvokeGateway`, `bedrock-agentcore:InvokeWebSearch` (for web search via AgentCore Web Search Tool)

<details>
<summary>Optional permissions</summary>

- **Knowledge Base**: `ListKnowledgeBases`, `RetrieveAndGenerate`
- **SageMaker**: `InvokeEndpoint` (for SDXL image generation)
</details>

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

**Video analysis (Demo template):** Attach an `.mp4` video and the Analyst agent uses Amazon Nova Premier to analyze it frame-by-frame. Keyframes are extracted and embedded directly into the storyboard deck.

<details>
<summary>Quality system</summary>

- Each template has a weighted rubric (12–15 criteria) with penalty scoring for competitor references
- Rubrics adapt to your specific brief before evaluation
- The system learns from past runs — frequently-failing criteria get extra attention in future pipelines
- View pass rates, criteria heatmaps, and insights in Settings → Analytics
</details>

## Chat Tab

Conversational AI for analysis and Q&A. Lighter than the Work tab — no code execution or file generation, but supports knowledge base integration for RAG.

- Attach documents for the model to analyze inline
- Connect a Bedrock Knowledge Base in Settings for retrieval-augmented generation
- Full conversation history with save/load
- Choose any configured model (including DeepSeek, Mistral, Llama)

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
| Vision | Video analysis — multimodal | Amazon Nova Premier |

Additional models (DeepSeek V3.2, Mistral Large 3, Llama 4 Maverick) available for the Chat tab. Add or remove models and reassign roles from the UI.

## Development

```bash
npm test              # unit tests (8 suites, 124 tests)
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

