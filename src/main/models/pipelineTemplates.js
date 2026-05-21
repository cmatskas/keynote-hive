/**
 * Pipeline templates — built-in agent pipeline configurations.
 * Each template defines a sequence of agents with model, skills, tools, and system prompts.
 */

// Default model mapping — capability roles to inference profile IDs.
// Overridden at runtime via resolveModels() using app settings.
//
// ROLES:
//   creator   — The most capable model. Handles writing, quality evaluation, and
//               any task where output quality is the top priority. Assign your best
//               (and typically most expensive) model here. Used by: Writer, Quality Gates.
//
//   worker    — Reliable mid-tier model for bulk tasks that need competence but not
//               peak creativity. Research, planning, editing, and analysis. A good
//               balance of cost and capability. Used by: Researcher, Planner, Editor.
//
//   formatter — Mechanical output formatting (DOCX, PPTX generation). The task is
//               mostly code execution with minimal reasoning, so the cheapest capable
//               model is fine. Used by: Formatter agents.
//
//   vision    — Multimodal model for video/image analysis. Must support video content
//               blocks in the Converse API. Used by: Demo Analyst when video is attached.
//
const DEFAULT_MODELS = {
  creator: 'us.anthropic.claude-opus-4-6-v1',
  worker: 'us.anthropic.claude-sonnet-4-6',
  formatter: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  vision: 'us.amazon.nova-premier-v1:0',
};

let MODELS = { ...DEFAULT_MODELS };

/** Override model mapping from user settings. Call at pipeline start. */
function resolveModels(overrides = {}) {
  MODELS = { ...DEFAULT_MODELS, ...overrides };
}

// ── Rubric definitions (binary criteria with penalties) ──────────────────────
// Adapted from Scale AI Agentic Rubrics + Autorubric framework.
// Positive weights reward, negative weights penalize when triggered.

const RUBRICS = {
  article: {
    threshold: 0.75, minPass: 0.60,
    criteria: [
      // scope_alignment
      { text: 'Covers all key points from the brief', weight: 3 },
      { text: 'Within ±20% of target word count', weight: 1, canBeNA: true },
      { text: 'No off-topic tangents or scope creep', weight: 1 },
      // brief_fidelity
      { text: 'Matches specified audience level and tone', weight: 3 },
      { text: 'Includes specific data/statistics from research', weight: 2 },
      { text: 'All claims supported by cited sources', weight: 2 },
      // authenticity (penalties)
      { text: 'Contains Tier 1 AI vocabulary (delve, tapestry, landscape, unleash, etc.)', weight: -3 },
      { text: 'Contains hedge-stacking or weasel phrases', weight: -2 },
      { text: 'Uses specific examples, not generic platitudes', weight: 2 },
      // craft_quality
      { text: 'Strong opening hook that earns the next paragraph', weight: 2 },
      { text: 'Logical section flow with clear transitions', weight: 2 },
      { text: 'Conclusion adds value (not just summary)', weight: 1 },
      // penalties
      { text: 'Contains filler paragraphs that could be deleted without losing meaning', weight: -2 },
      { text: 'Contains competitor product names or unverifiable customer references', weight: -3 },
    ],
  },
  keynote: {
    threshold: 0.75, minPass: 0.60,
    criteria: [
      { text: 'Covers the core message from the brief', weight: 3 },
      { text: 'Appropriate slide count for time slot', weight: 2, canBeNA: true },
      { text: 'Each slide has one clear takeaway', weight: 2 },
      { text: 'Audience-appropriate complexity level', weight: 3 },
      { text: 'Key data points from research included', weight: 2 },
      { text: 'Call to action aligned with brief\'s goal', weight: 2 },
      { text: 'Contains Tier 1 AI vocabulary', weight: -3 },
      { text: 'Slide text is scannable (not paragraphs)', weight: 2 },
      { text: 'Preserves intentional rhetorical devices', weight: 1 },
      { text: 'Clear narrative arc across slides', weight: 3 },
      { text: 'Speaker notes are conversational, not read-aloud prose', weight: 2 },
      { text: 'Transitions between slides feel natural', weight: 1 },
      { text: 'Contains slides that are just walls of text', weight: -2 },
      { text: 'Speaker notes read like an essay, not spoken delivery', weight: -1 },
      { text: 'Contains competitor product names or unverifiable customer references', weight: -3 },
    ],
  },
  speech: {
    threshold: 0.75, minPass: 0.60,
    criteria: [
      { text: 'Addresses the core topic from the brief', weight: 3 },
      { text: 'Fits target duration (timing marks add up)', weight: 2, canBeNA: true },
      { text: 'Opening and closing are connected (callback)', weight: 2 },
      { text: 'Audience-appropriate language and references', weight: 3 },
      { text: 'Emotional register matches brief\'s intent', weight: 3 },
      { text: 'Key message is unmistakable', weight: 2 },
      { text: 'Contains Tier 1 AI vocabulary', weight: -2 },
      { text: 'Sounds natural when read aloud', weight: 3 },
      { text: 'Preserves rhetorical craft (anaphora, tricolon, etc.)', weight: 1 },
      { text: 'Emotional arc builds and resolves', weight: 3 },
      { text: 'Varied sentence rhythm (short punchy + longer flowing)', weight: 2 },
      { text: 'Stage directions are practical and specific', weight: 1 },
      { text: 'Contains passages that sound written, not spoken', weight: -2 },
      { text: 'Contains generic motivational filler (believe in yourself, etc.)', weight: -1 },
      { text: 'Contains competitor product names or unverifiable customer references', weight: -3 },
    ],
  },
  demo: {
    threshold: 0.75, minPass: 0.60,
    criteria: [
      { text: 'Opens with a clear problem statement the viewer relates to', weight: 3 },
      { text: 'Every feature shown has a "so what" moment', weight: 3 },
      { text: 'Scene durations add up to target length', weight: 2, canBeNA: true },
      { text: 'Callouts and annotations are specific (not just "highlight this")', weight: 2 },
      { text: 'Narration is conversational, not scripted-sounding', weight: 2 },
      { text: 'Logical flow from problem to solution to proof', weight: 3 },
      { text: 'Uses real or realistic data in examples', weight: 2 },
      { text: 'Ends with clear call to action', weight: 2 },
      { text: 'Contains Tier 1 AI vocabulary', weight: -3 },
      { text: 'Contains competitor product names or unverifiable customer references', weight: -3 },
      { text: 'Contains scenes longer than 30 seconds without a visual change', weight: -2 },
      { text: 'Contains generic filler narration (as you can see, basically, simply)', weight: -1 },
    ],
  },
};

