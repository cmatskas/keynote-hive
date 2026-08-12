#!/usr/bin/env node
/**
 * Live integration check against the real Amazon Bedrock Mantle endpoint.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * strandsAgentFactory.js's unit tests (tests/main/strandsAgentFactory.test.js)
 * mock @strands-agents/sdk/models/anthropic and .../openai entirely — they
 * verify Hive's own routing *logic* ("given this model ID, do we build this
 * URL?") but can never verify that URL is still what Mantle actually expects
 * *today*, because nothing in that suite ever makes a real HTTP request.
 *
 * That gap is exactly what let two real incidents slip through unit tests
 * and reach production before being caught by a user report:
 *   1. The original Anthropic 404 (baseURL included a stray /v1 that
 *      @anthropic-ai/sdk's Messages.create() also appends, producing
 *      /v1/v1/messages) — fixed in v3.0.1.
 *   2. A second Anthropic 404, caused by Mantle itself changing its
 *      routing (bare host + /v1/messages, previously correct, started
 *      404ing; Mantle added a required /anthropic provider prefix) —
 *      fixed in v3.1.2.
 *
 * Both were upstream-API-contract problems a mocked unit test structurally
 * cannot detect. This script calls the REAL Mantle endpoint through Hive's
 * actual createAgent() factory (not a hand-rolled reimplementation of the
 * HTTP call) for one minimal, cheap request per routing branch, so a
 * routing change like either incident above produces an immediate,
 * concrete failure the next time this runs — rather than only being
 * discovered when a user hits it in Chat or Work.
 *
 * WHY A PLAIN SCRIPT INSTEAD OF A JEST TEST
 * -------------------------------------------
 * @strands-agents/sdk ships as pure ESM ("type": "module", no CJS build).
 * Every other test file in this repo works around that by mocking the
 * package entirely (jest.mock('@strands-agents/sdk', ...)) — but this
 * suite's entire purpose is to exercise the REAL, unmocked SDK against the
 * real endpoint, so that workaround isn't available here. Rather than
 * introduce a Babel/ESM transform pipeline into the shared Jest config
 * just for this one file (a bigger, riskier change than the goal
 * warrants), this runs as a plain Node script with its own minimal
 * assert-and-report logic. It still gets wired into npm scripts the same
 * way a test would (`npm run test:integration`), and exits non-zero on
 * failure so it works correctly in CI regardless.
 *
 * COST / SAFETY
 * -------------
 * - Makes real, billable Mantle API calls. Never run automatically —
 *   invoke explicitly via `npm run test:integration`.
 * - Each call uses maxTokens: 16 (Mantle's minimum for the OpenAI-compatible
 *   route) and a cheap model in each family.
 * - Requires MANTLE_API_KEY and AWS_REGION in the environment — never
 *   reads Hive's own encrypted app credentials file. Exits with a clear
 *   message (not an obscure crash) if MANTLE_API_KEY is missing.
 *
 * RECOMMENDATION FOR ONGOING PROTECTION
 * ---------------------------------------
 * Run this on a schedule (e.g. a daily GitHub Actions cron job) in
 * addition to running it manually after any Mantle-related bug report —
 * that is the only way a routing change like the two above gets caught
 * automatically rather than by the next user who hits it. Setting up that
 * schedule is a repository/CI configuration decision outside what's done
 * in this change.
 */

const { createAgent } = require('../../src/main/models/strandsAgentFactory');

const MANTLE_API_KEY = process.env.MANTLE_API_KEY;
const REGION = process.env.AWS_REGION || process.env.MANTLE_REGION || 'us-east-1';

if (!MANTLE_API_KEY) {
  const message =
    '\n[mantle-live] MANTLE_API_KEY not set.\n' +
    'To run this check: MANTLE_API_KEY=<your key> AWS_REGION=us-east-1 npm run test:integration\n';
  console.error(message);
  // In CI (release gate, scheduled job), a missing key must be a hard
  // failure — silently skipping would let a release ship without ever
  // having actually verified Mantle routing. Locally, a missing key
  // should never block a contributor who hasn't configured Mantle access,
  // so the default stays a clean skip. Set REQUIRE_MANTLE_KEY=1 to switch
  // to the strict CI behavior.
  process.exit(process.env.REQUIRE_MANTLE_KEY ? 1 : 0);
}

/**
 * One minimal real completion through createAgent(). Throws on any
 * routing/HTTP error — that's the signal this script exists to surface.
 */
async function runMinimalCompletion(modelId) {
  const { agent, dispose } = createAgent({
    modelId,
    region: REGION,
    mantleApiKey: MANTLE_API_KEY,
    systemPrompt: 'You are a helpful assistant. Respond in one short word.',
    tools: [],
    id: 'integration-check',
    // GPT-5-class models are reasoning models: internal reasoning tokens
    // count against this budget even without explicitly requesting
    // reasoning effort (well-documented OpenAI/Mantle behavior, and
    // confirmed by an intermittent MaxTokensError failure on
    // openai.gpt-5.6-sol in a real scheduled run — a too-small budget
    // sometimes gets entirely consumed by invisible reasoning tokens
    // before any visible output token is produced, which is why this
    // failed only some runs rather than every run). 16 was enough for
    // Anthropic/Gemma (non-reasoning) but not reliably enough for GPT-5.
    // 64 gives real headroom without meaningfully increasing cost for a
    // one-word-response check.
    maxTokens: 64,
  });

  let fullText = '';
  try {
    for await (const streamEvent of agent.stream([{ role: 'user', content: [{ text: 'Say hi.' }] }])) {
      if (streamEvent.type === 'modelStreamUpdateEvent') {
        const inner = streamEvent.event;
        if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          fullText += inner.delta.text;
        }
      }
    }
  } finally {
    dispose();
  }
  return fullText;
}

// One minimal, cheap model per branch in strandsAgentFactory.js's
// basePath logic:
//   - Anthropic family -> /anthropic
//   - openai.gpt-5.* -> /openai/v1
//   - other OpenAI-compatible (here: google.*) -> /v1
const CHECKS = [
  { label: 'Anthropic family (/anthropic branch)', modelId: 'anthropic.claude-haiku-4-5' },
  { label: 'openai.gpt-5.* (/openai/v1 branch)', modelId: 'openai.gpt-5.6-sol' },
  { label: 'other OpenAI-compatible, e.g. google.* (/v1 branch)', modelId: 'google.gemma-4-31b' },
];

async function main() {
  console.log('\n=== Live Mantle integration check ===\n');
  let failures = 0;

  for (const { label, modelId } of CHECKS) {
    process.stdout.write(`${label} [${modelId}] ... `);
    try {
      const text = await runMinimalCompletion(modelId);
      if (typeof text === 'string' && text.length > 0) {
        console.log(`OK ("${text.trim()}")`);
      } else {
        console.log('FAIL (empty response)');
        failures++;
      }
    } catch (err) {
      console.log(`FAIL (${err.message})`);
      failures++;
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures}/${CHECKS.length} checks failed — Mantle routing may have changed. See strandsAgentFactory.js.`);
    process.exit(1);
  }
  console.log(`All ${CHECKS.length} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[mantle-live] Unexpected error:', err);
  process.exit(1);
});
