#!/usr/bin/env node
/**
 * Live integration check against the real Amazon Bedrock (bedrock-runtime)
 * endpoint, successor to mantle-live.js after the Mantle -> Bedrock switch.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * strandsAgentFactory.js's unit tests mock @strands-agents/sdk/models/bedrock
 * entirely — they verify Hive's own construction logic ("given this model ID,
 * do we build this config?") but can never verify that config is still what
 * Bedrock actually accepts *today*, because nothing in that suite ever makes
 * a real HTTP request. On Mantle, that gap let two routing incidents (v3.0.1
 * and v3.1.2) reach production before being caught by a user report; the
 * same class of risk exists on Bedrock (model IDs disappearing from the
 * catalog, inference-profile requirements changing, bearer-auth behavior).
 *
 * This script calls the REAL bedrock-runtime endpoint through Hive's actual
 * createAgent() factory for one minimal, cheap request per default model,
 * plus a prompt-caching assertion. Specifically verified:
 *   1. Long-term Bedrock API keys are accepted as bearer auth on Converse
 *      (BedrockModel's apiKey option) — the assumption the whole migration
 *      rests on.
 *   2. Every model ID in Hive's default Settings list actually exists on
 *      Bedrock and answers (catalog drift check).
 *   3. Prompt caching works end to end (cache write then cache read).
 *
 * WHY A PLAIN SCRIPT INSTEAD OF A JEST TEST
 * -------------------------------------------
 * @strands-agents/sdk ships as pure ESM (no CJS build); every Jest suite in
 * this repo works around that by mocking the SDK, which is exactly what this
 * script must not do. Same reasoning as mantle-live.js before it.
 *
 * COST / SAFETY
 * -------------
 * - Makes real, billable Bedrock API calls. Never run automatically —
 *   invoke explicitly via `npm run test:integration`.
 * - Each call uses a small output budget and short prompts.
 * - Requires BEDROCK_API_KEY (or legacy MANTLE_API_KEY — same kind of key,
 *   and the CI secret still carries that name) and AWS_REGION. Never reads
 *   Hive's own encrypted app credentials.
 */

const { createAgent } = require('../../src/main/models/strandsAgentFactory');
const { tool } = require('@strands-agents/sdk');
const { z } = require('zod');

const API_KEY = process.env.BEDROCK_API_KEY || process.env.MANTLE_API_KEY;
const REGION = process.env.AWS_REGION || 'us-east-1';

if (!API_KEY) {
  const message =
    '\n[bedrock-live] BEDROCK_API_KEY (or legacy MANTLE_API_KEY) not set.\n' +
    'To run this check: BEDROCK_API_KEY=<your key> AWS_REGION=us-east-1 npm run test:integration\n';
  console.error(message);
  // In CI a missing key must be a hard failure — silently skipping would let
  // a release ship unverified. Locally it stays a clean skip. The strict
  // env var keeps its historical name (REQUIRE_MANTLE_KEY) because the CI
  // workflows already set it; REQUIRE_BEDROCK_KEY is accepted too.
  process.exit(process.env.REQUIRE_MANTLE_KEY || process.env.REQUIRE_BEDROCK_KEY ? 1 : 0);
}

/**
 * One completion through createAgent() with usage capture (the SDK's
 * modelMetadataEvent carries cacheReadInputTokens / cacheWriteInputTokens,
 * mapped from Converse's cacheReadInputTokens / cacheWriteInputTokens usage
 * fields). Throws on any routing/HTTP/auth error — the signal this script
 * exists to surface.
 */
