# Release Notes

## v2.9.0

### Rebranding
- **Renamed to Hive** — app name, icons, window titles, and all branding updated from Transcribely to Hive
- **New app icon** — honeycomb icon across all platforms (macOS icns, Windows ico, all PNG sizes)

### New Features
- **Showflow tab** — run-of-show editor for keynotes, concerts, plays, and any live event. Drag elements from the palette, reorder with drag handles, park items for later, export to Word/Excel. Supports multiple show types with chapter marks and duration tracking.

## v2.8.0

### New Features
- **Splash screen** — Particle constellation splash screen on startup while credentials are validated in the background. Frameless 600×400 window with animated neural-network particle field.
- **Startup auth gate** — App now validates AWS credentials on every launch. Missing or invalid credentials redirect to the credentials page before the main app loads; valid credentials proceed directly to the app.
- **Simplified credentials page** — Stripped down to form fields + paste button only. On successful connection the app navigates automatically — no "Continue" button required. Error toast on failure.
- **Model drag-and-drop reordering** — Models in Settings → Models can now be reordered via drag and drop. Order is persisted and reflected in all model dropdowns.

## v2.7.12

### Bug Fixes
- **Work tab — New Chat no longer inherits workspace** — Starting a new conversation now resets `workingDirectory` and hides the workspace badge. Previously, the workspace directory from the previous chat persisted.
- **Settings → Credentials tab fully functional** — Credentials failed to load, paste, and save because `SettingsTab.init()` was silently skipped when an earlier tab init threw. Tab initialization is now isolated with per-tab try/catch so one failure doesn't cascade.
- **Work tab — fixed attach/workspace regression** — `init()` is now `async`, fixing a syntax error that prevented the entire `workTab.js` module from loading and broke all attach buttons.
- **Work tab — stop copying input files to ~/Downloads** — Files the agent reads via `read_local_file` are no longer auto-saved to the Downloads folder at the end of a run. The auto-save safety net now only captures agent-generated outputs.

### Features
- **Work tab — conversation history restore** — Opening a saved conversation now rehydrates messages from disk instead of showing a greeting.

## v2.7.8

### Bug Fixes
- **Fixed macOS auto-update download** — `electron-updater` on macOS requires a `.zip` of the app bundle, not the DMG. Added `zip` as a build target; the zip is now included in GitHub releases alongside the DMG. The DMG remains for fresh installs; the zip is used for in-app updates.

## v2.7.7

### UI
- **Credentials tab** — Swapped button order: Paste is now first (left), Save & Test is second (right).

## v2.7.6

### Bug Fixes
- **Fixed corrupt macOS DMG in CI** — The publish step was rebuilding the DMG after notarization, stripping the notarization ticket. Now uploads the already-notarized DMG directly via `gh release upload`.

## v2.7.5

### Infrastructure
- **Switched to GitHub Releases for distribution** — Replaced S3 as the publish target. Artifacts (DMG, Windows installers, update manifests) are now attached to GitHub Releases. Auto-updater checks GitHub directly — no AWS credentials required for updates.
- **Simplified CI workflow** — Removed OIDC/S3 steps; both macOS and Windows jobs now use `GITHUB_TOKEN` (built-in, no secrets needed).
- **Simplified auto-updater** — Removed AWS credential injection; GitHub releases are public.

## v2.7.4

### Bug Fixes
- **Work tab file/workspace removal** — Added remove button to workspace directory badge; files and workspace can now be cleared from the prompt input.
- **Transcription error recovery** — On failure, the upload zone is restored immediately so users can retry without refreshing. Error message now includes a "Try again" button. Modal no longer blocks the UI after an error.
- **Auto-updater credentials** — AWS credentials are now injected before each update check so the app can read from the private S3 bucket.
- **Check for Updates menu** — Added "Check for Updates..." to the macOS app menu.