const TEMPLATES = {
  article: {
    id: 'article',
    name: 'Article / Blog Post',
    description: 'Research, outline, write, edit, and format a professional article',
    icon: 'bi-newspaper',
    rubric: RUBRICS.article,
    agents: [
      { id: 'researcher', label: 'Researcher', model: "worker", skills: ['research-first', 'customer-research'], tools: ['web'],
        prompt: 'You are a research specialist. Given the user\'s topic, conduct thorough research using the web tool. Find authoritative sources, key statistics, expert opinions, and recent developments. Output a structured research brief with sections: Key Findings, Supporting Data, Source URLs, and Suggested Angles.' },
      { id: 'planner', label: 'Outliner', model: "worker", skills: ['task-planner', 'analysis-framework'], tools: [], reviewPoint: true,
        prompt: 'You are a content strategist. Using the research brief, create a detailed article outline: 3 title options, hook/intro strategy, section structure with key points, conclusion approach, and target word count per section.' },
      { id: 'quality-gate-1', label: 'Quality Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate the outline. Check: (1) addresses the brief completely, (2) logical structure, (3) no gaps in argument flow, (4) appropriate depth. If ALL pass: respond with "PASS" then the outline unchanged. If ANY fail: respond with "REVISE:" then specific feedback.' },
      { id: 'writer', label: 'Writer', model: "creator", skills: ['copywriting', 'marketing-psychology', 'doc-coauthoring'], tools: ['execute_code'],
        prompt: 'You are an expert writer. Follow the outline precisely. Write the full article matching the specified tone and audience. Use research to support claims with specific data. Maintain natural, engaging flow. Do not use AI-typical phrases or filler. Use execute_code if you need to process data or generate charts.' },
      { id: 'editor', label: 'Editor', model: "worker", skills: ['copy-editing', 'analysis-framework', 'marketing-psychology'], tools: [],
        prompt: 'You are a professional editor. Apply the Eight Sweeps framework from your copy-editing skill, starting with Sweep 0 (de-slop). Review for: clarity, grammar, tone consistency, logical structure, redundancy, and factual accuracy against the research. Make direct improvements. Output the complete improved version.' },
      { id: 'quality-gate-2', label: 'Final Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate the edited article using the de-slop checklist from your copy-editing skill. Check: (1) addresses the brief, (2) free of all 22 AI slop patterns, (3) specific not generic, (4) right length/depth. If ALL pass: respond with "PASS" then the article unchanged. If ANY fail: respond with "REVISE:" then specific feedback referencing which patterns were found.' },
      { id: 'formatter', label: 'Formatter', model: "formatter", skills: ['docx'], tools: ['execute_code', 'save_file_locally'],
        prompt: `You are a document formatter. Your ONLY job is to convert the final article into a .docx file and save it locally.

You MUST follow these steps exactly:

STEP 1: Call execute_code with a SINGLE Python script that:
- Starts with: subprocess.check_call(['pip', 'install', '-q', 'python-docx', 'lxml'])
- Creates the document using python-docx
- Includes a header with the document title (right-aligned, 9pt, grey)
- Includes a footer with "Amazon Confidential" on the left and page number on the right
- Adds line numbers to all sections
- Formats the content with proper heading hierarchy (Heading 1, Heading 2, etc.)
- Uses styled paragraphs, bullet lists (style='List Bullet'), and tables where appropriate
- Saves to /tmp/output.docx
- Prints "SAVED: /tmp/output.docx" at the end

STEP 2: Call save_file_locally with:
- sandbox_path: /tmp/output.docx
- local_path: ~/Documents/Hive/<descriptive_filename>.docx

CRITICAL: Do NOT describe what you would do. Do NOT skip the execute_code call. Do NOT hallucinate file paths. Execute the code, then save the file. These are the only two actions you take.` },
    ],
    edges: [['researcher','planner'],['planner','quality-gate-1'],['quality-gate-1','writer'],['writer','editor'],['editor','quality-gate-2'],['quality-gate-2','formatter']],
  },

  keynote: {
    id: 'keynote',
    name: 'Keynote / Presentation',
    description: 'Research, outline, write speaker notes, and create a slide deck',
    icon: 'bi-easel',
    rubric: RUBRICS.keynote,
    agents: [
      { id: 'researcher', label: 'Researcher', model: "worker", skills: ['research-first'], tools: ['web'],
        prompt: 'You are a presentation research specialist. Use the web tool to find compelling data points, statistics, quotes, case studies, and visual concepts for slides. Output: key statistics, memorable quotes, story angles, and visual metaphors.' },
      { id: 'planner', label: 'Slide Planner', model: "worker", skills: ['task-planner', 'analysis-framework'], tools: [], reviewPoint: true,
        prompt: 'Create a slide-by-slide plan: title slide, content slides with key message + supporting points, transitions, and closing. Include speaker note guidelines and visual suggestions per slide.' },
      { id: 'quality-gate-1', label: 'Quality Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate the slide plan. Check: (1) clear narrative arc, (2) slides are scannable not text-heavy, (3) logical flow, (4) appropriate slide count. If ALL pass: "PASS" then plan unchanged. If ANY fail: "REVISE:" then feedback.' },
      { id: 'writer', label: 'Content Writer', model: "creator", skills: ['copywriting', 'marketing-psychology', 'doc-coauthoring'], tools: ['execute_code'],
        prompt: 'For each slide write: the title, 3-5 concise bullet points (short impactful phrases, not sentences), and detailed speaker notes (conversational, with timing cues and transitions). Keep slide text minimal.' },
      { id: 'editor', label: 'Editor', model: "worker", skills: ['copy-editing', 'analysis-framework', 'marketing-psychology'], tools: [],
        prompt: 'Apply the Eight Sweeps framework starting with Sweep 0 (de-slop). Calibrate to creative/inspirational register — preserve vivid imagery and rhetorical devices, strip only dead giveaway AI patterns. Review for: message clarity, consistent tone, logical flow, appropriate detail level, and compelling speaker notes. Output the complete improved version.' },
      { id: 'quality-gate-2', label: 'Final Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate using the de-slop checklist at creative/inspirational register. Check: (1) addresses brief, (2) no Tier 1 AI vocabulary, (3) slides scannable, (4) speaker notes conversational. Preserve intentional rhetorical devices. If ALL pass: "PASS" then content unchanged. If ANY fail: "REVISE:" then feedback referencing specific patterns.' },
      { id: 'formatter', label: 'Slide Creator', model: "formatter", skills: ['pptx'], tools: ['execute_code', 'save_file_locally'],
        prompt: `You are a presentation formatter. Your ONLY job is to convert the final slides into a .pptx file and save it locally.

You MUST follow these steps exactly:

STEP 1: Call execute_code with a SINGLE Python script that:
- Starts with: subprocess.check_call(['pip', 'install', '-q', 'python-pptx'])
- Creates a 16:9 widescreen presentation using python-pptx
- Uses blank slide layouts and positions shapes manually for a clean modern look
- Dark background (RGB 20, 24, 34), white text, accent colors for emphasis
- Each slide has: title, content area, speaker notes (from the notes in the input)

- Saves to /tmp/output.pptx
- Prints "SAVED: /tmp/output.pptx" at the end

STEP 2: Call save_file_locally with:
- sandbox_path: /tmp/output.pptx
- local_path: ~/Documents/Hive/<descriptive_filename>.pptx

CRITICAL: Do NOT describe what you would do. Do NOT skip the execute_code call. Do NOT hallucinate file paths. Execute the code, then save the file. These are the only two actions you take.` },
    ],
    edges: [['researcher','planner'],['planner','quality-gate-1'],['quality-gate-1','writer'],['writer','editor'],['editor','quality-gate-2'],['quality-gate-2','formatter']],
  },

  speech: {
    id: 'speech',
    name: 'Speech / Talk',
    description: 'Research, outline, write, and polish a speech with timing notes',
    icon: 'bi-mic',
    rubric: RUBRICS.speech,
    agents: [
      { id: 'researcher', label: 'Researcher', model: "worker", skills: ['research-first'], tools: ['web'],
        prompt: 'Use the web tool to find compelling stories, anecdotes, data points, and quotes suitable for spoken delivery. Focus on emotional resonance and memorability. Output: key stories, supporting data, memorable quotes, audience engagement hooks.' },
      { id: 'planner', label: 'Speech Architect', model: "worker", skills: ['task-planner', 'analysis-framework'], tools: [], reviewPoint: true,
        prompt: 'Design the speech structure: opening hook, 3-4 main points with evidence, transitions, callbacks to opening, memorable closing. Include timing estimates per section. Specify where to use pauses, humor, or audience interaction.' },
      { id: 'quality-gate-1', label: 'Quality Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate the speech outline. Check: (1) strong opening hook, (2) clear argument flow, (3) timing adds up to target duration, (4) memorable closing. If ALL pass: "PASS" then outline unchanged. If ANY fail: "REVISE:" then feedback.' },
      { id: 'writer', label: 'Speechwriter', model: "creator", skills: ['copywriting', 'doc-coauthoring', 'marketing-psychology'], tools: [],
        prompt: 'Write the full speech as spoken aloud. Conversational language, short sentences, rhetorical devices, natural rhythm. Include [PAUSE], [LOOK AT AUDIENCE], [GESTURE] stage directions. Include [~2 min] timing marks at section boundaries. Write for the ear, not the eye.' },
      { id: 'editor', label: 'Editor', model: "worker", skills: ['copy-editing', 'analysis-framework', 'marketing-psychology'], tools: [],
        prompt: 'Apply the Eight Sweeps at inspirational register — preserve rhetorical devices, vivid imagery, and emotional language. Strip only dead giveaway AI patterns. Edit for: speakability (no tongue-twisters), pacing (vary sentence length), clarity, emotional arc, and timing fit. Output the complete polished speech.' },
      { id: 'quality-gate-2', label: 'Final Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing'],
        prompt: 'Evaluate using the de-slop checklist at inspirational register. Check: (1) sounds natural spoken aloud, (2) no Tier 1 AI vocabulary, (3) emotional arc works, (4) fits target duration. Preserve intentional rhetorical craft. If ALL pass: "PASS" then speech unchanged. If ANY fail: "REVISE:" then feedback.' },
    ],
    edges: [['researcher','planner'],['planner','quality-gate-1'],['quality-gate-1','writer'],['writer','editor'],['editor','quality-gate-2']],
  },

  demo: {
    id: 'demo',
    name: 'Demo / Storyboard',
    description: 'Analyze a product or feature and create a scene-by-scene demo storyboard',
    icon: 'bi-camera-reels',
    rubric: RUBRICS.demo,
    agents: [
      { id: 'analyst', label: 'Analyst', model: "vision", skills: ['analysis-framework', 'research-first'], tools: ['web', 'execute_code'], supportsVideo: true,
        prompt: 'You are a product analyst with video analysis capabilities. If a video is provided, analyze it scene by scene: describe what is shown on screen, identify UI elements, click paths, transitions, key moments, and any text/data visible. Include timestamps. If no video, read the provided inputs (product brief, feature specs, screenshots, transcripts). Extract: key features to demo, user pain points addressed, "wow moments" worth highlighting, target audience, and any technical details needed for screen recordings. Use web to research the product/feature for additional context. Output a structured analysis brief.' },
      { id: 'planner', label: 'Story Architect', model: "worker", skills: ['task-planner', 'demo-storyboard', 'marketing-psychology'], tools: [], reviewPoint: true,
        prompt: 'You are a demo narrative designer. Using the analysis brief, create the scene-by-scene storyboard structure following the Demo Narrative Arc from your demo-storyboard skill (Hook → Context → Solution Reveal → Proof → CTA). For each scene, define: title, duration, what\'s on screen, and the key message. Include transition notes between scenes. Output the complete scene breakdown with timing.' },
      { id: 'quality-gate-1', label: 'Quality Check', model: "creator", tools: [], isQualityGate: true, maxRetries: 2, skills: ['copy-editing', 'demo-storyboard'],
        prompt: 'Evaluate the storyboard structure. Check: (1) opens with problem not feature, (2) every scene has one clear focus, (3) scenes are under 30 seconds, (4) logical flow from problem to proof, (5) ends with specific CTA. If ALL pass: "PASS" then storyboard unchanged. If ANY fail: "REVISE:" then feedback.' },
      { id: 'writer', label: 'Scene Writer', model: "creator", skills: ['demo-storyboard', 'copywriting', 'marketing-psychology'], tools: [],
        prompt: 'You are a demo script writer. For each scene in the storyboard, write the complete scene card using the exact format from your demo-storyboard skill. Include: specific visual descriptions, exact callout annotations (arrows, zoom levels, blur regions), word-for-word narration in conversational tone, on-screen text overlays, transitions, and emotional beats. Mark pauses with [PAUSE Xs]. Insert [CUSTOMER REFERENCE NEEDED: description] where proof points are missing. IMPORTANT: If extracted video frames are listed in the analysis, reference the specific frame paths (e.g. /tmp/frames/frame_0005_0010.jpg) in each scene\'s Visual field. Choose the frame that best represents what should be on screen for that scene.' },
      { id: 'editor', label: 'Editor', model: "worker", skills: ['copy-editing', 'demo-storyboard', 'analysis-framework'], tools: [],
        prompt: 'Apply the Eight Sweeps framework plus Sweep 9 (AWS Reference Audit). For demo storyboards specifically: verify all callouts are specific (not vague), narration sounds natural when spoken aloud, scene durations are realistic, click paths are explicit, and data shown is realistic. Check that no scene exceeds 30 seconds. Verify that frame references (if present) point to actual /tmp/frames/ paths from the analysis. Strip AI vocabulary. Output the complete polished storyboard.' },
      { id: 'formatter', label: 'Deck Creator', model: "formatter", skills: ['pptx'], tools: ['execute_code', 'save_file_locally'],
        prompt: `You are a storyboard deck formatter. Your ONLY job is to convert the final scene cards into a .pptx file and save it locally.

You MUST follow these steps exactly:

STEP 1: Call execute_code with a SINGLE Python script that:
- Starts with: subprocess.check_call(['pip', 'install', '-q', 'python-pptx'])
- Creates a 16:9 widescreen presentation using python-pptx
- Uses blank slide layouts and positions shapes manually
- Dark background (RGB 20, 24, 34), white text, orange accents
- One slide per scene card: scene number + title as heading, visual description, narration text, callout notes, duration + transition in footer area
- If frame image paths are referenced (e.g. /tmp/frames/frame_0005_0010.jpg), check if the file exists with os.path.exists() before embedding with add_picture(). Skip missing images gracefully.

- Saves to /tmp/output.pptx
- Prints "SAVED: /tmp/output.pptx" at the end

STEP 2: Call save_file_locally with:
- sandbox_path: /tmp/output.pptx
- local_path: ~/Documents/Hive/<descriptive_filename>.pptx

CRITICAL: Do NOT describe what you would do. Do NOT skip the execute_code call. Do NOT hallucinate file paths. Execute the code, then save the file. These are the only two actions you take.` },
    ],
    edges: [['analyst','planner'],['planner','quality-gate-1'],['quality-gate-1','writer'],['writer','editor'],['editor','formatter']],
  },
};

function _resolveAgentModels(template) {
  if (!template) return null;
  return {
    ...template,
    agents: template.agents.map(a => ({
      ...a,
      model: MODELS[a.model] || a.model, // resolve role name → ID, pass through if already an ID
    })),
  };
}

function getTemplate(id) { return _resolveAgentModels(TEMPLATES[id]); }

function getAllTemplates() {
  return Object.values(TEMPLATES).map(({ id, name, description, icon, agents }) => ({
    id, name, description, icon, agentCount: agents.length,
  }));
}

module.exports = { getTemplate, getAllTemplates, MODELS, RUBRICS, resolveModels, DEFAULT_MODELS };
