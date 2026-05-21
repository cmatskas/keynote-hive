const {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  StartMemoryExtractionJobCommand,
} = require('@aws-sdk/client-bedrock-agentcore');

const {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  GetMemoryCommand,
  ListMemoriesCommand,
  DeleteMemoryCommand,
  UpdateMemoryCommand,
} = require('@aws-sdk/client-bedrock-agentcore-control');

const { BedrockAgentCoreClient } = require('@aws-sdk/client-bedrock-agentcore');
const log = require('electron-log/main');

const MEMORY_NAME = 'hive_memory';
const ACTOR_ID = 'user';
const DEFAULT_STRATEGIES = [
  { semanticMemoryStrategy: { name: 'Facts', namespaces: ['/user/facts/'] } },
  { userPreferenceMemoryStrategy: { name: 'Preferences', namespaces: ['/user/preferences/'] } },
];
const EVENT_EXPIRY_DAYS = 90;

class MemoryManager {
  constructor(clientConfig) {
    this.dataClient = new BedrockAgentCoreClient(clientConfig);
    this.controlClient = new BedrockAgentCoreControlClient(clientConfig);
    this.memoryId = null;
    this.actorId = ACTOR_ID; // default, overridden via setActorId()
  }

  /** Set memoryId from stored config */
  setMemoryId(id) { this.memoryId = id; }
  setActorId(id) { this.actorId = id; }

  // ── Control Plane ──────────────────────────────────────────────

  /** Create the Hive memory resource. Returns { id, status }. */
  async createMemory() {
    // Check if one already exists
    const existing = await this.findExistingMemory();
    if (existing) {
      this.memoryId = existing.id;
      await this._ensureStrategies();
      return { id: existing.id, status: existing.status, alreadyExisted: true };
    }

    try {
      const res = await this.controlClient.send(new CreateMemoryCommand({
        name: MEMORY_NAME,
        description: 'Hive agent memory — stores conversation context and user preferences',
        strategies: DEFAULT_STRATEGIES,
        eventExpiryDuration: EVENT_EXPIRY_DAYS,
      }));
      this.memoryId = res.memory.id;
      // Verify strategies were applied; add them if not
      await this._ensureStrategies();
      return { id: res.memory.id, status: res.memory.status, alreadyExisted: false };
    } catch (err) {
      if (err.name === 'ValidationException' && err.message?.includes('already exists')) {
        const found = await this.findExistingMemory();
        if (found) {
          this.memoryId = found.id;
          await this._ensureStrategies();
          return { id: found.id, status: found.status, alreadyExisted: true };
        }
      }
      throw err;
    }
  }

  /** Ensure the memory has strategies configured; add them via UpdateMemory if missing. */
  async _ensureStrategies() {
    if (!this.memoryId) return;
    try {
      const res = await this.controlClient.send(new GetMemoryCommand({ memoryId: this.memoryId }));
      if (!res.memory.strategies || res.memory.strategies.length === 0) {
        log.info('[memory] Adding default strategies');
        await this.controlClient.send(new UpdateMemoryCommand({
          memoryId: this.memoryId,
          memoryStrategies: {
            addMemoryStrategies: DEFAULT_STRATEGIES,
          },
        }));
      }
    } catch (err) {
      log.warn('[memory] Failed to ensure strategies:', err.message);
    }
  }

  /** Poll until memory is ACTIVE. Returns final status. */
  async waitForActive(maxWaitMs = 300000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const status = await this.getStatus();
      if (status === 'ACTIVE') return 'ACTIVE';
      if (status === 'FAILED') throw new Error('Memory creation failed');
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Timed out waiting for memory to become ACTIVE');
  }

  /** Get current memory status */
  async getStatus() {
    if (!this.memoryId) return null;
    const res = await this.controlClient.send(new GetMemoryCommand({ memoryId: this.memoryId }));
    return res.memory.status;
  }

  /** Find existing Hive memory by name */
  async findExistingMemory() {
    const res = await this.controlClient.send(new ListMemoriesCommand({ maxResults: 100 }));
    return (res.memories || []).find(m => m.name === MEMORY_NAME) || null;
  }

  /** Delete the memory resource */
  async deleteMemory() {
    if (!this.memoryId) return;
    await this.controlClient.send(new DeleteMemoryCommand({ memoryId: this.memoryId }));
    this.memoryId = null;
  }

  // ── Data Plane: Events (STM) ───────────────────────────────────

  /** Save conversation messages as an event */
  async saveEvent(sessionId, messages) {
    if (!this.memoryId) return;
    const payload = messages.map(m => ({
      conversational: {
        content: { text: m.content },
        role: m.role === 'user' ? 'USER' : 'ASSISTANT',
      },
    }));

    await this.dataClient.send(new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: this.actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload,
    }));
  }

  /** Load recent events for a session (STM recall) */
  async loadRecentEvents(sessionId, maxResults = 20) {
    if (!this.memoryId) return [];
    try {
      const res = await this.dataClient.send(new ListEventsCommand({
        memoryId: this.memoryId,
        actorId: this.actorId,
        sessionId,
        maxResults,
        includePayloads: true,
      }));
      return (res.events || []).flatMap(evt =>
        (evt.payload || [])
          .filter(p => p.conversational)
          .map(p => ({
            role: p.conversational.role === 'USER' ? 'user' : 'assistant',
            content: p.conversational.content?.text || '',
          }))
      );
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') return [];
      throw err;
    }
  }

  // ── Data Plane: Memory Records (LTM) ──────────────────────────

  /** Retrieve relevant long-term memories for a query */
  async retrieveMemories(query, topK = 5) {
    if (!this.memoryId) return [];
    try {
      const res = await this.dataClient.send(new RetrieveMemoryRecordsCommand({
        memoryId: this.memoryId,
        namespace: '/user/',
        searchCriteria: { searchQuery: query, topK },
      }));
      return (res.memoryRecordSummaries || []).map(r => ({
        content: r.content?.text || JSON.stringify(r.content),
        score: r.score,
        namespace: (r.namespaces || [])[0],
      }));
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') return [];
      throw err;
    }
  }

  /** Trigger LTM extraction for a session */
  async startExtraction(sessionId) {
    if (!this.memoryId) return;
    try {
      await this.dataClient.send(new StartMemoryExtractionJobCommand({
        memoryId: this.memoryId,
        actorId: this.actorId,
        sessionId,
      }));
    } catch (err) {
      // Non-critical — log but don't throw
      log.warn('[memory] Extraction failed:', err.message);
    }
  }

  // ── Context Builder ────────────────────────────────────────────

  /** Build memory context string to inject into system prompt */
  async buildContext(sessionId, currentPrompt) {
    if (!this.memoryId) return '';

    const parts = [];

    // LTM: retrieve relevant memories based on current prompt
    const memories = await this.retrieveMemories(currentPrompt);
    if (memories.length > 0) {
      const memText = memories.map(m => `- ${m.content}`).join('\n');
      parts.push(`<long_term_memory>\nRelevant facts and preferences about this user:\n${memText}\n</long_term_memory>`);
    }

    // STM: load recent conversation from this session
    const recent = await this.loadRecentEvents(sessionId, 10);
    if (recent.length > 0) {
      const stmText = recent.map(m => `${m.role}: ${m.content}`).join('\n');
      parts.push(`<short_term_memory>\nRecent conversation in this session:\n${stmText}\n</short_term_memory>`);
    }

    return parts.join('\n\n');
  }
}

module.exports = MemoryManager;