### Web Search Fix
- **Replaced Google search with Jina + DuckDuckGo** — Google was blocking automated searches from AgentCore Browser. Web search now uses Jina Search API (when configured) for high-quality results with full article content, or DuckDuckGo as a zero-config fallback. Affects both Work and Swarm agents.
- **Jina API Key support** — Optional encrypted API key field in Settings → Credentials. Autosaves on edit, encrypted at rest via OS keychain (safeStorage). Get a free key at [jina.ai](https://jina.ai).

### Work Tab — Conversation Reliability
- **Immediate save on first message** — Conversations are now saved to history as soon as the user sends a message, before the agent responds. Previously, conversations were only saved after the full response, causing data loss if the user started a new chat mid-response.
- **Partial response preservation** — If the agent errors mid-stream or the user switches conversations while the agent is working, any partial streaming content is captured and saved.
- **Animated working indicator** — In-progress conversations now show a pulsing blue dot in the sidebar instead of a static icon.

### Bug Fixes
- **Fixed file upload crash** — AgentCore Code Interpreter `writeFiles` API now uses the correct `blob` field (was `content`), fixing `ValidationException: path field and one of (text, blob) field is required` when uploading PPTX files.
- **Fixed document byte serialization** — Replaced `Uint8Array` with `Buffer.from` for Bedrock Converse document blocks, preventing serialization issues with SDK v3.1001.0+ for PDF, DOCX, and XLSX uploads.
- **Fixed proactive directory scanning** — Agent no longer scans `~/Documents/Transcribely/` unprompted when memory context is loaded. Added explicit instruction to wait for user direction before exploring the filesystem.

## v2.7.1

### UI Improvements
- **Compact file attachment chips** — Replaced card-based file lists with inline pill/chip UI across Chat, Work, and Swarm tabs. Files now render as small 26px chips inside the input card with truncated names, reducing vertical space by ~75%.
- **Attach button badge** — The `+` attach button now shows a count badge when files are attached for at-a-glance awareness.

### Bug Fixes
- **Notification errors** — Fixed notification-related errors in main process.

## v2.7.0

### Logging Overhaul
- **Replaced custom logger with `electron-log`** — Zero-dependency, 95KB library with auto-rotation, standard log levels, and native `electron-updater` compatibility. Fixes `this._logger.info is not a function` crash.
- **Structured logging across all backend models** — 27 log statements with consistent prefixes (`[swarm:id]`, `[work:id]`, `[browser]`, `[code-interpreter]`, `[skills]`, `[memory]`) for easy filtering.
- **Swarm pipeline observability** — Pipeline start/complete, agent handoffs, quality gate decisions (PASS/REVISE/FAIL with scores), and agent errors now logged.
- **Session lifecycle tracking** — Code Interpreter and Browser session start/stop events logged with session IDs.
- **Tool execution errors** — Work tab tool failures logged with session context.
- **Skills init summary** — Skill count and load failures logged at startup.
- Logs written to `~/Library/Logs/Transcribely/main.log` (macOS) / `%USERPROFILE%\AppData\Roaming\Transcribely\logs\main.log` (Windows).

### Bug Fixes
- **Missing peer dependencies** — Added `@modelcontextprotocol/sdk` and `@popperjs/core` as explicit dependencies. Fixes `ERR_MODULE_NOT_FOUND` crash on launch and Bootstrap tooltip rendering in Settings.

## v2.6.0

### Video Analysis & Storyboard Assets
- **Nova Premier video analysis** — Demo Analyst agent sends video to `us.amazon.nova-premier-v1:0` via Converse API for multimodal analysis. Videos ≤25MB sent as bytes, >25MB uploaded to S3.
- **Keyframe extraction** — OpenCV extracts 1 frame per 2 seconds (max 60) in the sandbox. Frame manifest with paths and timestamps flows through the pipeline.
- **Frame-embedded storyboard decks** — Scene Writer references specific frames, Formatter embeds actual screenshots in PPTX slides via `add_picture()`.

### System Notifications
- Native OS notifications (macOS Notification Center / Windows toast) for: review pause, input request, pipeline complete, pipeline error.
- Clicking a notification brings Transcribely to focus.

### Work Tab Reliability
- **Per-conversation sandbox persistence** — Sandbox lives across all messages in the same conversation. Files from message 1 are available in message 5. No more re-uploading.
- **Per-conversation file isolation** — Attached files stored per-session. Switching conversations swaps file state. No cross-conversation bleed.
- **Document generation reliability** — System prompt requires skill activation before doc creation, retries on code errors, single code call for documents. Sandbox timeout increased to 2 hours.
- **Tilde expansion** — `~/Documents/Transcribely/file.docx` now resolves correctly in `save_file_locally`.

### Swarm Tools Audit (6 fixes)
- **File uploads fixed** — `uploadFile()` (nonexistent) replaced with proven base64+executeCode pattern. File attachments now actually reach the sandbox.
- **`save_file_locally` fixed** — Was calling nonexistent `downloadFile()`. Now uses `readFileBase64` + Buffer. Added path security checks and Windows double-path fix.
- **`generate_image` wired** — SageMaker SDXL primary, Nova Canvas fallback. Images saved to sandbox for document embedding.
- **`list_directory` added** — Agents can browse local directories.
- **Formatter verification** — `_verifyLocalSave()` checks if the file actually exists on disk after formatter agents run.

### Skill Updates
- **docx**: Line numbers, header with document title, footer with "Amazon Confidential" + page number. Must pip install first, single code call, never describe.
- **pptx**: Must pip install first, single code call, never describe.

### Bug Fixes
- IPC file dialog for swarm attachments — fixes empty `File.path` with `contextIsolation: true`
- `@opentelemetry/api` added as direct dependency — fixes Windows launch crash (was peer dep of Strands SDK, missing from asar)
- Sandbox not torn down for conversations with agents mid-task
- `sessionStarted` now tracks sessions started for file extraction (cleanup leak fix)

## v2.5.0

### Swarm — Multi-Agent Content Pipelines
- **4 pipeline templates**: Article/Blog Post, Keynote/Presentation, Speech/Talk, Demo/Storyboard
- **Sequential agent execution** with Strands SDK: research → plan → quality gate → write → edit → quality gate → format
- **Per-agent model selection** via capability roles (creator/worker/formatter)
- **Checkpoint persistence** to disk — pipeline state survives interruptions
- **Autonomy modes**: Supervised (review at checkpoints), Guided (review + auto-resolve low-risk), Autonomous (fully hands-off)
- **Tool integration**: web browsing, code execution, file I/O via AgentCore Browser and Code Interpreter

### Quality Rubric System
- **Rubric-based quality gates** replacing free-text PASS/REVISE with structured JSON evaluation
- **Weighted binary criteria** with penalty support (negative weights subtract when triggered)
- **Per-template rubrics**: 12-15 criteria each covering scope, fidelity, authenticity, and craft
- **Three-tier decisions**: PASS (≥0.75), REVISE (with targeted feedback), FAIL (below floor)
- **CANNOT_ASSESS/SKIP** for criteria that don't apply to a specific brief
- **Rubric score card UI** — visual pass/fail breakdown in quality gate output cards
- **Brief-specific rubric adaptation** — one LLM call specializes generic criteria to the specific brief
- **Historical feedback injection** — past failure patterns injected into writer/editor prompts
- **Competitor reference penalty** (-3 weight) across all templates

### AWS Content Guidelines
- Embedded in `research-first`, `copy-editing`, and `copywriting` skills
- Prioritize AWS/Amazon customer references from public sources
- Sweep 9 (Reference & Attribution Audit) in copy-editing
- Placeholder format for missing references: `[CUSTOMER REFERENCE NEEDED: description]`

### Settings — Models Tab
- Add, remove, and manage Bedrock models from the UI
- Assign swarm pipeline roles (creator/worker/formatter) per model
- One model per role enforced — reassigning auto-clears duplicates
- Updated defaults: Claude Opus 4.6, Sonnet 4.6, Haiku 4.5, DeepSeek V3.2, Mistral Large 3, Llama 4 Maverick 17B

### Settings — Quality Analytics Dashboard
- Summary cards: total runs, pass rate, avg score, errors
- Per-template breakdown with score bars
- Criteria heatmap: color-coded pass/fail rates sorted by worst performers
- Actionable insights: heuristic-based tips for rubric and prompt tuning

### New Skills (17 total)
- `demo-storyboard` — scene card format, narrative arc, AWS demo guidelines
- `algorithmic-art` — p5.js generative art with interactive viewer
- `pdf` — read, create, merge, split, extract tables, watermark, encrypt

### UI/UX
- **Nav reorder**: Work → Swarm → Transcribe → Chat
- **Work tab as default** on app launch
- **Sticky navbar** — stays visible on scroll
- **Stepper redesign**: numbered nodes, green glow pulse, connecting progress lines
- **Status bar**: per-agent activity messages during pipeline execution
- **Brief persistence**: collapsible card preserves original prompt during pipeline
- **Auto-expanding textarea** for swarm brief input
- **Renamed**: Analyze → Chat
- **Skills subtitle**: "Awesome skills for your agents"
- Removed startup "Upload a file" toast

### Infrastructure
- **CI**: GitHub Actions upgraded to checkout@v6 + setup-node@v6 (Node 24 runtime), `lts/*`
- **All test suites fixed**: 8/8 passing, 124 tests, 5 skipped
- **Settings-driven model registry** with runtime resolution via `resolveModels()`
- **Auto-cleanup**: agent output files deleted after successful pipeline completion
- **Fresh orchestrator per pipeline run** — ensures current AWS credentials

### Bug Fixes
- Fixed streaming event path (`modelContentBlockDeltaEvent` + `inner.delta.text`)
- Fixed web tool (use `navigate()` + `getPageContent()` instead of nonexistent `browse()`)
- Fixed handoff echo (brief in system prompt only, not repeated in every user message)
- Fixed empty output fallback (don't silently replace with brief)
- Fixed orchestrator lifecycle (fresh per run, reuse for continue/cancel)
- Fixed guided mode review pause (continue signal reaches correct orchestrator instance)
- Added try/catch to all swarm tools — surfaces real errors instead of silent failures
- Added tilde expansion for `save_file_locally` paths
- Fixed Sonnet 4.6 inference profile ID
- Fixed double `>` in work-page HTML
- Null-safe nav event bindings (recovers 25 pre-existing test failures)

## v2.4.0
- **Skills Management UI**: New "Skills" tab in Settings for reviewing, editing, deleting, and creating agent skills
  - Inline SKILL.md editor with monospace textarea
  - Create new skills with template scaffolding
  - Enable/disable toggle per skill
  - "Always-on" badge for auto-activate skills
  - Open skills folder button for direct filesystem access
- **11 New Agent Skills** adapted from GSD, marketingskills, and community sources:
  - `customer-research` — Analyze transcripts, meeting notes, and interviews using JTBD extraction framework
  - `copy-editing` — Eight Sweeps review framework with AI de-slop detection (22 patterns, vocabulary tiers, tone-aware calibration)
  - `copywriting` — Marketing copy and keynote narrative framework with dynamic scoping and 6 foundational questions
  - `doc-coauthoring` — 3-stage collaborative document creation (Context Gathering → Refinement → Reader Testing)
  - `launch-strategy` — ORB framework and 5-phase launch planning
  - `marketing-psychology` — Behavioral science mental models for persuasive messaging
  - `analysis-framework` — Structured analysis frameworks (goal-backward, trade-off matrix, decision framework)
  - `research-first` — Research-before-action protocol for unfamiliar domains
  - `task-planner` — Structured task decomposition for complex multi-step requests
  - `self-correction` — Auto-fix runtime errors, install missing libraries, adapt to data formats
- **Skill Auto-Activate**: Skills can declare `auto-activate: "true"` in frontmatter to inject their full instructions into every agent conversation without requiring manual activation
- **Lazy Skill Loading**: Skills now load only frontmatter (1KB) at startup; full body loaded on-demand when activated — improves startup time with many skills
- **Skill Discovery**: Skills discovered from project (`.agents/skills/`), user (`~/.agents/skills/`), and app-bundled directories with priority ordering

## v2.2.0
- **Cancellation**: Send button toggles to a red stop button during agent/Bedrock execution
  - Work tab: cancels the running agent mid-stream, preserving partial output
  - Analyze tab: cancels the Bedrock streaming response
  - Cost-efficient — billed only for tokens generated before cancellation
- **Auto-Updates**: Automatic update notifications via S3
  - App checks for updates 10 seconds after launch and every 4 hours
  - Blue banner appears when an update is available or downloaded
  - "Restart & Install" button applies the update immediately
  - Windows: fully automatic. macOS: requires Apple Developer signing (pending)

## v2.0.1
- **Agent Memory**: Short-term (STM) and long-term (LTM) memory via AWS Bedrock AgentCore Memory
  - Toggle memory on/off without destroying the memory resource
  - Per-installation user isolation via unique IDs
  - Automatic LTM extraction on new chat and app quit
  - Agent is context-aware and references past conversations when memory is available
- **Conversation Management**: Claude-style history sidebar
  - Star/favourite conversations for quick access
  - Rename conversations via modal dialog
  - Delete with confirmation prompt
  - Grouped sections: Starred, Today, Yesterday, This Week, Older
  - Context menu (three-dots) on each conversation
- **Image Generation**: Flexible image generation with provider fallback
  - Primary: SageMaker SDXL endpoint (optional, configurable in settings)
  - Fallback: Amazon Nova Canvas via Bedrock (default when no SageMaker endpoint configured)
  - New settings panel for endpoint name and inference component
- **Settings Redesign**: In-page settings with tabbed layout (Credentials, Configuration, About)
  - Settings persist correctly across all fields including memory and image generation
- **Theme-Aware Icons**: Greeting icon switches between light/dark variants based on theme
- **Bug Fixes**:
  - Memory settings no longer wiped when saving other settings
  - Memory toggle correctly reflects persisted state on app load
  - Re-enabling memory no longer attempts to recreate the AWS resource

## v2.0.0
- PowerPoint (`.pptx`/`.ppt`) file upload and analysis support
- Content extracted automatically from PowerPoint files via code interpreter (python-pptx)
- SageMaker SDXL endpoint support for image generation
- Automatic fallback to Amazon Nova Canvas when no SageMaker endpoint is configured
- New Image Generation settings panel (endpoint name + inference component)

## v1.0.0
- Initial release
- AWS Transcribe integration
- AWS Bedrock AI analysis
- Knowledge Base support
- Cross-platform desktop app
- Dark/light theme support
