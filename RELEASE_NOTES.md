# Release Notes

## v4.0.0

### New Features

- **StoryBrand tab.** Upload a keynote script or a detailed outline and every paragraph is classified against the seven StoryBrand SB7 elements, then shown back colour-coded with a sticky card explaining whichever element you are reading. Character blue, Problem red, Guide green, Plan gold, Call to Action orange, Stakes purple, Success teal. A Colour/Plain toggle drops the colours for straight reading, and an audit panel gives each element a strong/weak/missing verdict with what was found, what is wrong and a specific fix.

  - **Your text is read locally and never rewritten** (`storyboardExtractor.js`). `.txt`, `.md`, `.docx` and `.pptx` are parsed on your machine — `.docx` and `.pptx` are ZIP containers of XML and `jszip` was already a dependency. Hive's existing attachment path (`buildFileContentBlocks`) was the obvious tool and is the wrong one: it starts a billable Code Interpreter session, it fails with no network, and it hands the *model* the text. The tab renders the user's own keynote back to them, so a model that supplies the text will quietly reflow paragraphs, "fix" perceived typos and drop clauses, and the user gets back something that looks right and is not their script. PDF is deliberately rejected with an actionable message rather than routed through the sandbox.

  - **The model only ever returns a mapping of paragraph number to element** (`storyboardAnalyzer.js`). One call returns both the classification and the audit inside a single JSON envelope — asking for JSON *followed by* a prose audit is where malformed output comes from, since the model closes the object, starts writing, and the parse boundary turns ambiguous. Any text attached to a classification is discarded. Validation is strict: every paragraph must be classified exactly once with a known element key, and a partial result is refused with the specific missing paragraph numbers rather than rendered with gaps, because a paragraph falling back to a default colour is indistinguishable from a real classification.

  - **An outline's bullet and its sub-points are one unit.** A keynote script splits cleanly on blank lines; an outline is short nested fragments, and classifying each separately produces a wall of one-line colour changes instead of a readable document. The outline-versus-prose decision is made per blank-line-separated block, because a real deck interleaves both.

  - **Read-only by design.** Hive is not a script editor: you revise in whatever you actually write in and re-upload. Uploading a file that has been analysed before links the new analysis to the most recent previous one and surfaces it as "Revision 2 of 2", so "did my rewrite fix the Guide section?" is answerable by comparing two entries. Pasted text is deliberately never chained — its source name is always the same, so chaining on it would string unrelated snippets into one bogus history. **Re-analyse** re-runs the model over the same stored text instead, for switching model or when a classification looks wrong.

  - **Analyses are saved locally and searchable by phrase**, not just by name, so a keynote is findable by something said in it. Stored rather than recomputed because classification is not deterministic — without a snapshot the colours would shift under you between viewings. The sidebar shows a colour bar of the story's shape. Everything except the single analysis call works offline, and the Analyse and Re-analyse buttons are registered with `offlineGuard`, so they are disabled when AWS is unreachable *or* credentials have been rejected.

  - **Export writes one self-contained HTML file** — no stylesheet link, no webfont request, no CDN script — so it renders identically on someone else's machine, offline, or in two years.

### Improvements

- Built to the design spec in the handoff notes rather than to the reference implementation beside it, which is considerably plainer than its own spec describes: off-white canvas with gradient tints, an elevated reading surface, a segmented pill toggle with a sliding thumb, a top-edge accent bar on the explanation card, a haloed swatch, colour-dot bullet markers, and `prefers-reduced-motion` support. Gold is the spec's `#C98A00` rather than the reference's `#F9A825`.
- **The seven colours get lightened dark-theme variants.** The palette is tuned for white, and blue `#1565C0` and purple `#6A1B9A` in particular fail contrast on Hive's dark background. The reading surface keeps its own light/dark tokens rather than being dimmed wholesale.
- **The spec's serif/sans font pairing is deliberately not used.** Hive declares no `font-family` of its own outside monospace for code — every tab inherits Bootstrap's system UI stack — so a serif display face here would have been the only serif in the app and read as a different product. Heading hierarchy is carried by size and weight instead. It also avoids a Google Fonts dependency that would silently fall back whenever the network is down, which sits badly with a tab whose local half is otherwise fully offline. The HTML export inlines the same stack so an exported file looks like the tab it came from.
- **`storybrand` is now documented.** The skill shipped in an earlier release without a README entry; the count still said 17 and the table omitted it. Fixed to 18 with a `storybrand` row.

### Technical Notes

- **The canonical element definitions live in `src/main/models/storybrandElements.js`, not beside the skill.** Keeping the machine-readable copy in `skills/storybrand/` is the obvious move and does not survive how skills load: `SkillsManager._seedBundledSkills()` copies a bundled skill into userData only when that skill's `SKILL.md` is *absent* there, so a newly added sibling file would never reach anyone who already has Hive installed — the tab would work on a fresh install and be broken on an upgrade. Skills are also user-editable, and these values must agree with the CSS, so an edit should not be able to break rendering. `SKILL.md` now points at the source module and keeps the prose guidance for Work/Chat audits.
- All tab CSS is scoped under `#storyboard-page` / `.sb-*`. The reference is a standalone page that resets `*` and styles bare `h1`/`h2`/`p`; pasted in as-is it would have restyled every other tab.
- The reference binds its scroll behaviour to `window`. Inside a tab the scroll container is a `div`, so the `IntersectionObserver` needs an explicit `root` and the scroll listener has to be on the container — getting that wrong is silent, and the reveal animations and scroll-aware rail simply never fire.

### Tests

- `storyboardExtractor.test.js` (33): fidelity above all — a sentence split across Word formatting runs reassembles correctly, a hard line break becomes a space rather than gluing words together, XML entities decode without double-decoding, `.pptx` slides read in numeric rather than lexical order, grouping never spans a slide boundary, and the words survive verbatim. Verified against the real 4,000-word keynote: 71 source blocks in, 71 units out, nothing lost. Mutation-verified: dropping the pre-split flag fails 2, reverting the line-break fix fails 1, letting whitespace normalisation alter content fails 3.
- `storyboardAnalyzer.test.js` (33): mostly adversarial — fenced JSON, leading chatter, array-shaped classifications, invented element names, invented paragraph numbers, partial coverage, and a model returning its own rewritten text. Mutation-verified: rendering partial results fails 3, trusting model-supplied text fails 5, accepting invented elements fails 1, keeping indices that point at no unit fails 1.
- `storyboardRegistry.test.js` (41): snapshot round-trips, ids that could escape the store directory, one corrupt file not hiding the rest of the history, search inside the script and its outline children, revision chains including a corrupted self-referential one, and that the local half works offline while the model call is gated. Mutation-verified: permissive ids fail 1, shipping the heavy fields in list payloads fails 11, dropping the offline gate fails 1, defaulting away from the Creator role fails 1.
- `storyboardTab.test.js` (43): the fixture is the *real* markup sliced out of `index.html`, so an id renamed in the page cannot keep passing against a stale copy. Covers text coming from the stored units, colour classes from the classification, escaping of script and audit text, the Colour/Plain toggle, the audit panel, the sidebar, inline rename, and the export. Scroll geometry is stubbed because jsdom reports every rect as zeroes, which would hide whether the rail's selection rule works at all. Mutation-verified: rendering model text fails 2, dropping escaping fails 1, picking the first block above the anchor instead of the last fails 2, an external stylesheet in the export fails 1.
- An independent review pass caught the one thing the tests could not: `revisionOf` was stored, exposed over IPC, and documented in the README, but **nothing ever set it and nothing displayed it** — the whole revision feature was unreachable surface. Re-uploads are now chained automatically and labelled in the reading view, with tests and mutation coverage for both halves.
- One bug was found visually rather than by tests, by rendering an export and looking at it: the explanation card's bullet markers came out grey instead of the element colour, because the list items set their own text colour and `currentColor` therefore resolved to ink. Fixed in both the tab and the export, with a test.

