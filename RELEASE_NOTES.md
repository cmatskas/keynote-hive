# Release Notes

## v3.4.0

### Fixes
- **Hive is usable offline.** Going offline used to make the whole app unusable, and could destroy work without the user doing anything. All of it traced to one defect: `AWSValidator.quickValidate()` flattened every failure into `{ valid: false, errors: ['Invalid AWS credentials: ...'] }` and never threw, so `getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com` was indistinguishable from an expired session token. Three systems acted on that false signal:
  - **Startup routing** sent you to the credentials page, putting conversations, work history, skills and showflows — all of them plain files under the app's userData directory, needing no network whatsoever — behind a connection they don't require.
  - **The credential monitor's 10-minute poll** escalated it to "expired", which fires a critical *Session Expired* notification and then replaces the renderer with the credentials page. That discards unsaved Work tab state, attachments, and any in-flight UI. Closing a laptop lid or switching networks was enough to trigger it.
  - **The pre-send gates** in Work and Chat reported "AWS credentials are invalid or expired", sending users to Settings to fix credentials that were never broken.

  There was no connectivity detection anywhere in the codebase — no `navigator.onLine`, no `net.isOnline`, no `online`/`offline` listeners. Now:
  - **A shared error classifier** (`src/main/awsErrors.js`) separates transport failures from auth failures. The discriminator is whether an HTTP response came back at all: the AWS SDK attaches `$metadata.httpStatusCode` when it got one, while a genuine transport failure surfaces an OS errno (`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ENETUNREACH`, …) or an SDK timeout, often wrapped a few levels deep in a `cause` chain. `quickValidate()` now returns a third state, `{ valid: false, offline: true }`, and callers must treat it as "unknown, try again later" rather than "invalid".
  - **A connectivity monitor** (`src/main/models/connectivityMonitor.js`) uses `net.isOnline()` as the cheap gate, then confirms with an HTTPS `HEAD` against the regional STS endpoint before declaring a transition. The probe matters: `net.isOnline()` and `navigator.onLine` only report whether an interface is up, which is true on a captive portal or a VPN routing nowhere. Any HTTP status counts as reachable — a 403 from STS still proves DNS, TCP and TLS all worked. Transitions are debounced, because waking a laptop emits a burst of events that would otherwise re-broadcast and re-trigger reconnect work repeatedly.
  - **Startup boots into the main window** when stored credentials can't be verified only because we're offline. AWS clients are constructed before validation either way, so they start working the moment connectivity returns with no re-initialisation.
  - **A network blip no longer escalates to expiry.** The poll skips the STS round trip entirely when already known to be offline, treats `offline: true` as "pause, not expiry", and resumes — re-checking immediately rather than waiting up to another 10 minutes — when connectivity returns. This is the change that stops work being destroyed.
  - **Even a genuine expiry no longer destroys work unconditionally.** The banner and notification still fire, but the navigation that replaces the renderer is deferred while offline (where the user can't validate new credentials anyway) or while a caller vetoes it — currently a transcription mid-job, whose result would go down with the renderer. It runs once the veto lifts.
  - **A persistent offline banner** states plainly that Hive is offline, that local work is unaffected, and what's paused. Not dismissible while offline, since dismissing it would hide a condition with no other indicator.
  - **Network-dependent controls are disabled with an explanatory tooltip** and restored on reconnect (`src/renderer/offlineGuard.js`): Work/Chat send, Swarm run/continue/answer, the Transcribe upload zone and file input, Save & Test Credentials, Setup Check, web-search retry, memory connect/refresh/delete, and the Admin actions. Everything local stays enabled — conversation and work-history browsing, skills editing, settings save, showflow save/open/export, transcript download and copy, theme. The guard only restores controls it disabled itself, so a Send button disabled mid-request isn't wrongly re-enabled.
  - **Main-process guards as defence in depth.** Network-dependent IPC handlers call `ctx.assertOnline()` and fail in milliseconds with a clear message, so a control that slips past the renderer guard doesn't produce a 30-second SDK retry-and-timeout hang.
  - **Web search retries on reconnect.** `initializeWebSearch()` runs once at credential load; a launch while offline previously left it dead for the entire session with no retry, and the model silently fell back to scraping via `execute_code`. A network failure is also no longer recorded as a Gateway/permissions error, which sent users hunting for a problem that didn't exist.
- **Transcription survives a network outage or a mid-job credential expiry instead of failing.** A dropped connection used to throw from the status poll, fire a *Transcription Failed* notification, and discard the job — while it kept running and billing on AWS with no way for Hive to get back to it. An expired token did the same, and that case is routine rather than exotic: Isengard-style credentials are typically 1 hour and a transcription can poll for 5 minutes or more. Neither condition breaks the *job* — AWS accepted it and runs it to completion regardless; all that breaks is Hive's ability to observe it. Both now park the job in a "paused, waiting on X" state, resuming when connectivity returns or when new credentials are saved. Details:
  - Paused time doesn't consume the 60-attempt poll budget, which exists to bound how long a *job* may take, not how long the network is down. Waiting has its own cumulative 30-minute budget, so a flapping connection can't extend the wait indefinitely.
  - The result fetch from S3 goes through the same pause-and-retry path as the status poll. Failing there would discard a transcript AWS had already produced.
  - Genuine failures (throttling, validation, service errors) still fail the job rather than hiding behind an indefinite "waiting" state.
  - Cancel stays available while paused, and cancelling **offline** queues the `DeleteTranscriptionJob` call for reconnect — otherwise cancelling during an outage would silently leak a billing job.
  - If the paused budget does run out, the result is `ABANDONED` rather than a failure, naming the still-running AWS job instead of implying the work was lost.
  - The UI presents a paused job in warning colours with "Transcription Paused" and an explanation that it will resume automatically, rather than as an error.
- **An in-flight Work or Swarm run that fails from a transport error now says Hive is offline** instead of surfacing a raw DNS or socket error. Runs are deliberately *not* pre-emptively aborted when the connection drops — a brief blip may resolve inside the SDK's own retries, and cancelling would throw away recoverable work.

### Tests
- Added `tests/main/awsErrors.test.js` (33 tests): every transport code recognised, codes found through a wrapped `cause` chain, SDK `TimeoutError`, and the central rule that an HTTP status always means "not transport". Auth detection covers named exceptions, a bare 401/403 with an unfamiliar name, and the `__type` form. Explicitly asserts a network failure is never classified as auth, and that the offline message never mentions credentials.
- Added `tests/main/credentialMonitor.test.js` (12 tests): the work-loss regression itself — a transport failure pauses instead of declaring expiry — plus skipping the STS call entirely when already offline, a genuine rejection still expiring, the paused state clearing once AWS answers, `resumeAfterOffline()` re-checking immediately, and the deferred-navigation behaviour (no navigation while offline, runs on reconnect, honours a caller veto).
- Added `tests/main/connectivityMonitor.test.js` (11 tests): probes the regional STS endpoint, goes offline only after the debounce, skips the probe when the OS reports no interface, handles the captive-portal case (OS says online, nothing reachable), collapses concurrent rechecks onto one probe, notifies once per burst, survives a throwing `onChange`, and re-probes on `reportNetworkFailure()` rather than trusting the caller.
- Added `tests/renderer/offlineGuard.test.js` (45 tests): banner presence, `role="status"`/`aria-live`, absence of a dismiss control, stacking above the credential banner, and defaulting to online if the status check throws. Every one of the 17 network controls is asserted disabled with a reason tooltip, and all 10 sampled local controls asserted still enabled. Also covers tooltip restore, not re-enabling a control disabled for its own reasons, late-rendered controls via `refresh()`, and `requireOnline()` wording.
- Extended `tests/main/awsValidator.test.js` (+6) for the three-state result, and `tests/main/transcription.test.js` (+11, now 20) for network and auth pausing, resume-to-completion, the attempt budget not being consumed while paused, cancel while paused, cancel-while-offline queuing then flushing the delete, and a genuine `ThrottlingException` still failing.
- Extended `tests/renderer/index.test.js` (+6, now 37) for the paused presentation, the `ABANDONED` state, and offline pre-send refusal messaging.
- Added `tests/main/startupRoute.test.js` (9 tests) covering the offline-aware launch path: no stored credentials routes to the credentials page without loading or validating anything, valid credentials route to the main window, **offline with stored credentials routes to the main window rather than trapping the user**, a genuine rejection still routes to credentials, and both a failed credential load and an unexpected validation throw fall back safely. Two tests pin the deliberate ordering of `initializeAWSClients()` *before* validation — the property that lets a launch-while-offline start working the instant connectivity returns with no re-initialisation. Verified by mutation: moving the call after the validation check fails exactly that one test and no others.
- Two bugs were found *by* these tests and fixed: `job.paused` stayed truthy after unparking (so the job's state lied about whether it was currently parked), and once that was corrected the "notify once" check needed a separate persistent flag to stop a flapping connection emitting repeated OS notifications.

### Refactors
- Extracted startup routing from `main.js` into `src/main/startupRoute.js`. `main.js` can't be required under Jest (it needs the real Electron `app`), so the routing decision — including the offline behaviour that is the most user-visible part of this release — had no test coverage. The function now takes the app context as a parameter and only calls methods on it, so tests supply a fake and never touch Electron. `AWSValidator` is no longer imported by `main.js` as a result.

### TODO
- **Rework the Transcribe tab, and add naming + search over previous transcriptions.** Tabled deliberately: it is a feature, and the offline-stability work it was discovered alongside is a bug fix that shouldn't wait behind it. Two motivations — (a) a completed job on AWS is currently unreachable from Hive once the renderer moves on, so users re-run transcriptions they have already paid for, and (b) result delivery is tied to the renderer's in-flight `invoke('transcribe-media')` promise, so *any* renderer teardown (credential-expiry navigation, reload, crash) discards a transcript the main process already retrieved successfully.
  - **Move to main-owned job state.** The main process owns the job and emits progress and terminal events; the renderer subscribes and can re-attach after a reload, instead of awaiting a promise that dies with the page. This is what closes (b), and it is a change to result *delivery* only — the pausable job state added in this release is designed to sit underneath it unchanged.
  - **Persist a local job registry** (`userData/transcriptions/`): job name, user-supplied friendly name, source file, timestamp, status. This is what closes (a), and it is the prerequisite for naming and search — designing that UI against a half-present registry would be wasted work.
  - **Write the transcript JSON to local storage on completion**, next to the registry entry, rather than relying on AWS to hold it. Findings that make this the right call: `outputBucketName` (`settingsManager.js:14`) defaults to empty and Setup Check never provisions it (it only creates `bucketName`), so for many users Transcribe writes to a service-managed bucket and hands back a **pre-signed `TranscriptFileUri` that expires** — re-opening an old job then requires calling `GetTranscriptionJob` again to mint a fresh URI, which only works while AWS still holds the job metadata. Storing locally makes past transcripts independent of whether the user configured an output bucket, immune to Transcribe's own job-history retention, and — fitting the theme of the release this TODO ships in — **browsable while offline**. AWS becomes the source for jobs Hive hasn't indexed yet, not the only source.
  - **Reconcile the registry against `ListTranscriptionJobs`** to backfill jobs from before the registry existed. No new IAM permission needed — `transcribe:ListTranscriptionJobs` is already in the set `awsValidator.js` checks for.
  - **Verify Transcribe's actual job-history retention window** during this work. 90 days is commonly cited but was not confirmed against current AWS documentation; the local-copy design above makes Hive robust to whatever it turns out to be, so this is a documentation detail rather than a design dependency.
  - Cross-restart recovery of an in-flight job falls out of the registry naturally and belongs here, not in the offline fix — the offline work covers outages *within* a session only.

## v3.3.0

### New Features
- **Transcription no longer blocks the UI, and can be cancelled.** Uploading a file for transcription used to open a `data-bs-backdrop="static"`, `keyboard="false"` Bootstrap modal for the entire duration of the job — up to 5 minutes — which swallowed every click in the app. You couldn't switch tabs, press Escape, or abandon the job; the only exits were completion and failure. That block was never a technical requirement: all the work (S3 upload, `StartTranscriptionJob`, the 60 × 5s status poll) happens in the main process, and progress was *already* being streamed to the renderer over a `transcription-progress` IPC channel that the modal simply sat on top of. Replaced with:
  - **Inline progress** in the transcript pane — same streamed status text, plus a note that it's safe to switch tabs.
  - **A spinner on the Transcribe nav item**, visible from any tab, so a running job is discoverable after you navigate away.
  - **An OS notification on completion and on failure** (the same mechanism the Swarm tab already used for review points and pipeline events). Clicking it focuses the window *and* switches back to the Transcribe tab.
  - **A working Cancel button.** Previously there was no `cancel-transcription` path at all and the poll loop wasn't interruptible. Cancel now aborts an in-flight S3 upload (`Upload.abort()`), wakes the poll loop immediately instead of waiting out the current 5s interval, and best-effort deletes the Transcribe job so it stops billing rather than running to completion unobserved. `transcribe:DeleteTranscriptionJob` is *not* required — without it, cancellation still works from Hive's side and the delete is logged and skipped.
  - **A concurrency guard.** The renderer has a single transcript pane, video player, and `currentTranscript` array, so a second job would have silently clobbered the first. A second upload while one is in flight is now rejected with a warning toast, in both the renderer and the main process.
- **Shared OS notification helper** (`src/main/notify.js`). `ipc/swarm.js` had a local `swarmNotify()` and `credentialMonitor.js` constructed `new Notification(...)` inline three times, so the `Hive — ` title prefix, the `Notification.isSupported()` guard, and click-to-focus were applied inconsistently. All five call sites now go through one `notify()` function.

### Fixes
- **Transcription failures reported the same error three times** — a modal error state, an inline alert in the transcript pane, and an error toast. Collapsed to a single inline alert with a retry button, plus the OS notification. The error message is now inserted with `textContent` rather than interpolated into `innerHTML`, so a failure string from AWS can't inject markup.
- The transcription progress and notification-focus IPC listeners moved from inside `DOMContentLoaded` to module scope. Neither depends on the DOM (both resolve their nodes lazily when called), and registering at load means a progress event can't arrive before anything is listening.

### Removed
- The `transcriptionProcessingModal` markup in `src/pages/index.html` and its now-dead `#transcriptionStatus` node. `ModalManager` itself is unchanged and still used by the settings page.

### Tests
- Added `tests/main/transcription.test.js` (9 tests): cancelling mid-poll resolves as `CANCELLED` rather than throwing an error into the UI, cancel deletes the Transcribe job, a missing `DeleteTranscriptionJob` permission still cancels cleanly, cancel with no job in flight is a no-op, cancellation raises no OS notification, a second concurrent job is rejected, completion notifies with the file name, failure notifies with critical urgency and rethrows while still releasing the job slot, and clicking a notification asks the renderer to focus the Transcribe tab. The cancel tests complete in single-digit milliseconds, which is itself the evidence that Cancel wakes the sleep — a non-interruptible poll would have taken the full 5s interval.
- Added `tests/main/notify.test.js` (7 tests): title prefixing, urgency pass-through, no-op when unsupported, no click handler registered when none is needed, click focusing the window then running `onClick`, destroyed windows skipped, and a throwing `Notification` constructor never propagating to the caller.
- Added 9 renderer tests to `tests/renderer/index.test.js`: inline progress renders with a Cancel button and no `ModalManager` is constructed, the nav spinner toggles for the job's duration, streamed progress messages update the inline status, Cancel invokes `cancel-transcription`, a `CANCELLED` result resets the pane without showing transcript actions, a second concurrent upload is rejected rather than queued, failure reports once with no error toast, error text is inserted as text rather than markup, and the focus request switches tabs.


## v3.2.4

### Fixes
- **Work tab attachments larger than 4.5MB were still rejected by the file picker, despite the v2.17.0 sandbox fix.** That fix taught the backend (`src/main/utils.js`) to write oversized documents into the agent's Code Interpreter sandbox instead of attaching them inline — but the renderer's shared file manager (`src/renderer/fileManager.js`) kept its original hardcoded 4.5MB gate from before that fix existed, rejecting large files at selection time with "exceeds 4.5MB Bedrock limit" before the backend ever saw them. The gate is now a configurable `maxSize` option: the Work tab passes 100MB (oversized documents are sandboxed server-side; the cap just keeps the IPC payload sane), while the default stays at Bedrock's 4.5MB inline limit for any caller without a sandbox path. The rejection toast now reports the actual configured limit. The Chat tab is unaffected — it has its own separate attachment handler (10MB cap in `src/renderer/index.js`), unchanged.

### Tests
- Added `tests/renderer/fileManager.test.js` (6 tests): default 4.5MB limit still rejects/accepts correctly, 100MB config accepts >4.5MB files and rejects >100MB, rejection toast reflects the configured limit, and one oversized file rejects the whole batch.

## v3.2.1 – v3.2.3

_The entries below shipped across v3.2.1, v3.2.2, and v3.2.3 (this section was previously titled "Unreleased" — the header was never renamed when those tags were cut)._

### New Features
- **Live Mantle integration check** (`tests/integration/mantle-live.js`, run via `npm run test:integration`) — a plain Node script (not a Jest test, since `@strands-agents/sdk` ships as pure ESM with no CJS build) that calls the real Mantle endpoint through Hive's actual `createAgent()` routing logic, one minimal request per model family. Unlike the mocked unit test suite, it can catch upstream Mantle routing changes (like the two Anthropic 404 incidents in v3.0.1 and v3.1.2) that a mocked unit test structurally cannot detect. Locally, exits cleanly if `MANTLE_API_KEY` isn't set — never blocks a contributor without Mantle access.
- **Wired into CI**: the release pipeline (`release.yml`) now runs unit tests + this live check as a gate before both the macOS and Windows build/publish jobs — a release cannot ship with broken Mantle routing. A new scheduled workflow (`scheduled-tests.yml`) runs the same checks daily, independent of any push or release, so a routing change is caught within a day even between releases. Both require a `MANTLE_API_KEY` repository secret.

### Fixes
- **Long Work tab conversations no longer die with `ValidationException: Code interpreter session ... is not active`.** Two bugs compounded here. First, the per-conversation sandbox's AgentCore session expires server-side (its `sessionTimeoutSeconds` elapses), but `CodeInterpreterManager` cached the session ID forever and had no recovery — the error either killed the whole `invoke-agent` call (when hit during file prep, which runs outside any error handling) or left the model stuck retrying against a dead session it could never fix. Second, an aggravating timeout bug made this dramatically more frequent: if the *first* message in a conversation had a file attachment, `buildFileContentBlocks()` started the persistent Work sandbox with a hardcoded **5-minute** timeout (300s) instead of the 2-hour timeout (7200s) the tools use — so any tool call more than 5 minutes into such a conversation was guaranteed to hit a dead session. Fixed both: (1) `CodeInterpreterManager` now recovers transparently — an "is not active" `ValidationException` drops the stale session, starts a fresh one with the same timeout the original was started with, and retries the command exactly once (plus a proactive check that recreates a session provably past its own lifetime *before* wasting a doomed round trip); (2) `buildFileContentBlocks()` now takes a `sessionTimeout` option, and the Work tab passes 7200 to match its tools (Chat keeps the short default — its file-processing session is throwaway and stopped immediately after use). Since a recreated sandbox starts empty (AgentCore deleted the old files — nothing can prevent that), the `execute_code` tool result now tells the model explicitly when recovery happened so it re-uploads or regenerates files instead of silently referencing ones that no longer exist. Also fixed while in there: `readFileBase64()` now throws on a failed read instead of returning empty text — previously a vanished file could silently produce a 0-byte saved document reported as a success.
- **The Stop button in the Work and Chat tabs now actually interrupts a running job.** Previously the abort signal was only checked as a passive flag between stream events — it was never passed to the Strands SDK, so clicking Stop did nothing while the agent was inside a long-running tool call (`execute_code` can churn for minutes with zero stream events), and even during model streaming it only stopped Hive from *listening* — the in-flight Mantle request and any running sandbox code kept executing. Fixed by threading the existing `AbortController` all the way down: (1) both tabs now pass the signal to `agent.stream()` as `cancelSignal`, so the SDK aborts the in-flight model HTTP request and stops at its built-in checkpoints (between loop cycles, during model streaming, and between tool calls), ending the stream gracefully with `stopReason: 'cancelled'`; (2) tool callbacks in `swarmTools.js` now read the invocation's cancel signal from the SDK's `ToolContext` and forward it into AgentCore Code Interpreter calls (`send(cmd, { abortSignal })`), the web tool's fetch (composed with its 15s timeout via `AbortSignal.any`), and SageMaker/Bedrock image-generation calls — so Stop interrupts work that's *already executing*, not just the next step; (3) `codeInterpreterManager`'s retry wrapper never retries after a user-requested abort, even if the surfaced error looks transient; (4) an abort that surfaces as a thrown `AbortError` is treated as a graceful stop — partial text is returned, the Chat tab's `bedrock-stream-complete` still fires, and no error bubble appears. Cancelling deliberately does **not** kill the Code Interpreter session — Work tab file state must survive across messages — so a Python process already running server-side may still run to completion, but Hive stops waiting on it and the agent loop terminates immediately. Also fixed: attaching files in Chat no longer starts the (potentially slow) file-extraction phase if Stop was already pressed.
- **Work tab file/directory attachments could throw a raw `Unexpected token 'H', "HTTP conte..."` error when a task involved reading multiple local files** (e.g. attaching a workspace directory containing several documents). Root cause: `@strands-agents/sdk` defaults to a *concurrent* tool executor, so when the model calls `read_local_file` once per file in the same turn, all of those calls fire in parallel — and `CodeInterpreterManager.startSession()` had a check-then-act race (`if (this.sessionId) return; ...start a new session...`) with no locking, so several concurrent calls could each see no active session and each issue their own `StartCodeInterpreterSessionCommand` at once. Confirmed directly in production logs as bursts of 5 near-simultaneous "Session started" lines with different session IDs for what should have been a single session — the resulting concurrent load against AgentCore's endpoint could return a malformed/non-JSON response, which the AWS SDK's own response deserializer then failed to parse with exactly this `SyntaxError`. Fixed with an in-flight-promise lock: concurrent `startSession()` callers now await the one, single in-progress start instead of each racing to start their own. Also added a small retry-with-backoff wrapper around all AgentCore SDK calls (`startSession`/`executeCode`/`writeFiles`/`stopSession`) for throttling, 5xx, connection-reset, and this exact malformed-response symptom, as defense-in-depth against remaining transient failures under concurrent load. `AppContext.getOrCreateSandbox()` was audited for the same class of bug and confirmed already safe (fully synchronous, no `await` in the check-then-set), with a comment added so a future edit can't silently reintroduce the race.
- **Word/Excel attachments (`.docx`/`.doc`/`.xls`/`.xlsx`) silently disappeared when using a Claude (Anthropic) model** — the agent would respond as if no file had been attached at all, with no error anywhere. Root cause: `@strands-agents/sdk`'s `AnthropicModel` provider only natively supports `pdf` and a fixed plain-text format list for document content — any other format (including docx/xlsx) is silently dropped with an internal `logger.warn()` that never surfaces in Hive's own logs, and no exception is thrown. Reproduced directly against a real `.docx` file end-to-end through `buildFileContentBlocks()`. OpenAI-compatible models (GPT-5.x, Gemma, Grok) were never affected — their adapter accepts any byte-source document format generically. Fixed by routing docx/xls/xlsx through the existing AgentCore Code Interpreter sandbox for Anthropic models specifically, extracting text server-side via `python-docx`/`openpyxl` (the same pattern already used for `.pptx`), regardless of file size — the underlying issue is format support, not size, so the existing 4.5MB inline-document threshold doesn't apply here. Also reported upstream to the `strands-agents` maintainers, since silently dropping content with no catchable error is a bug in the SDK itself.
- The live Mantle integration check intermittently failed on `openai.gpt-5.6-sol` with `MaxTokensError` — caught by the daily scheduled CI run exactly as designed. Root cause: GPT-5-class models are reasoning models, and internal reasoning tokens count against the output token budget even without explicitly requesting reasoning effort — a well-documented OpenAI/Mantle behavior. The check's `maxTokens: 16` was occasionally consumed entirely by invisible reasoning tokens before any visible output token was produced, which is why it failed only some runs rather than every run (Anthropic and Gemma, non-reasoning models, were unaffected). Raised to `maxTokens: 64`; verified with 5 consecutive local runs, all passing. This was not a Mantle routing regression — the monitoring caught a real, if minor, bug in the check itself.
- **xAI Grok models (`xai.grok-*`) are now supported.** Upgraded `@strands-agents/sdk` from 1.11.2 to 1.12.0, which shipped a real upstream fix for Mantle's base-path routing table ([harness-sdk#3691](https://github.com/strands-agents/harness-sdk/pull/3691)) — the table now scopes prefixes to a specific model *line* rather than a vendor (`openai.gpt-5.`, `xai.grok-4.`, `google.gemma-4-`), since a vendor can straddle both base paths (Gemma 4 is on `/openai/v1`, Gemma 3 is on `/v1` — a vendor-wide match would have mis-routed Gemma 3). Hive's own independently-maintained copy of this table (`strandsAgentFactory.js`, since the SDK's helper is internal and not exported) is updated to match exactly, correcting a latent bug where it used a vendor-wide `google.` match that would have mis-routed `google.gemma-3-*` models. Confirmed fixed end-to-end through Hive's own `createAgent()` path with 5 consecutive live runs against `xai.grok-4.3`. Note: Grok needs a substantially larger output token budget than other models before producing visible text (reasoning tokens consume part of the budget — 200 was insufficient, 500 succeeded in testing) and the upstream fix's own testing notes residual intermittent flakiness on Mantle's side independent of routing. See README's Model Configuration section.

### Tests
- Added 20 tests for the session-expiry fix: `codeInterpreterManager.test.js` (recovery on the exact production "is not active" error for both `executeCode` and `writeFiles`, the retried command targeting the new session ID, single-attempt cap, unrelated ValidationExceptions not triggering recovery, recovery skipped after user abort, recreated sessions reusing the original timeout, proactive recreation of a provably-expired session without a doomed round trip, fresh sessions left alone, `readFileBase64` throwing on failed reads, `stopSession` clearing lifetime bookkeeping), `swarmTools.test.js` (the session-recreated note reaching the model in both success and error tool results, absent otherwise), and `utils.test.js` (`sessionTimeout` threading on both the oversized-file and Anthropic-extraction paths, short default preserved).
- Added 23 cancellation tests across four suites: `agentToolExecutor.test.js` (cancelSignal passed to `agent.stream()`, partial text returned on mid-stream abort, streams that end on their own after cancel, abort-shaped errors swallowed only when the signal is aborted, real errors still rethrown), new `bedrockChat.test.js` for the Chat tab's `invokeChatModel` (same guarantees, plus the pre-file-extraction short-circuit and `bedrock-stream-complete` firing on graceful abort), `swarmTools.test.js` (tool callbacks forward `ToolContext.agent.cancelSignal` into sandbox/fetch calls, backward compatible when no context is passed), and `codeInterpreterManager.test.js` (`send()` receives `abortSignal`, `withRetry` never retries after abort).
- Added `tests/main/codeInterpreterManager.test.js` (19 tests) covering the `startSession()` concurrency fix — 5 simultaneous calls collapsing into exactly one `StartCodeInterpreterSessionCommand`, a failed start correctly releasing the lock for retry, and sequential calls not re-invoking AWS — plus full coverage of the new `isRetryableError`/`withRetry` helpers, including a fake-timers integration test proving `executeCode` transparently retries on the exact malformed-response `SyntaxError` seen in production.

### Removed
- Removed `config.js`, `tests/main/bedrock-llm.test.js`, and `tests/main/validate-setup.js` — all three were pre-Mantle Bedrock Converse-era dead infrastructure (Nova/DeepSeek model IDs, `ConverseCommand`, removed Knowledge Base APIs, a `.transcribely` credentials path predating the app's rename to Hive).
- Fixed a real latent bug found during this cleanup: `ipc/bedrock.js`'s `get-bedrock-models` handler had a stale fallback to `config.js`'s pre-Mantle model list (`settings.bedrockModels || config.bedrockModels`) that would have served Nova/DeepSeek model data had `settings.bedrockModels` ever been falsy. Removed the fallback entirely — `settingsManager.loadSettings()` already merges in the correct, current default model list for any missing field.

### TODO
- **3 Chat tab tests are skipped, not passing**: `downloadAnalysis`/`copyAnalysis`'s happy-path tests (`tests/renderer/index.test.js`) can't currently exercise the real success path — both functions read a module-private `currentConversation` closure variable that test code can't set from outside. Only the "no conversation" negative-path siblings are covered. Needs either exposing `currentConversation` on `window` for real, or refactoring both functions to accept the conversation as a parameter.

## v3.2.0

### New Features
- **Setup Check now includes a "Code Interpreter Permission" item.** Work and Swarm document attachments and code execution depend on `bedrock-agentcore:StartCodeInterpreterSession`/`InvokeCodeInterpreter`/`StopCodeInterpreterSession` — permissions that were previously undocumented anywhere Setup Check itself looked, so a user on a scoped-down role had no way to discover the gap until a message failed mid-conversation with a raw AWS SDK error. This item runs a real, immediately-stopped Code Interpreter session to verify the permission actually works end to end (not just an IAM policy simulation, which can't account for SCPs, permission boundaries, or resource-based policies).
- **New `scripts/grant-hive-permissions.sh`.** Unlike Setup Check's other three items, this permission gap isn't something Hive can create on your behalf — it's a permission on your own IAM role, and Hive deliberately never modifies a role it doesn't own. The script detects your current AWS identity (including unwrapping an Isengard/Merlon-style `assumed-role` ARN to the underlying role name), then creates a new, standalone IAM policy with exactly the runtime permissions documented in README's "AWS Permissions Required" and attaches it — it never edits or overwrites anything already on the role, and prints the exact `detach`/`delete` commands to undo it. Supports `--bucket` (scope S3 access to one bucket instead of all buckets) and `--dry-run` (preview the policy, no changes).
- **"View Instructions" in Setup Check.** Since this item can't be auto-created, its row shows a "View Instructions" button instead of "Create," opening a modal with the exact ready-to-copy `grant-hive-permissions.sh` command (with a one-click copy button) instead of leaving the user to piece together the right IAM policy themselves.
- **Friendlier Work tab error messages.** If a user skipped Setup Check (or their permissions changed after it last ran) and hits this permission gap mid-conversation, the raw `AccessDeniedException` for any of the five AgentCore Code Interpreter/Browser session actions is now rewritten into an actionable message with a link that opens the same instructions modal — instead of a raw AWS SDK exception string.

### Tests
- Added 5 tests in `tests/main/setupWizard.test.js` for the new Code Interpreter permission check (ready, access-denied by exception name, access-denied by 403 status code, unrelated errors reported as 'unknown' rather than misclassified, and that cleanup failures don't mask a successful permission check). 22 tests total in that file, up from 17.
- Added `tests/renderer/workTab.test.js` (9 tests) covering the new error-rewriting logic, exposed via `window.WorkTab.describeAgentError` for testability. Caught a real bug during development: the initial regex assumed every AgentCore action name ended in "Session," but `InvokeCodeInterpreter` doesn't — fixed to an explicit alternation of the five exact action names before merging.

## v3.1.2

### Fixes
- **Anthropic models (Claude) failed again with a 404 on every call in Chat and Work.** This is a different cause from the earlier v3.0.1 fix: Mantle changed its own routing since then — the bare-host `/v1/messages` path that was previously correct now 404s. Confirmed via direct testing against the live Mantle endpoint: Anthropic models now require an `/anthropic` provider prefix (`/anthropic/v1/messages`), mirroring the `/openai/v1` prefix Mantle already uses for `openai.gpt-5.*`/`google.*` models. The Anthropic branch's `baseURL` is now `https://bedrock-mantle.{region}.api.aws/anthropic`.

## v3.1.1

### Fixes
- **Resolved all 9 npm audit vulnerabilities (4 high, 5 moderate).** 7 were fixed automatically via `npm audit fix` (Hono, brace-expansion, fast-uri, ip-address, undici). The remaining 2 moderate vulnerabilities were both caused by `exceljs@4.4.0` bundling a vulnerable nested `uuid@8.3.2` (missing buffer bounds check, GHSA-w5hq-g745-h8pq) — rather than downgrading `exceljs` (the fix `npm audit fix --force` suggested, which is a real regression), added a `package.json` `overrides` entry forcing `exceljs`'s nested `uuid` dependency to the patched `^11.1.1` without touching `exceljs` itself. Verified with a direct smoke test that `exceljs` still generates valid `.xlsx` workbooks. `npm audit` now reports 0 vulnerabilities.

## v3.1.0

### New Features
- **Setup Check** — Hive now checks your AWS account on first launch (and on demand via Settings → Configuration → Run Setup Check) for a few things it needs — a Web Search Gateway execution role, a transcription S3 bucket, and an AgentCore Memory resource — and creates anything missing directly from the app. No more manually creating an IAM role in the AWS console.
- **Admin Tab** (`aws-keynote` account only) — a new, visually distinct tab in Settings for managing resources shared across the whole team. Includes a 3-step wizard for granting/revoking individual IAM roles' access to the shared Gateway, with a mandatory review-the-exact-policy-diff step before any change is applied.

### Known Issues
- **The Admin tab's Knowledge Base features are not yet usable.** Amazon Bedrock Managed Knowledge Base is not currently available in the `aws-keynote` account/region, so no shared Gateway or Knowledge Base has been created yet — the Admin tab's status checks will report "missing" until AWS enables this for that account. This is an AWS availability constraint, not a bug; tabled until it's resolved. See README's Admin Tab section for details.

## v3.0.2

### Fixes
- **Chat tab crashed with an opaque `MaxTokensError` on longer responses.** The Chat tab's model call hardcoded `maxTokens: 4096` (max output tokens), ~30x smaller than the `120,000` default every other tab (Work, Swarm) already uses via `createAgent()`. Chat now inherits the same default.
- **Attaching a transcript in the Chat tab dumped the entire raw transcript text into the chat bubble.** Checking "Transcript" used to splice the full transcript directly into the prompt string, which then rendered as a wall of text in the conversation. It's now attached the same way a regular file upload is — sent as a proper attachment and shown as a small chip above the message instead of inline text.
- **Transcript attachments included timestamp and speaker-label markup instead of clean text.** The transcript attachment now reuses the same sanitization already used by "Download Transcript" / "Copy Transcript" (`getTranscriptForExport()`), so it respects the existing "Include speaker/timestamps" preference instead of pulling raw, markup-containing text from the DOM.
- **Large text attachments (transcripts or otherwise) had no size limit before being sent to the model, risking the same `MaxTokensError` crash regardless of the output-token fix above.** The Chat tab's agent has no code-execution tool, so it can't be pointed at a sandboxed file the way large Word/Excel/PDF attachments already are for Work and Swarm. Inline text attachments (`.txt`, `.csv`, `.html`, `.md` — including transcripts) are now capped at 300,000 characters; anything longer is truncated with a visible marker directing the user to the Work tab for full-file processing. The Chat UI also warns before sending if the attached transcript is large enough to be truncated.

### Tests
- Added test coverage in `tests/main/utils.test.js` for inline-text truncation behavior (5 new tests: unaffected below the limit, truncated with a visible marker above it, exact-boundary behavior, sandbox-independence, and non-interference with the existing oversized-document sandbox-pointer path). 280 tests total, up from 275.

## v3.0.1

### Fixes
- **Anthropic models (Claude) failed with a 404 on every call.** The v3.0.0 Mantle migration set the Anthropic branch's `baseURL` to `https://bedrock-mantle.{region}.api.aws/v1`, but `@anthropic-ai/sdk`'s `Messages.create()` always POSTs to the literal path `/v1/messages` relative to `baseURL` — the SDK supplies its own `/v1` prefix. The result was a request to `.../v1/v1/messages`, which Mantle correctly 404'd. The Anthropic branch now uses the bare Mantle host with no path suffix.
- **Google Gemma models failed with a "model isn't supported on this route" error.** The Mantle base-path rule only special-cased `openai.gpt-5.*` for `/openai/v1`, routing everything else (including `google.gemma-*`) to `/v1`. Verified by testing directly against the live Mantle endpoint: Gemma models are only served from `/openai/v1`. The routing rule now includes `google.*` models alongside `openai.gpt-5.*`.

### Known Issues
- **xAI Grok models (`xai.grok-*`) are not currently functional on Mantle.** Confirmed via direct testing against the live endpoint: the model is listed as available (`GET /v1/models` returns `"status":"available"`), but every invocation route (`/v1/chat/completions`, `/openai/v1/chat/completions`, `/openai/v1/responses`) fails — either a validation error ("isn't supported on this route") or a 500 internal server error, consistently and repeatedly. This looks like a Mantle-side model registration/serving gap rather than a client-side routing bug (Gemma, tested identically, works correctly on `/openai/v1`). Reported to the Mantle team; do not add Grok models to Settings until this is resolved upstream. See README's Model Configuration section for the user-facing note.

### Documentation
- Expanded the AgentCore Gateway section in README.md with full one-time setup instructions (trust policy, permissions policy, and the Settings field to configure) — previously only the in-app Settings hint mentioned the required IAM trust relationship, with no guidance on the actual permissions policy needed.

### Tests
- Added test coverage in `tests/main/strandsAgentFactory.test.js` for the Anthropic bare-host baseURL and the `google.*` → `/openai/v1` routing rule (56 tests total, up from 54).

## v3.0.0

### Breaking Changes
- **All model invocation now goes through Amazon Bedrock's Mantle endpoint — Bedrock Converse (BedrockModel) has been removed entirely.** Every model call in Work, Chat, and Swarm is routed to one of two Strands model providers based purely on model identity: Claude models go through Mantle's native Anthropic Messages API, every other model (GPT-5.x, gpt-oss, and any future Mantle-only model) goes through Mantle's OpenAI-compatible Responses API. The previous per-model "Mantle" checkbox in Settings → Models has been removed — routing is now automatic and no longer configurable per model.
- **New required setting: Mantle API Key.** A one-off, long-term Bedrock API key (Settings → Mantle API Key) is now required for all model calls. Generate one from the AWS Bedrock console. AWS documents long-term keys as recommended for exploration/development use — see the AWS Bedrock API keys documentation for details before relying on this in a production deployment.
- **Removed support for models with no Mantle-reachable Strands provider**: Amazon Nova (all variants), DeepSeek, Mistral, and Llama models are no longer offered in the default model list and cannot be added back, since the Strands SDK has no dedicated provider for these families that can reach Mantle. If you need these models, they are not currently supported by this version of Hive.
- **Chat tab no longer supports Knowledge Base / RAG.** The "Use Knowledge Base" toggle, Knowledge Base selector, and all associated retrieval-augmented-generation functionality have been removed. Chat is now a simple, non-agentic back-and-forth with any configured model — no tools, no retrieval. If you were relying on Knowledge Base integration in Chat, there is currently no replacement.
- **Removed video analysis from the Swarm Demo/Storyboard template.** The Analyst agent previously used Amazon Nova Premier to analyze an attached `.mp4` video frame-by-frame and embed extracted keyframes into the storyboard deck. This relied on Bedrock Converse's video content blocks directly and had no Mantle equivalent, so it has been removed along with Nova Premier support. The Demo template now starts from a plain text brief or attached screenshots/images instead of video.

### Improvements
- **Simplified retry error classification.** Bedrock Converse-specific error names (`InternalServerException`, `ServiceUnavailableException`, etc.) have been replaced with `@anthropic-ai/sdk`'s own exported error classes for the Anthropic branch, mirroring the existing OpenAI SDK error-class handling for the OpenAI-compatible branch. Both providers' throttling errors are already normalized to a common `ModelThrottledError` upstream by the Strands SDK, so retry behavior is unchanged for rate limiting.
- **Removed unused AWS SDK dependencies**: `@aws-sdk/client-bedrock-agent` and `@aws-sdk/client-bedrock-agent-runtime` (Knowledge Base-only) are no longer installed.

### Tests
- Full rewrite of `tests/main/strandsAgentFactory.test.js` (54 tests) covering Mantle-only model-family routing, region validation, and base-URL/path construction for both provider branches.
- Removed Knowledge Base-specific tests from `tests/renderer/index.test.js` and `tests/main/swarmOrchestrator.test.js`; fixed stale mocks referencing removed Bedrock Converse imports.

## v2.20.0

### Fixes
- **Work tab agent now retries transient Bedrock service errors** — previously, generic transient failures ("The system encountered an unexpected error during processing," "Bedrock is unable to process your request," and similar internal server / service-unavailable errors) failed the turn outright on the first attempt with no retry. The model retry strategy now also covers these transient error shapes (InternalServerException, ServiceUnavailableException, ModelErrorException, ModelTimeoutException, ModelStreamErrorException, ModelNotReadyException) with the same exponential backoff already used for throttling, instead of only retrying rate-limit errors.

### Tests
- Added `tests/main/strandsAgentFactory.test.js` covering the expanded retry classification (12 tests).

## v2.19.0

### Fixes
- **Work tab agent no longer hits "maximum token limit" errors on trivial follow-up messages** — a regression from the Strands/AgentCore migration (v2.17.0) caused every turn in a session to reload the *entire raw text* of the last 10 conversation events and re-inject it into the system prompt. Once any single turn produced a long response (a generated document, a detailed explanation), every subsequent turn in that session — no matter how simple — carried that same oversized blob and could fail outright. The within-session conversation history mechanism has been restored (capped to the most recent 20 messages) and AgentCore Memory is now used only for its intended purpose: bounded long-term recall of facts/preferences. Long-term memory extraction (which requires every turn to be saved) is unaffected — nothing changed there.
- **Fixed a related content-block double-conversion bug** uncovered while fixing the above: file attachments on a turn with existing conversation history could be misclassified internally by the Strands SDK. Attachments are now passed through in their native data shape exactly once.

## v2.18.0

### New Features
- **Transcript copy/download now preserves speaker and timestamp breakout** — previously, copying or downloading a transcript always stripped it down to plain text, even though the preview shows each segment's speaker and timestamp range. A new "Include speaker & timestamps" toggle above the transcript action buttons lets you choose: off (default) copies/downloads the plain text as before, on preserves the full `[timestamp --> timestamp] Speaker N` breakout shown in the preview for each segment.

## v2.17.0

### Fixes
- **Large file attachments (>4.5MB) in the Work tab no longer fail** — previously, attaching a PDF, Word, or Excel document larger than Bedrock's inline document limit could either hit an unfixed AWS Bedrock service-side bug (when routed through S3) or risk overflowing the model's context window (when pre-extracted and dumped as text). Oversized documents are now written directly into the agent's Code Interpreter sandbox, and the model is told exactly where to find them — it uses its own `execute_code` tool to read, search, or extract only what it actually needs, on demand. Small files (≤4.5MB) are unaffected and continue to attach inline as before.

### Improvements
- **Work tab agent now self-heals from transient errors** — the Work tab's agent loop has been migrated from a hand-rolled Bedrock streaming loop to the Strands Agent SDK. Model-call failures (throttling, timeouts) are automatically retried with exponential backoff, and tool-call failures (timeouts, throttling, transient network errors) are automatically retried up to 3 times — all using the SDK's own retry/hook primitives rather than custom logic. Non-retryable errors (invalid model ID, context overflow) correctly fail fast instead of retrying pointlessly. Swarm pipeline agents inherit the same retry and introspective logging behavior automatically, since both now share a single agent-construction helper.

### Tests
- Rewrote `tests/main/utils.test.js` to cover the sandbox-pointer attachment design (12 tests): small files unchanged, large files routed to the sandbox with a text pointer (not extracted), automatic session start, clear error when no sandbox is available, non-document files unaffected, and mixed batches.

## v2.16.0

### Fixes
- **Showflow Excel export now matches the reference run-of-show format** — previously the exported .xlsx had all durations and cumulative timings baked in as static text (e.g. "3 min"), diverging from the standard keynote run-of-show template used across the team. The exporter now produces a workbook with real Excel duration values, live `SUM()` running-total formulas for cumulative time, and chained clock-time formulas anchored to a configurable show start time — matching cell-for-cell the reference Keynote run-of-show format (merged header/title rows, confidential banner, bold column headers, correct column widths).

### New Features
- **Show start time** — added a "🕐 start time" control next to the duration target in the Showflow header. Setting a start time anchors the exported Clock Time column so it reflects actual wall-clock times instead of relative offsets.

### Improvements
- **Simplified show types** — removed Dance Recital, Play/Musical, and Concert from the New Show picker; only Keynote and Custom remain relevant to this version of the app. Removed all associated dead element-type definitions, labels, and sheet-name mappings. Existing saved shows of the removed types are unaffected (each show stores its own element types and labels).

## v2.15.0

### Fixes
- **Swarm formatter agents no longer fail silently** — the Demo/Storyboard, Article, and Keynote pipelines' formatter agents (docx/pptx generators) previously could report success without actually producing an output file if the underlying model's tool-calling loop terminated early. The orchestrator now retries the formatter (up to 2 attempts by default) with explicit corrective feedback when no verified file is found, and hard-fails the pipeline with a clear error instead of silently completing if all retries are exhausted. A failed run is no longer checkpointed, so resuming a pipeline correctly re-attempts the formatter rather than skipping it.

### Tests
- Added `tests/main/swarmOrchestrator.test.js` covering file-save verification and the retry/failure flow (7 new tests).

## v2.14.0

### Dependency Updates
- **Security fixes** — resolved 12 of 17 npm audit vulnerabilities (1 critical, 8 high, 6 moderate, 2 low → 5 moderate remaining) via `npm audit fix`. Remaining moderate issues require major version changes to `@modelcontextprotocol/sdk` (transitive via Strands SDK) and `exceljs`, deferred pending a dedicated regression pass.
- **AWS SDK clients** — all 12 `@aws-sdk/*` packages bumped to 3.1092.0.
- **Strands Agents SDK** — upgraded from `1.0.0-rc.1` to `1.10.0` (stable). Reviewed the full changelog between these versions; no breaking changes affect Hive's usage of `Agent`, `BedrockModel`, or tool calling.
- **Electron** — upgraded from 40.10.0 to 43.2.0. Reviewed breaking changes; the only relevant one (window controls overlay behavior) doesn't apply since Hive uses standard OS title bars.
- **marked** — upgraded from 17.0.6 to 18.0.7 (Node version floor bump only, no code impact).
- Minor/patch bumps: `docx`, `electron-log`, `electron-updater`, `electron-builder`, `zod`, `jest`, `jest-environment-jsdom`, `@testing-library/jest-dom`.

### Fixes
- **Missing direct dependencies** — `@aws-crypto/sha256-js`, `@smithy/signature-v4`, and `@smithy/protocol-http` are used directly in the web search SigV4 signing code but were previously undeclared, riding along as transitive dependencies of older AWS SDK versions. Bumping the AWS SDK clients dropped them from the dependency tree, which would have caused a runtime crash on load. Now declared explicitly. Caught via an Electron app launch smoke test before release.

## v2.13.0

### New Features
- **StoryBrand SB7 Skill** — new skill that analyzes any content (websites, emails, pitches, keynotes, product pages) against Donald Miller's 7-element StoryBrand framework. Returns a structured audit with element-by-element scoring, quick-win rewrites, and a BrandScript draft. Includes a 25-brand reference library covering Consumer, B2B/SaaS, Non-Profit, and Finance sectors.
- **Skills Palette (⚡ button)** — new button in the Work tab input toolbar that opens a browsable palette of all available skills. Each skill shows an icon and description; clicking "Use" inserts a contextual starter prompt into the textarea. Makes skills discoverable without needing to know they exist or memorize names.

### Improvements
- **Skill icons** — each skill now has a dedicated Bootstrap Icon in the palette for quick visual identification.
- **Starter prompts** — selecting a skill from the palette pre-fills the input with a relevant prompt template, reducing friction for first-time use.

## v2.12.0

### New Features
- **AgentCore Web Search Tool** — web search for Work and Swarm agents now uses Amazon Bedrock AgentCore's managed Web Search Tool instead of Jina AI. Queries stay entirely within AWS infrastructure (no third-party data egress), backed by Amazon's purpose-built index of tens of billions of documents with knowledge graph grounding and semantic snippet extraction.

### Improvements
- **No API key required for web search** — removed the Jina API key requirement from Settings → Credentials. Web search now authenticates via your existing AWS credentials automatically.
- **Auto-provisioned Gateway** — Hive creates an AgentCore Gateway with the web-search connector on first use (in `us-east-1`). Subsequent launches reuse the existing gateway.
- **URL reading without third-party dependency** — reading specific web pages no longer routes through Jina's reader API. Uses direct fetch with HTML-to-text extraction.

### Removed
- **Jina AI integration** — all Jina code, API key storage, IPC handlers, and Settings UI have been removed. The `jina-credentials.json` file is no longer used (safe to delete if present).

### Permissions
New IAM permissions required for web search:
- `bedrock-agentcore:CreateGateway`, `CreateGatewayTarget`, `ListGateways`, `GetGateway`, `ListGatewayTargets`, `GetGatewayTarget` (one-time gateway setup)
- `bedrock-agentcore:InvokeGateway` (per search invocation)
- `bedrock-agentcore:InvokeWebSearch` (on the Gateway's service role)

## v2.11.0

### New Features
- **Auto-update pill** — replaced the full-width blue banner with a compact, animated pill in the navbar. Shows download progress with a pulsing indicator, then a green "Update" button when ready. Theme-aware for both light and dark modes. No dismiss — stays visible until installed.

### Improvements
- **Showflow export consistency** — Word and Excel exports now produce identical content: same columns (Section, Content, Speaker, Start, End, Duration), same section-grouped structure, same header/footer rows.
- **Non-presentation items in exports** — Demo, Video, Fireside, and other non-presentation elements now appear as their own rows in exports with type prefix and individual timing, rather than being collapsed into the section row.
- **Shared export data builder** — extracted `buildShowData()` to eliminate duplicated logic between Word and Excel exports.
- **Cleaner export filenames** — removed `.showflow.` and `_run_of_show` from exported filenames. Now just `{name}.docx` and `{name}.xlsx`.

## v2.10.0

### New Features
- **Credential expiry monitoring** — background monitor detects expired/expiring AWS credentials. System notifications at T-15min and T-2min, in-app warning banner, automatic redirect to credentials page on expiry. Window re-activation now re-validates credentials.
- **Showflow — PowerPoint import** — import a `.pptx` file and generate a run-of-show from its sections and slide word counts (140 wpm). Sections map to chapter marks with calculated durations.
- **Showflow — Word export** — flat table export with Section, Content, Speaker, Duration columns. No colour styling.
- **Showflow — Excel export** — matches reference run-of-show format: Section, Content, Speaker, Start, End, Duration with cumulative timings, total runtime, and target/buffer row.
- **Showflow — Seconds precision** — duration inputs now include a :00/:15/:30/:45 seconds dropdown on both item cards and chapter mark targets.
- **Showflow — Header redesign** — buttons moved left (New Show, Save, ⋯ overflow menu). Show name and duration pill moved right. Overflow menu contains My Shows, Import, Export, Close Show.
- **Showflow — Duration pill** — improved contrast and accessibility on both light and dark themes.
- **Showflow — New Show dialog** — now asks for target duration upfront.

### Bug Fixes
- **Showflow — Scroll preservation** — deleting or expanding items no longer jumps the run list back to the top.
- **Showflow — Drag-to-position** — dragging from the elements palette now inserts at the pointer position instead of always appending to the end.
- **Showflow — Chapter duration badges** — update live when item durations change without requiring a full re-render.
- **Showflow — Run list scrolling** — fixed overflow issue where items were squashed instead of scrollable.
- **Showflow — Default element types** — system and default element types no longer show a delete button.
- **Showflow — Orphaned items** — items with missing element types render with a fallback style and a one-time warning toast.
- **Credentials page** — Bootstrap `d-flex !important` was overriding `display:none` on the warning banner, causing it to always show.
- **EPIPE crash** — suppressed broken-pipe errors when electron-log writes after renderer navigation.

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