async function runCompletion(modelId, { systemPrompt = 'You are a helpful assistant. Respond in one short word.', maxTokens = 256 } = {}) {
  const { agent, dispose } = createAgent({
    modelId,
    region: REGION,
    mantleApiKey: API_KEY,
    systemPrompt,
    tools: [],
    id: 'integration-check',
    // Reasoning models consume part of the output budget with internal
    // reasoning tokens before any visible text appears (learned empirically
    // on Mantle: 16 was enough for Claude, not for GPT-5-class; Grok needed
    // 1000). 256 is a safe general default for a one-word answer here.
    maxTokens,
  });

  let fullText = '';
  let usage = null;
  try {
    for await (const streamEvent of agent.stream([{ role: 'user', content: [{ text: 'Say hi.' }] }])) {
      if (streamEvent.type === 'modelStreamUpdateEvent') {
        const inner = streamEvent.event;
        if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          fullText += inner.delta.text;
        } else if (inner.type === 'modelMetadataEvent' && inner.usage) {
          usage = inner.usage;
        }
      }
    }
  } finally {
    dispose();
  }
  return { text: fullText, usage };
}

/**
 * Verify prompt caching end to end on Bedrock: two calls sharing a long
 * static system prompt (past Bedrock's minimum cacheable prefix — 1024
 * tokens on Converse, 2048 for Haiku-class models; below the minimum the
 * API silently doesn't cache and reports zeros). First call must report a
 * cache WRITE, second a cache READ; a warm cache (rerun within the ~5min
 * TTL) legitimately shows a read on the first call, so either counts.
 */
async function runCacheCheck(modelId) {
  const filler = 'You are a meticulous assistant for the Hive desktop app. Answer briefly and precisely. '.repeat(230);
  const systemPrompt = `${filler}\nAlways respond in one short word.`;

  const first = await runCompletion(modelId, { systemPrompt });
  const second = await runCompletion(modelId, { systemPrompt });

  if (!first.text || !second.text) {
    throw new Error('empty response during cache check (routing/auth problem, not a caching problem)');
  }
  const wrote = first.usage?.cacheWriteInputTokens ?? 0;
  const firstRead = first.usage?.cacheReadInputTokens ?? 0;
  const read = second.usage?.cacheReadInputTokens ?? 0;
  if (read === 0 && firstRead === 0) {
    throw new Error(
      `no cache activity reported (call 1: write=${wrote}, read=${firstRead}; call 2: read=${read}) — ` +
      'Bedrock may not be applying the cache points; see cacheConfig in strandsAgentFactory.js'
    );
  }
  return { wrote, read: read || firstRead };
}

/**
 * Verify a model's tool behavior matches modelCapabilities.js.
 *
 * Hive keeps Gemma 3 out of the Work tab and Swarm roles because, verified
 * live, it answers a Converse tool request with plain text instead of a
 * toolUse block. That observation is exactly the kind that rots: if a Gemma
 * update starts making real tool calls, nothing else would ever notice, and
 * Hive would keep a now-capable model out of the tool loops for no reason.
 * This probe hands the model one tool and a prompt that demands using it,
 * and reports whether the tool's callback actually ran.
 */