## v3.12.2

### Fixes
- **Expired credentials no longer throw you out of the app.** Hive replaced the entire renderer with the credentials page about three seconds after noticing, discarding your current tab, your scroll position, any attachments and anything you had typed — in order to tell you something the banner was already saying. It now notifies, marks the credentials rejected, disables what cannot work, and leaves you exactly where you were. Startup routing is unchanged: launching with already-dead credentials still opens the credentials page, because at that point there is no work to lose.
  - Removing the navigation also removed everything that existed to make it survivable: `_canNavigateNow()`, `_navigationDeferred`, `retryDeferredNavigation()` and the `shouldDeferNavigation` veto (which existed so a transcription mid-job wouldn't lose its result) are all gone.
  - The monitor now keeps polling after expiry instead of stopping. That is what makes not navigating safe — it is the only thing that will notice the credentials being fixed, and it clears the banner and re-enables the controls automatically. Previously stopping was survivable only because the app navigated away and restarted the monitor on save.

- **Controls that need AWS are now disabled when credentials are rejected, not just when offline.** `offlineGuard` gated purely on connectivity, so with a working network and dead credentials every AWS control stayed clickable — you could write a long prompt or queue a pipeline and lose it to a request that was never going to succeed. Gating is now on `awsAvailable()`, which means online **and** credentials not rejected.
  - **The controls that fix credentials deliberately stay enabled** — Save & Test Credentials, Run Setup Check, and its refresh. Disabling those would have left the user reading a banner telling them to do something the UI had just prevented. They are still disabled when genuinely offline, where they cannot work either way.
  - Tooltips name the real cause instead of blaming the network, and `setCredentialState()` now re-gates the controls rather than only repainting the banner.
  - `requireAws(action)` replaces `requireOnline(action)` with a cause-appropriate message; `requireOnline` remains as an alias so existing call sites keep working, and now refuses for rejected credentials too.

### Removals
- **Deleted the advance-warning machinery, which had never worked.** `AWSValidator.parseTokenExpiry()` tried to base64-decode the STS session token as JSON and read an `exp` or `Expiration` field. AWS session tokens are opaque, encrypted blobs — not JWTs, not base64 JSON — and no API takes a token and returns its lifetime. So the parse failed on every real credential, every launch logged `could not parse token expiry — poll only`, and the T-15min and T-2min warning paths (`WARN_15_MS`, `WARN_2_MS`, `_handleWarn15`, `_handleWarn2`) were dead code that had never fired once in production.
  - Predicting expiry needs a timestamp from outside the token: parsed from the credential paste, entered by the user, learned from history, or manufactured by re-minting the session via `AssumeRole` (which caps at 1 hour and would shorten a 12-hour Isengard session). None of those are free, so rather than leave broken prediction in place looking functional, prediction is gone and detection got better.

### Improvements
- **Credential checks now run once a minute instead of once every ten.** `GetCallerIdentity` is free and fast, so this bounds how long a dead credential can go unnoticed to about a minute. It is detection, not prediction — the call cannot report when a token *will* expire, only that it already has.
- The credential banner is no longer dismissible while credentials are rejected, since everything needing AWS is disabled until it's fixed and hiding the only explanation would leave the UI inexplicable. It disappears by itself on recovery.

### Tests
- `credentialMonitor.test.js` rewritten around the new behaviour (16 tests): polling continues after expiry so recovery is noticed, recovery clears the warning, expiry is announced once however many polls confirm it, expiry/recovery/expiry cycles report correctly, a throwing `onExpired` doesn't break the monitor, and the poll interval is one minute. The five deferred-navigation tests were deleted along with the machinery they covered.
- 15 tests added to `offlineGuard.test.js` for credential gating: AWS controls disabled on rejection, the fix-credentials carve-out enabled on rejection but disabled when offline, tooltips naming credentials rather than the network, the upload zone blocked, `setCredentialState()` gating controls, `awsAvailable()` reflecting both causes, a control disabled for its own reasons never wrongly re-enabled, and `requireAws`/`requireOnline` messages.
- Mutation-verified all three load-bearing changes: gating on connectivity alone fails 8 tests, stopping the monitor on expiry fails 3, restoring the 10-minute poll fails 1.

## v3.12.1

### Fixes
- **Web search stayed dead for the whole session on a brand-new install, behind a green tick.** A second failure, hidden behind the one v3.12.0 fixed: because the em-dash description bug blocked the step before it, nobody had ever got this far on a new install.
  - Setup Check persists the Gateway role ARN by calling `settingsManager.saveSettings()` directly, which bypasses the `save-settings` IPC handler — and that handler is the only place that re-initialises web search when the role ARN changes. So the role was created, the ARN was stored, and `webSearchManager` stayed exactly as it had failed at startup (`roleArn required to create web search gateway`) until the app was restarted.
  - The failure was invisible: the agent silently falls back to writing its own HTTP/scraping code via `execute_code`, which from the outside is indistinguishable from web search working. The only recoveries were restarting Hive or finding the retry button in Settings → Web Search.
  - Setup Check now re-initialises web search itself, after the ARN is saved so the new role is the one used. Verified against real AWS that this is safe to do immediately: a freshly created role is accepted by `CreateGateway` on the first attempt, roughly 0.2s after `CreateRole`, so there is no IAM propagation delay to work around. The rest of the path was measured too — gateway `READY` in ~3.2s, web-search target accepted in ~0.2s — confirming nothing else downstream was broken.
  - **The result no longer overstates itself.** Previously the item returned plain success and the row went green as soon as the role existed. It now reports whether web search actually came up; if it did not, the row reads "Needs attention", names the reason, and keeps a Retry button instead of removing it. A green tick over a dead feature is what made this bug invisible in the first place.

### Tests
- **Added a manual live AWS test for Setup Check** (`tests/integration/setup-check-live.js`, `npm run test:integration:aws`). v3.12.0 fixed a validation failure that stopped a brand-new install from creating the Web Search Gateway, but that bug reached a user because nothing exercises Setup Check against real AWS: every unit test mocks the SDK, so they can confirm Hive sends what Hive intends to send and never that AWS still accepts it. This closes that gap for the two Setup Check paths that send free-text metadata — `CreateRole` and `CreateMemory` — by calling the real functions rather than reimplementing them. The transcription buckets are excluded deliberately: `CreateBucket` has no free-text field, so there is nothing to catch, and throwaway buckets would pollute a global namespace.
  - Pre-existence is checked first and anything already present is verified but never deleted, since testing the real path means using the real hardcoded resource names. Only resources the run created are cleaned up, inline policies before the role. Creation requires `ALLOW_AWS_WRITES=1` on top of working credentials, and the Memory check requires `INCLUDE_MEMORY=1` because it is billable and deletes asynchronously.
  - Credentials come from the environment, never Hive's encrypted store — `safeStorage` is bound to the signed app's identity. Exits 0 with an explanation when unconfigured so it never blocks development; `REQUIRE_AWS_CREDS=1` makes that a hard failure if it is ever wired into CI.
  - Manual by design, following the same plain-Node-script conventions as `mantle-live.js`. Not added to any workflow.
- Added 7 tests to `setupWizardIpc.test.js` covering the re-initialisation: that it happens, that it happens *after* the ARN is saved, that a failure to come up is reported rather than hidden, that the role is still reported created when web search fails (it was), that a throwing `initializeWebSearch` does not fail the whole item, and that a context with no web search wiring still works. Mutation-verified: reverting to the shipped behaviour fails 5.
- Added 6 tests to `settingsTab.test.js` for the row's honesty — green only when web search is genuinely up, "Needs attention" plus the reason and a Retry button when it is not, the role ARN field still populated, and other Setup Check items unaffected. Mutation-verified: restoring the always-green badge fails 3.

## v3.12.0

### Fixes
- **A brand-new install could not create the Web Search Gateway.** Setup Check failed with `ValidationError: Value at 'description' failed to satisfy constraint: Member must satisfy regular expression pattern: [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*`. That pattern permits tab, newline, carriage return, printable ASCII and the Latin-1 supplement — and excludes the entire U+2000 block, where em dashes, en dashes, curly quotes and ellipses live. The IAM role's `Description` contained an em dash, so AWS rejected the whole `CreateRole` call and setup dead-ended with an opaque regex complaint.
  - **A second, unhit instance** was waiting in the AgentCore Memory `description`, which would have failed the Memory item of Setup Check the same way.
  - Fixing the two strings alone would not have been enough — the next description written in natural prose would reintroduce it. Added `src/main/awsText.js`: `toAwsText()` transliterates the common typography (dashes, quotes, ellipses, arrows, non-breaking space) to ASCII equivalents and drops anything still outside the accepted range, and it is applied where these fields are sent. Deliberately lossy rather than throwing — a description is cosmetic, and failing a resource creation over its punctuation is exactly the trade the bug got backwards.

- **Hive could get stuck offline until you restarted it.** Reported from the field: a laptop carried between buildings dropped its network for a few minutes, and when it came back the app stayed offline indefinitely with no way to prompt it. Reproduced against v3.11.0 and confirmed fixed.
  - **Cause.** The connectivity check was on a timer — every 20 seconds while offline — and it fired as designed, roughly 540 times over three hours. But before performing the actual reachability probe it consulted Electron's `net.isOnline()`, and **skipped the probe entirely if that returned false**. Moving between buildings is exactly what leaves that flag stuck: wifi disassociates, reassociates on different infrastructure, possibly with a sleep in between. So the app asked "does the OS think we're online?", accepted "no", and never once tried to reach AWS. Because the state never changed, nothing was logged — the failure was completely silent.
  - **The probe is now authoritative** and always runs; `net.isOnline()` is only consulted to log when the two disagree. One extra HTTPS HEAD every 20 seconds while offline is a trivial price for removing a whole class of stuck-offline failures.
  - **Every recovery path was blocked by the same gate.** The OS-event hint from the renderer routed through the same gated re-check, and the credential poll — which would have proved AWS was reachable — was itself skipped whenever the app believed it was offline. Three mechanisms, one shared blocker.
- **Credential checks no longer depend on connectivity state.** `_runPollCheck()` used to return early when the connectivity monitor reported offline. That made an expired token undetectable for as long as that monitor was wrong, so the app blamed the network and genuinely could not tell the user which thing was broken — the check that would have corrected the story was the one being skipped. `quickValidate()` already returns a three-state result distinguishing "could not reach AWS" from "AWS rejected these credentials", which is the right place for that decision. A successful check now also nudges the connectivity monitor, so the two correct each other instead of one silently disabling the other.
- **The connectivity state machine can no longer dead-end.** `_applyState()`'s transition path armed only a debounce, and that debounce had an early return which exited without rescheduling anything — once taken, no timer remained. A recheck is now always scheduled, on every exit path. Separately, a pending transition can no longer be starved: each `recheck()` used to clear and re-arm the debounce, so a retrying app calling `reportNetworkFailure()` could push a recovery out indefinitely.
- Added a **watchdog**: if no probe has been attempted in 15 minutes, one is forced and logged. Restarting the app should never be the only way to recover.

### New Features
- **A "Retry now" button on the offline banner.** Someone who has just walked back into coverage shouldn't have to wait out the next scheduled probe, or guess whether the app has noticed. Previously there was no way to prompt it at all.
- **The banner names the actual problem.** When AWS has *rejected* the credentials the banner says so and points at Settings, instead of reporting "offline" and sending the user to check their network. The retry button is hidden in that case, because retrying cannot help. `get-connectivity-status` and `connectivity-changed` now carry a credential state (`valid` / `rejected` / `unknown`) for this.

### Improvements
- **Window size and position are remembered across launches** (`src/main/models/windowState.js`). Previously Hive opened at a fixed size every time, so anyone whose screen or taste differed from the default resized it on every single launch. Stored in its own small file under `userData` rather than in `settings.json` — this is per-machine UI state, not user configuration, and it has to be readable in the main process before any renderer exists (so `localStorage`, where the sidebar widths live, isn't available either).
  - **Saved bounds are refused if they would land off-screen.** This is the bug the feature usually ships with: restore onto a monitor that has since been unplugged and the window is invisible, with no way to retrieve it. Bounds are only honoured if they still overlap a connected display by at least 120px in both axes — enough to grab and drag back. Verified end-to-end: bounds planted at (4000, 2500) are ignored, with the reason logged, and the fitted default is used instead.
  - Bounds below a window's current minimum are also refused, so raising a minimum in a later release can't leave someone stuck at a size that hides controls. Corrupt or nonsensical state falls back to the default rather than failing.
  - While maximized or full-screen, the *pre-maximize* geometry is kept — storing the filled screen would make the restored size wrong forever. The maximized flag is remembered separately and reapplied.
  - Writes are debounced (resize and move fire continuously while dragging) with an immediate save on close, so an adjustment made just before quitting isn't lost.
- **Windows open larger, and size themselves to the display.** The main window was a fixed 1200×800 and the credentials window 800×600, so content was clipped for no reason on larger screens and had to be resized on every launch. Both now take the largest sensible size for the current display — preferring 1500×1000 and 1040×820, shrunk to fit the work area with a margin, never below a minimum — and set a minimum size so they can't be shrunk into hiding their own controls. Applied to all four places that size a window, so navigating between the credentials page and the main app no longer resets it.

### Tests
- Added `tests/main/awsText.test.js` (15 tests): the constraint accepting ASCII/tab/newline/Latin-1 and rejecting the exact string that broke the install, transliteration preserving readability rather than deleting punctuation, non-transliterable input dropped, non-breaking space normalised, non-strings handled without throwing, and the property that output always satisfies the constraint whatever goes in.
- Added 2 guard tests to `setupWizard.test.js` asserting the value **actually handed to the SDK** satisfies the constraint — not the source literal, so the guard holds however the string is built, and covering every string in the `CreateRole` input rather than just the description. Mutation-verified: reintroducing the em dash exactly as it shipped fails both.
- Added `tests/main/windowState.test.js` (25 tests), mostly about refusing bad state rather than storing good state: round-tripping, per-window-kind separation, corrupt files, unwritable paths, bounds below the minimum, nonsense values, a position on a disconnected display, bounds that only clip a display edge, an unavailable display list, maximized and full-screen handling, debounced saves with an immediate save on close, and listener cleanup. One found a real gap — `screen.getAllDisplays()` returning a non-array (rather than throwing) would have crashed window creation, and therefore startup.
- Added a scenario harness that drives the reported field failure against **both** the released v3.11.0 module and the fix: goes offline correctly, then — with `net.isOnline()` stuck false and the network genuinely restored — v3.11.0 stays offline for a simulated three hours while the fix recovers. Reduced to permanent regression tests: probing despite the OS claiming no interface, trusting the probe over a stuck flag, and recovering while the flag stays wrong. All three fail if the gate is reinstated.
- `connectivityMonitor.test.js` (17): plus recovery without an external nudge, still probing hours later, liveness across repeated flapping, and a pending transition surviving repeated failure reports.
- `credentialMonitor.test.js` (15): the gate test replaced by four — checks run regardless of connectivity state, a successful check nudges the connectivity monitor, expiry is detected even while the monitor believes it's offline, and the reported credential state is `unknown` (not a guess) when AWS is unreachable.
- `offlineGuard.test.js` (56): 11 new for the retry button (delegates to the main process, clears the banner on success, says so when still offline, re-enables on failure) and the credential-aware banner (names the credentials, hides retry when it can't help, still reassures about local work, picks up a verdict from an event).


## v3.11.0

### Fixes
- **The rename button on a saved transcript did nothing.** It used `window.prompt()`, which **Electron does not implement** — Chromium refuses the call and returns `undefined`, which slipped past a `=== null` cancel guard and then threw a `TypeError` on `.trim()`. Renaming is now edited in place: click the pencil or the title, Enter commits, Escape abandons, and clicking away commits rather than discarding a typed name (losing a name to a stray click is worse than an unintended rename, which is trivially undone). An entry with no real name yet starts from an empty field instead of making the user delete an opaque job id first. No test covered the button itself — only the name field used during a live job and the rename IPC — which is why it shipped broken; there are now eleven.

### Improvements
- **Sidebar rows are far easier to scan.** A row carried up to five middot-separated facts under its title, so the one thing you were looking for competed with everything else.
  - The name is now the only thing that competes for attention, with at most one short secondary line beneath it. Duration, language, job name and status moved into a row tooltip, where they cost nothing.
  - **Imported and pre-naming entries show "Untitled recording"** instead of an opaque `transcription-<timestamp>`, which told the user nothing about what the recording was. The job name is in the tooltip.
  - **The source file appears only when it differs from the name.** A default name *is* the file name minus its extension, so showing both just repeated itself; it now surfaces exactly when the entry has been renamed and the original file would otherwise be invisible.
  - While searching, date and duration drop away so the row is name, match count and the matching line — when you are searching, the matched text is the useful part.
- **All three sidebars are horizontally resizable.** Chat, Work and Transcribe were fixed-width, which is what forced rows to truncate in the first place — trimming a row helps, but letting the user decide how much room the list gets removes the constraint. Drag the inner edge, or use the keyboard: the handle is a focusable `separator`, with arrows to nudge, Home/End for the bounds, and double-click to reset. Width is clamped between 180px and 560px and remembered per sidebar. One shared helper (`src/renderer/sidebarResize.js`) serves all three, rather than three implementations that would drift.
  - Widths persist to `localStorage` rather than `settings.json` — it is per-machine UI state, not user configuration needing validation or sync, and a monitor-shaped preference doesn't belong in the settings file.

### Tests
- Added `tests/renderer/sidebarResize.test.js` (23 tests): handle creation and idempotence, keyboard affordances, drag widening/narrowing, width/min-width/flex-basis pinned together, clamping at both default and custom bounds, transitions and text selection suppressed only for the drag, tracking stopped after release, persistence and restore, a stored width clamped when out of bounds, a corrupt stored value ignored, each sidebar independent, storage being unavailable, arrow/Home/End keys, and double-click reset.
- Added 11 rename tests and rewrote the row-rendering tests for the new contract in `transcribeSidebar.test.js` (now 56): the tooltip carrying full detail, the "Untitled recording" placeholder, the source file shown only when it differs, the abandoned flag kept on the row, and Enter/Escape/blur/empty-name/failure behaviour for the inline editor.


## v3.10.0

### New Features
- **Find past transcriptions** — the last step of the Transcribe rework. The registry only ever knew about jobs transcribed since it existed, and it lives in `userData`, which a reinstall or a new machine takes with it. A sidebar button now asks AWS what is actually there and imports whatever is missing.
  - **The output bucket is scanned first**, because it is the richest source. Each completed job since v3.7.0 leaves a `<jobName>.hive.json` sidecar, which restores an entry *exactly as it was* — display name and original `jobId` included — and works even after Transcribe has aged the job out of its own history. A transcript with no sidecar is a pre-v3.7.0 job: imported unnamed rather than given an invented name, so the sidebar shows it with a prompt to name it.
  - **Transcribe's job history is the fallback**, covering jobs whose output went to a service-managed bucket or whose objects have since been deleted. Metadata only — there is no transcript to attach.
  - **Existing local records are never overwritten.** A local record may carry a name the user typed, and AWS knows nothing about that.
  - **Each source fails independently and says why.** Scanning the bucket needs `s3:ListBucket`, which a scoped-down role may not have; that must not stop the job-history pass, and it must not be reported as a bare "0 found", which would read as "there is nothing there". A missing `s3:ListBucket` is named specifically in the result.
  - Both listings follow pagination, so a large history isn't silently truncated to its first page. Imported transcripts go through the same `TranscriptMapper` as the live path, so they are indistinguishable from freshly-made ones.
  - Deliberately a button rather than automatic: it makes real AWS calls, and surprising the user with those is worse than asking them to click. It's disabled while offline like every other network control.

### Documentation
- README now documents the two permissions this needs: **`s3:ListBucket`** on the output bucket (new — nothing else in Hive required it) and `transcribe:ListTranscriptionJobs`. Both are only used by Find past transcriptions; the rest of the Transcribe tab works without them.

### Tests
- Added `tests/main/transcriptionReconciler.test.js` (17 tests): a sidecar restoring the original `jobId` and name, a transcript without a sidecar imported unnamed, transcripts mapped through the shared mapper, a sidecar with no transcript, existing records never overwritten, unrelated bucket objects ignored, one unreadable object not aborting the rest, pagination followed for both listings, job-history imports carrying `OutputLocationType` and real status, deduplication between the two sources, a missing `s3:ListBucket` named specifically while job history still runs, a failed job-history listing keeping what the bucket found, no output bucket configured, offline refusal, and "nothing found" reported without inventing an error.
- Added 7 UI tests to `transcribeSidebar.test.js` (now 42): import counts reported with correct pluralisation, nothing-new stated plainly, partial failures surfaced as warnings including the `s3:ListBucket` hint, imports reported alongside a partial failure, the button restored after a failure, and offline refusal without calling AWS.
- Added a `transcription-reconcile` handler test.

### Fixes
- Two more sources of test-suite flakiness, both real: a test that stubbed `window.OfflineGuard` and then failed leaked the stub into every later test, making unrelated ones behave as if offline — cleanup moved to `afterEach` so it cannot leak. And the `OfflineGuard` stub was incomplete, so `index.js` calling `init()` at module scope threw inside the harness rather than in the code under test. Verified stable across three consecutive full runs.


## v3.9.0

### New Features
- **Search now reads transcript bodies, not just names.** The rest of step 4. This is the capability that makes the history worth having months later: you remember a phrase from the recording, not what you called the file, and a name-only filter — which is all the Chat sidebar does — cannot answer that.
  - Matching runs in the **main process**, because the transcripts are on disk there. Shipping every transcript over IPC on each keystroke would be wasteful, so `registry.search()` scans the files and returns only `{ jobId, matchCount, snippet, snippetStartTime }`.
  - Results show **how many times the phrase occurs** and **a snippet with its timestamp**, windowed around the hit with ellipses. Snippets are inserted with `textContent`, so transcript content can never become markup.
  - Name, source file and AWS job name still match — so a legacy entry stays findable — just without a snippet.
  - Results stay **newest-first rather than ranked by relevance**, so the list doesn't reshuffle unpredictably as you type.
  - The renderer **debounces at 250ms** and shows metadata matches immediately in the meantime, so typing feels responsive while body search catches up. A response for a query the user has already moved on from is discarded, and a failed search falls back to metadata matching rather than emptying the list.

### Tests
- Added 15 tests to `transcriptionRegistry.test.js` (now 37): finding a transcription by words spoken in it, counting occurrences across segments, case-insensitivity, snippet content and timestamp, name/source-file/job-name matching without a snippet, newest-first ordering, records with no transcript, empty and whitespace queries, a phrase that appears nowhere, a corrupt transcript not breaking the search, segments with no usable text, plus `buildSnippet` windowing and its ellipsis edges.
- Added 10 tests to `transcribeSidebar.test.js` (now 35): finding by spoken words, the snippet and its timestamp rendered, match counts including the singular case, snippet text inserted as text rather than markup, the debounce firing once with the final query, metadata matches shown before body results arrive, a stale response discarded when the query has moved on, fallback to metadata matching on failure, and clearing restoring the full list.
- Added a `transcription-search` handler test.

### Fixes
- **The Transcribe sidebar tests were flaky under parallel load, for two real reasons worth recording.** First, each `require()` of the renderer registered another `DOMContentLoaded` listener on the shared jsdom document, so dispatching that event ran *every* accumulated listener — each closed over its own module instance — wiring the same controls repeatedly and making handler-count assertions depend on how many tests had run before. The suite now calls the exposed `initTranscribeSidebar()` directly instead of dispatching. Second, the new debounce left a live 250ms timer whenever a test typed into the search box, which fired during a *later* test and re-rendered the shared list from stale state; the suite now uses fake timers with an explicit `flushDebounce()` helper and clears pending timers in `afterEach`. Verified stable across four consecutive full runs.
- `initTranscribeSidebar()` is idempotent per module instance, so re-entry refreshes the list rather than double-wiring handlers.


## v3.8.0

### New Features
- **The Transcribe tab now has a history sidebar: past transcriptions are browsable, searchable, renameable and deletable.** Step 3 of the rework — the visible half. The registry added in v3.7.0 finally has a way to see it, so a transcription you have already paid for is one click away instead of gone.
  - **A collapsible sidebar** reusing the Chat tab's existing idiom (`.conv-sidebar`, `.conv-list`, `.conv-item`, the search wrap), so the three tabs with lists look and behave alike. Collapsing it returns the content area to the original full-width two-pane layout, because three panes at the default 1200px window is tight.
  - **List entries show what you need to recognise them** — name, date, duration — and distinguish their state: a running job spins at the top of the list, a paused one shows an amber marker, and an abandoned one is labelled "still on AWS" because that is exactly the kind you would otherwise re-run. **Legacy jobs from before naming are shown, not hidden**, with an invitation to name them.
  - **Selecting a saved transcript never disturbs a job in flight.** This is only safe because v3.6.0 moved job ownership into the main process; before that, navigating away was what killed a job.
  - **No player for a saved transcript.** The player is handed a local `File` via `createObjectURL`, and by the time you reopen a transcript that object is long gone and the file may have moved — so the header names the source file instead. Streaming from the input bucket is a follow-up, unblocked by the media key v3.7.0 records.
  - **Deleting is two-level.** Local removal is the default; deleting the transcript, its sidecar and the AWS job is a separate checkbox that is never pre-armed, with the confirmation spelling out that it cannot be undone. The AWS copy is the tier that survives losing local state and outlives Transcribe's job-history retention, so destroying it has to be a deliberate act rather than a side effect of tidying a list. AWS deletions are individually tolerant — a missing permission or a failure on one object still lets the local removal proceed, so an entry can't get stuck in the list forever. An AWS delete is refused outright while offline rather than half-applied.
  - Search covers the name and the source file name. Searching transcript *bodies* is the next step, and is what makes this genuinely useful months later when you remember a phrase but not what you called the file.

### Fixes
- **The Transcribe sidebar could have been left unwired by an unrelated startup failure.** `DOMContentLoaded` runs `loadPromptTemplates()`, `loadBedrockModels()`, `setupFileUpload()`, `setupCustomPromptsManagement()` and `await renderConversationList()` as a single unguarded chain — one throw strands everything after it. The sidebar is the user's only route back to past transcripts, so it is now wired first and inside its own `try`/`catch`, matching how the Work/Swarm/Settings tab inits are already individually guarded.
- `initTranscribeSidebar()` is idempotent. Calling it twice would double every handler, so the sidebar toggle would fire twice and appear not to work at all.
- `transcription-list` responses are coerced to an array before use, so a malformed IPC response can't break the sidebar.

### Tests
- Added `tests/renderer/transcribeSidebar.test.js` (25 tests): list rendering with date and duration, legacy unnamed entries shown with a naming prompt, abandoned entries marked as still on AWS, empty-library and failed-load states, search by name and by source file with a distinct no-matches message and a working clear button, opening a saved transcript (header contents, player hidden, download/copy revealed, active row marked, a vanished entry warning rather than blanking), an abandoned entry explaining the job may still be on AWS, New Transcription returning to the drop zone and refusing while a job runs, the sidebar toggle, a running job appearing at the top of the list, **opening a saved transcript not cancelling a running job**, and the delete flow (asks first, AWS box unchecked by default, both options passed through correctly, returns to the drop zone, no-ops with nothing selected).
- Added 6 delete-handler tests to `transcriptionIpc.test.js` (now 26): local-only by default leaving the durable copy untouched, deleting transcript + sidecar + AWS job when asked, still removing locally when an AWS delete is denied, refusing an AWS delete while offline, a local-only delete working offline, and an unknown job removing nothing from AWS.


## v3.7.0

### New Features
- **Every transcription is now recorded and named.** Step 2 of the Transcribe rework. This is where the problem that started it actually stops: a completed job on AWS used to be unreachable from Hive the moment the renderer moved on — nothing recorded that it existed, what it was called, or where its transcript lived — so users re-ran transcriptions they had already paid for. Still no browsing UI (that's step 3), but from this release forward every job is recoverable.
  - **A local registry** (`src/main/models/transcriptionRegistry.js`, stored under `userData/transcriptions/`) holding the job name, display name, source file, media S3 key, language, status, timestamps, segment count and duration. Follows the same plain-JSON convention as the conversation and work-history managers, so it is readable offline and survives losing AWS access entirely. Metadata and transcript are **separate files**: `list()` renders a sidebar and a transcript can run to hundreds of kilobytes, so listing reads a few hundred bytes per entry rather than the whole corpus.
  - **A sidecar object in the output bucket** — `<jobName>.hive.json` written next to the transcript, carrying the same metadata. This is the durable tier: a single `ListObjectsV2` rebuilds the index, display names included, which outlives the retention window that eventually removes AWS job metadata. It only became possible once v3.5.0 guaranteed the output bucket exists and belongs to the user. Best-effort by design — the transcript is already retrieved and saved locally by then, so a failed sidecar write costs the AWS-side recovery tier, not the job.
  - **Names, derived and editable.** The default is the media file name with the extension stripped, kept human-readable rather than slugified. The progress pane now shows a pre-filled, focused name field: accepting the default costs nothing, typing over it is one gesture, and it is never a gate — the job is already running by the time the field appears. Renaming works whether the job is still running (the name lives in memory, and the registry write picks up whatever it is by completion) or already finished (the registry record is updated and the sidecar refreshed, so the two tiers don't drift). Renaming offline still works; only the sidecar refresh is skipped.
  - **Abandoned jobs are recorded too.** A job that paused past its budget is still running on AWS and still collectable, which makes it exactly the kind a user would otherwise re-run. Cancelled jobs are deliberately *not* recorded — the user threw those away on purpose.
  - Persistence happens **before** the completion notification. The opposite order would announce success for something unrecoverable if the app died in between.

### Fixes
- **An abandoned transcription reported a generic failure instead of "paused too long".** Found by a test written for this release, and present since v3.4.0. `parkUntilResumable()`'s budget-exhausted path calls `finish()` *before* the retry timer is created, and the timer was declared with `const` further down the same scope — so `clearTimeout()` hit its temporal dead zone and threw a `ReferenceError`. That propagated as an ordinary error, so instead of `ABANDONED` and "the job is still running on AWS", the user got "Transcription Failed" and no indication their work was still waiting to be collected. No existing test reached it because none exhausted the 30-minute pause budget.

### Tests
- Added `tests/main/transcriptionRegistry.test.js` (22 tests) against a real temp directory, since the whole contract is about what survives on disk: round-tripping records and transcripts, carrying the media key through, deriving segment count and duration so listing needs no transcript, the metadata/transcript file split, recording a transcript-less abandoned job, newest-first ordering, skipping a corrupt record rather than failing the whole list, rename semantics, and local-only removal.
- Added 18 tests to `transcriptionRunner.test.js` (now 54): registry record and sidecar contents on completion, persistence ordered before the notification, a sidecar or registry failure not failing a successful job, abandoned jobs recorded and cancelled jobs not, the sidecar skipped without an output bucket, `renameTranscription` covering the in-flight and finished cases plus the sidecar refresh and the offline path, and two regression tests for the budget-exhaustion bug above.
- Added 3 handler tests to `transcriptionIpc.test.js` (now 20) for `transcription-list` and `transcription-get`, and 5 naming tests plus a re-attach assertion to the renderer suite (now 53): the field pre-filled from the file name, appearing without blocking the job, submitting a rename on edit, refusing a blank name, a failed rename not disturbing the job, and the authoritative name restored on re-attach.


## v3.6.0

### New Features
- **The main process now owns transcription jobs; the renderer only observes them.** Step 1 of the Transcribe rework (see the v3.4.0 TODO for the full design). Result delivery used to be the renderer's in-flight `invoke('transcribe-media')` promise, so *any* renderer teardown — the credential-expiry navigation, a manual reload, a crash — discarded a transcript the main process had already successfully retrieved, while the job carried on running and billing on AWS. Nothing in the UI looks different yet; this is the plumbing everything else depends on.
  - **`transcribe-media` now returns as soon as the job is running** (`{ status: 'STARTED', jobId, displayName, sourceFile }`). The outcome arrives as a terminal event — `transcription-complete`, `-cancelled`, `-abandoned` or `-failed` — each carrying the `jobId` so a stale outcome can't overwrite whatever the user is looking at now.
  - **Events are addressed to the live window, resolved at send time**, never to the `event.sender` that started the job. A captured sender is stale after a reload and silently drops every later event, including the one carrying the transcript. This single detail is what makes the rest possible, and it has a dedicated test plus a mutation check.
  - **A reloaded renderer can re-attach.** New `get-transcription-state` reports whether a job is running along with its current status and message, so the pane rebuilds — including the paused presentation — instead of sitting empty while a job runs invisibly behind it.
  - **Groundwork for naming and the job registry**: each job now carries a Hive-side `jobId` (assigned up front, since the AWS job name isn't known until the media has uploaded), a `displayName` derived from the media file name with the extension stripped, and the **media S3 key**. That last one matters — the input key is `${Date.now()}-${originalname}`, which is not derivable from the AWS job name, so a job previously had no path back to its own media. Capturing it now is trivial; reconstructing it later would be impossible. A `rename-transcription` handler is in place for the naming UI.

### Refactors
- Extracted `src/main/models/transcriptionRunner.js` from `ipc/bedrock.js`, which had accumulated the entire transcription state machine alongside unrelated Chat model code (486 lines down to 198). The runner owns the job lifecycle and resolves with an outcome; the IPC layer turns that outcome into an event. Running a job and delivering its result are now deliberately separate concerns — which is what let the tests split cleanly along the same seam.

### Tests
- Replaced `tests/main/transcription.test.js` with two suites mirroring the code split. `transcriptionRunner.test.js` (39 tests) carries the behaviour guarantees forward against the runner directly: the configuration guard costing nothing, network and auth pausing with resume, paused time not consuming the poll budget, notify-once-per-job, the S3 result fetch pausing rather than discarding a transcript AWS already produced, cancellation including aborting an in-flight upload and queuing the delete when offline, plus the new `createJob`/`deriveDisplayName`/`getTranscriptionState`/rename behaviour.
- `transcriptionIpc.test.js` (17 tests) covers delivery with the runner mocked: the handler resolving before the job finishes, each terminal event firing with the right `jobId` and payload, the job slot released on all four terminal paths, an outcome arriving after the window is gone not throwing, and — the one that pins the bug — **the outcome never being delivered via the invoking `event.sender`**.
- `tests/renderer/index.test.js` grew to 48: the three tests that assumed the outcome was the resolved invoke were reworked onto events, plus `uploadFile` returning immediately, completion and failure rendering from events, stale-`jobId` filtering for both terminal and progress events, start failures (offline, unconfigured) reported inline as distinct from job failures, and a new re-attach suite covering a restored progress pane, a restored paused presentation, a re-attached renderer receiving the eventual outcome, and a failed state lookup not breaking startup.
- Mutation-verified: making `emitToRenderer` capture the window once — recreating the stale-sender bug — fails four runner tests including the dedicated one, and restoring it returns all 39 to green.


## v3.5.0

### Fixes
- **The transcription output bucket is now a real, validated, provisionable setting instead of a silent failure.** `outputBucketName` defaults to empty — as it must, since S3 bucket names are unique across all of AWS and no default is possible — but `bedrock.js` passed it to `StartTranscriptionJob` unconditionally, so a blank setting sent `OutputBucketName: ""`. An empty string cannot satisfy that parameter's documented pattern (`[a-z0-9][\.\-a-z0-9]{1,61}[a-z0-9]`), so the job was rejected by AWS with an opaque validation error. Three things combined to let that reach users:
  - The only validation that ever enforced the field lived in `src/pages/settings.html` / `src/renderer/settings.js` — a standalone settings page that **nothing loads any more**. When settings moved into the in-app Settings tab, the check wasn't carried across, and `settingsTab.js` saved both bucket fields with no validation at all.
  - Setup Check only ever looked at the *input* bucket (`_checkTranscriptionBucket(s3, settings.bucketName)`), so the checklist reported all-clear with the output bucket blank.
  - `settingsManager.validateSettings()` explicitly allows empty strings for both bucket names, so nothing downstream objected either.

  Fixed at every layer, and deliberately without swallowing or defaulting the value — a missing bucket is now something the user is told about and helped to fix, not something Hive papers over:
  - **`transcribe-media` refuses the job up front**, naming whichever of Input/Output S3 Bucket is unset and pointing at Settings → Configuration and Setup Check. The check runs *before* the S3 upload: previously a misconfigured job would upload the media, then fail, leaving the file sitting in S3 and billed for a job that was never startable.
  - **Setup Check gains a Transcription Output Bucket item**, checked and created independently like every other item. `_checkTranscriptionBucket` became the shared `_checkBucket(s3, name, { purpose, suggested })` so the two buckets can't drift apart in behaviour, and the existing item is relabelled "Transcription Input Bucket" so the two are distinguishable.
  - **Both bucket fields pre-fill with an account-scoped suggestion** (`hive-media-<accountId>` / `hive-transcripts-<accountId>`, derived from `GetCallerIdentity`) that the user can accept or overwrite. They're real editable field values rather than placeholders, so saving keeps them. Creating from Setup Check with a blank setting uses the same suggestion and **persists the name it used**, so Settings can't disagree with the bucket that now exists.
  - **The Settings tab validates on save**, refusing with an actionable message instead of storing a blank that only surfaces as an AWS error later. Both inputs are marked `required` with help text explaining their distinct roles.
- The input bucket got the same treatment throughout. It had the identical problem — no default, no validation in the live UI — and a blank value sent `Bucket: ''` to S3, failing with a different but equally opaque error.

### Removed
- Deleted `src/pages/settings.html` and `src/renderer/settings.js`. Nothing loaded them; they were a second, divergent settings implementation whose stale validation made the output-bucket check *look* like it existed while the live UI had none.

### Tests
- Added 7 guard tests to `tests/main/transcription.test.js` (now 28): refuses when either or both buckets are unset with the right setting named, points at Settings and Setup Check, carries a `HIVE_TRANSCRIPTION_UNCONFIGURED` code, releases the job slot for a corrected retry, and — the one that pins the cost behaviour — asserts no `Upload` is constructed and no Transcribe call made before failing. Verified by mutation: removing the guard fails all 7 (and hangs them, which is precisely the original bug's shape — the job proceeded instead of failing fast) while every other test stays green.
- Added 8 tests to `tests/main/setupWizard.test.js` (now 30): suggestion naming and S3-rule conformance, null when the account id is unknown, both buckets checked rather than just the input one, the output bucket reported missing with its suggestion, and `checkStatus()` still mutating nothing now that it makes an STS call.
- Added `tests/main/setupWizardIpc.test.js` (14 tests): creating the configured output bucket, falling back to the suggestion when unconfigured, persisting the name so Settings matches reality, *not* rewriting settings when the configured name was already used, the same fallback for the input bucket, the error when the account id can't be resolved either, offline refusal, and unknown item ids.
- Added `tests/renderer/settingsTab.test.js` (11 tests): save refused for either or both blank buckets with the right wording, saved once both are set, the Save button re-enabled after a refusal, suggestions pre-filling only blank fields and never overwriting a user's own name, and a failed suggestion lookup not breaking the Settings load.

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
- **Rework the Transcribe tab, and add naming + search over previous transcriptions.** Tabled deliberately: it is a feature, and the offline-stability work it was discovered alongside was a bug fix that shouldn't wait behind it. Design settled — see below; implement in the stated order.

  **Why.** Two distinct data-loss problems. (a) A completed job on AWS is unreachable from Hive once the renderer moves on, so users re-run transcriptions they have already paid for. (b) Result delivery is tied to the renderer's in-flight `invoke('transcribe-media')` promise, so *any* renderer teardown — credential-expiry navigation, reload, crash — discards a transcript the main process already retrieved successfully.

  **Verified API constraints** (these rule out the obvious approaches, so don't re-derive them):
  - `TranscriptionJobName`: 1–200 chars, pattern `^[0-9a-zA-Z._-]+` — **no spaces** — case-sensitive, unique per AWS account (duplicate ⇒ `ConflictException`), and **no rename API**. Also becomes the default output file name.
  - `OutputKey`: 1–1024, pattern `[a-zA-Z0-9-_.!*'()/]` — allows `/` for sub-folders, still no spaces.
  - `Tag` value: 0–256 chars, **no documented charset restriction** — can hold `AWS Keynote — Draft 3` verbatim.
  - `ListTranscriptionJobs` returns `TranscriptionJobSummary`, which has **no `Tags` field**. So a name in tags costs one extra API call *per job* to read back, while a name encoded in the job name is free. It does include `OutputLocationType` (`CUSTOMER_BUCKET | SERVICE_BUCKET`), which distinguishes post-v3.5.0 jobs from legacy ones.

  **Storage model** — four tiers, so recovery degrades gracefully instead of cliff-edging:
  1. **Local registry** (`userData/transcriptions/`) — display name, source file name, media S3 key, job name, timestamps, status. Mutable source of truth for the UI; works offline; lost with userData.
  2. **Slug in the job name** — `<slug>-<timestamp>`. The timestamp preserves the per-account uniqueness guarantee so two files called "Keynote" can't collide. Free to enumerate from the list call, survives userData loss, lossy (spaces ⇒ hyphens), immutable after creation.
  3. **Sidecar object in the output bucket** — `<jobName>.hive.json` alongside the transcript, holding the display name, source file name and media key. **This is the strongest tier and only became possible once v3.5.0 guaranteed a user-owned output bucket:** a single `ListObjectsV2` rebuilds the entire index, names included, with no dependence on Transcribe's job history — so it outlives the retention window that kills tiers 2 and 3.
  4. **Job tag** (optional) — full-fidelity name, visible in the AWS console. Confirm Transcribe exposes `TagResource` before relying on it for renames.

  Recovery ladder: registry present ⇒ everything works offline; registry lost, bucket intact ⇒ `ListObjectsV2` rebuilds names *and* transcripts; bucket gone, job history intact ⇒ `ListTranscriptionJobs` gives recognisable slugs and dates.

  **Naming UX — do not add a gate.** Keep the current instant start (dropping a file begins the job immediately). Show an **editable name field in the progress pane**, pre-filled from the media file name with the extension stripped, focused so typing over it is one gesture. Zero added clicks for anyone who doesn't care; nothing is ever unnamed, because the derived default is written to the job name slug and sidecar at job start, before any user interaction. A later edit updates the registry and sidecar (and tag if available); the job-name slug stays as-derived — it's a recovery aid, not the display name. Rejected: a blocking modal before every job (friction, when the file name is nearly always the answer) and naming only after completion (an interruption leaves you back at a timestamp).

  **Record the media S3 key.** The input object key is `${Date.now()}-${originalname}`, which is *not* the job name, so there is currently no path from a job back to its media. Capturing the key in the registry and sidecar is trivial while building them and effectively unreconstructable afterwards.

  **UI.** Reuse the existing sidebar idiom rather than inventing one — the Chat tab already has `.conv-sidebar` / `.conv-sidebar-header` / `.conv-search-wrap` (+ icon/input/clear) / `.conv-list` / `.conv-item` (+ `-title`, `-delete`) / `.conv-no-results`, and the Work tab adds a collapsible variant via `workSidebarToggle`. Work history also already has a rename flow (`renameInput`/`renameSaveBtn`, `work-history-rename` IPC).
  - Add a collapsible left sidebar to `transcribe-page` (currently `row g-12` with two `col-md-6` panes). Default open — discovery is the point — but collapsible, because three panes at the default 1200px window is tight (~260px sidebar + two ~470px panes).
  - Three states: **nothing selected** (sidebar + prominent drop zone), **job running** (sidebar + inline progress with the editable name field), **viewing a past transcript** (sidebar + transcript, header showing name/source/date, click-to-rename).
  - List items must distinguish running (spinner, matching the nav-item spinner from v3.3.0), paused (warning treatment, matching the paused progress presentation), completed, failed, and legacy-unnamed. Show legacy jobs rather than hiding them, with an invitation to name them — naming one writes a sidecar and pulls it into the new model.
  - **No media player for past transcripts in v1.** The player uses `URL.createObjectURL(file)` on a local `File` that is gone by then, and the local file may have moved. Show the source file name instead. Streaming from the input bucket via a presigned GET is a follow-up, unblocked by recording the media key (`s3:GetObject` is already granted).
  - **Delete needs two levels.** Removing the local copy is cheap; deleting the S3 transcript is irreversible. Default to local-only with an explicit opt-in to also delete from AWS — never one button that silently destroys the durable copy.
  - **Search name *and* transcript body**, with match snippets, rather than the name-only filter the Chat sidebar uses. That's the actual retrieval need, it's nearly free once transcripts are stored locally, and it works offline.

  **Implementation order** — chosen so data loss stops before any UI exists, and each step ships independently:
  1. ~~**Main-owned job state.**~~ **Done in v3.6.0.** The main process owns the job and emits progress/terminal events; the renderer subscribes and can re-attach after a reload. This fixed (b) on its own and was a hard prerequisite — selecting a past transcript mid-job is exactly the navigation that would otherwise kill the job. The pausable job state from v3.4.0 sits underneath unchanged; it was a change to result *delivery* only. `jobId`, `displayName` and the media S3 key are now recorded on each job, ready for the registry.
  2. ~~**Registry + sidecar writes + derived naming at job start.**~~ **Done in v3.7.0.** Local registry under `userData/transcriptions/` (metadata and transcript in separate files so listing stays cheap), sidecar `<jobName>.hive.json` in the output bucket, derived-and-editable display names, abandoned jobs recorded. This is where (a) stopped.
  3. ~~**Sidebar list, select-to-view, New Transcription.**~~ **Done in v3.8.0.** Collapsible sidebar reusing the Chat tab's idiom, entries showing name/date/duration and job state, legacy entries shown with a naming prompt, no player for saved transcripts, and two-level delete (local by default, AWS opt-in).
  4. ~~**Rename, then search.**~~ **Done in v3.8.0 (rename, name/source filtering) and v3.9.0 (full-text over transcript bodies, with match counts and timestamped snippets).**
  5. ~~**Reconciliation**~~ **Done in v3.10.0.** "Find past transcriptions" scans the output bucket (sidecars first, then bare transcripts) and falls back to `ListTranscriptionJobs`, never overwriting local records, with each source failing independently and reporting why.

  **Also outstanding:**
  - Reconciliation by bucket listing needs **`s3:ListBucket`** on the output bucket, **documented in the README as of v3.10.0**. (Note `ListBuckets` in `awsValidator.js` is the account-level action, a different thing.)
  - **Output object layout is deliberately flat.** Hive does not set `OutputKey`, so the transcript object is named after the job name at the bucket root. That string links a registry entry to its S3 object. Flat is a deliberate choice — the job name is already unique and parseable, and structure buys little when the registry holds the metadata. Changing it after the registry ships means migrating already-transcribed jobs.
  - **Verify Transcribe's job-history retention window.** 90 days is commonly cited but was not confirmed against current AWS docs. The sidecar design makes Hive robust either way, so this is a documentation detail.
  - Cross-restart recovery of an in-flight job falls out of the registry naturally and belongs here, not in the offline work, which covers outages *within* a session only.
  - An earlier draft of this note claimed Transcribe "hands back a pre-signed `TranscriptFileUri` that expires". That is the documented behaviour when `OutputBucketName` is *omitted*; Hive was sending an empty string, which cannot satisfy the parameter's pattern, so the real symptom was a rejected job. Fixed in v3.5.0.

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