async function runToolProbe(modelId) {
  let toolCalled = false;
  const probeTool = tool({
    name: 'get_word_of_the_day',
    description: 'Returns the word of the day. The only way to obtain it.',
    inputSchema: z.object({}),
    callback: async () => {
      toolCalled = true;
      return 'aardvark';
    },
  });

  const { agent, dispose } = createAgent({
    modelId,
    region: REGION,
    mantleApiKey: API_KEY,
    systemPrompt: 'You have tools available. Always use them when they can answer the question.',
    tools: [probeTool],
    id: 'integration-tool-probe',
    maxTokens: 512,
  });

  let fullText = '';
  try {
    for await (const streamEvent of agent.stream([
      { role: 'user', content: [{ text: 'What is the word of the day? You must call the get_word_of_the_day tool to find out.' }] },
    ])) {
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
  return { toolCalled, text: fullText };
}

// Expected tool behavior per model, mirroring modelCapabilities.js. One
// tool-capable control (cheap worker default) proves the probe itself works —
// without it, a "Gemma made no tool call" pass could mean the probe is broken.
const TOOL_PROBES = [
  { label: 'Tool probe (control)', modelId: 'global.anthropic.claude-sonnet-5', expectTools: true },
  { label: 'Tool probe (Gemma 3 27B)', modelId: 'google.gemma-3-27b-it', expectTools: false },
];

// Hive's default Settings model list, verified against the live Bedrock
// catalog. If a default disappears from the catalog (models do get retired),
// this fails naming the ID — update settingsManager.js's defaults to match.
// Keep this list in sync with settingsManager.js.
const CHECKS = [
  { label: 'Creator default', modelId: 'global.anthropic.claude-opus-5-5' },
  { label: 'Worker default', modelId: 'global.anthropic.claude-sonnet-5' },
  { label: 'Formatter default', modelId: 'us.openai.gpt-6-sol', maxTokens: 1000 },
  { label: 'Fable 5.1', modelId: 'global.anthropic.claude-fable-5-1' },
  { label: 'GPT-6 Astra', modelId: 'us.openai.gpt-6-astra', maxTokens: 1000 },
  // Grok needed a much larger reasoning budget than other models on Mantle
  // (500+ before visible output); keep the generous budget on Bedrock too.
  { label: 'Grok 4.6', modelId: 'us.xai.grok-4.6', maxTokens: 1000 },
  { label: 'Gemma 3 27B', modelId: 'google.gemma-3-27b-it' },
  // Kimi K3 also streams reasoning tokens before any visible text (verified
  // on Converse at adoption), so it gets the same generous budget as Grok.
  { label: 'Kimi K3', modelId: 'global.moonshotai.kimi-k3', maxTokens: 1000 },
  { label: 'GPT-6 Luna', modelId: 'global.openai.gpt-6-luna', maxTokens: 1000 },
  { label: 'Nova 2 Lite', modelId: 'global.amazon.nova-2-lite-v1:0' },
];

async function main() {
  console.log('\n=== Live Bedrock integration check ===\n');
  let failures = 0;

  for (const { label, modelId, maxTokens } of CHECKS) {
    process.stdout.write(`${label} [${modelId}] ... `);
    try {
      const { text } = await runCompletion(modelId, maxTokens ? { maxTokens } : {});
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
  process.stdout.write('Prompt caching (Converse cache points) [global.anthropic.claude-sonnet-5] ... ');
  try {
    const { wrote, read } = await runCacheCheck('global.anthropic.claude-sonnet-5');
    console.log(`OK (write=${wrote} tokens, read=${read} tokens)`);
  } catch (err) {
    console.log(`FAIL (${err.message})`);
    failures++;
  }

  console.log('');
  for (const { label, modelId, expectTools } of TOOL_PROBES) {
    process.stdout.write(`${label} [${modelId}] ... `);
    try {
      const { toolCalled } = await runToolProbe(modelId);
      if (toolCalled === expectTools) {
        console.log(`OK (${toolCalled ? 'made a real tool call' : 'no tool call, as expected'})`);
      } else if (expectTools) {
        console.log('FAIL (control model made no tool call — the probe itself may be broken, so the Gemma result below/above proves nothing)');
        failures++;
      } else {
        console.log('FAIL (made a REAL tool call — remove it from TOOLLESS_MODEL_PATTERNS in modelCapabilities.js and let it into the Work tab and Swarm roles)');
        failures++;
      }
    } catch (err) {
      console.log(`FAIL (${err.message})`);
      failures++;
    }
  }

  console.log('');
  const totalChecks = CHECKS.length + 1 + TOOL_PROBES.length;
  if (failures > 0) {
    console.error(`${failures}/${totalChecks} checks failed — Bedrock catalog, auth, or caching may have changed. See strandsAgentFactory.js.`);
    process.exit(1);
  }
  console.log(`All ${totalChecks} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[bedrock-live] Unexpected error:', err);
  process.exit(1);
});
