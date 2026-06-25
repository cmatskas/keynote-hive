/**
 * Strands tool factory — creates Zod-based Strands tools that wrap
 * Hive's existing tool implementations (code interpreter, web, file I/O).
 */
const { tool } = require('@strands-agents/sdk');
const { z } = require('zod');
const path = require('path');
const os = require('os');
const fsPromises = require('fs').promises;
const log = require('electron-log/main');

function createSwarmTools({ codeInterpreterManager, webSearchManager, settings, onStatus }, toolNames) {
  const home = os.homedir();

  /** Resolve path: expand ~, resolve to absolute, block outside home */
  function resolveLocalPath(p) {
    let resolved = p.startsWith('~') ? p.replace('~', home) : p;
    // Fix double-path bug on Windows: agent may concatenate working dir with absolute path
    const driveMatch = resolved.match(/^[A-Za-z]:\\.*?([A-Za-z]:\\.*)/);
    if (driveMatch) resolved = driveMatch[1];
    resolved = path.resolve(resolved);
    if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) {
      throw new Error(`Blocked: path must be within user home directory (${home})`);
    }
    return resolved;
  }

  /** Upload a local buffer to the sandbox via base64+executeCode (proven pattern from Work tab) */
  async function uploadToSandbox(sandboxPath, buffer) {
    if (!codeInterpreterManager.sessionId) await codeInterpreterManager.startSession(7200);
    const b64 = buffer.toString('base64');
    // Split into chunks to avoid command-line length limits for large files
    const chunkSize = 500000;
    if (b64.length <= chunkSize) {
      const code = `import base64\ndata = base64.b64decode("${b64}")\nwith open("${sandboxPath}", "wb") as f:\n    f.write(data)\nprint(f"Wrote {len(data)} bytes to ${sandboxPath}")`;
      return codeInterpreterManager.executeCode(code);
    }
    // Large file: write chunks
    const chunks = [];
    for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
    const code = `import base64
chunks = ${JSON.stringify(chunks)}
data = base64.b64decode("".join(chunks))
with open("${sandboxPath}", "wb") as f:
    f.write(data)
print(f"Wrote {len(data)} bytes to ${sandboxPath}")`;
    return codeInterpreterManager.executeCode(code);
  }

  const registry = {
    execute_code: () => tool({
      name: 'execute_code',
      description: 'Execute Python code in a secure sandbox. Use for computations, file generation, data processing.',
      inputSchema: z.object({ code: z.string().describe('Python code to execute') }),
      callback: async (input) => {
        try {
          if (!codeInterpreterManager.sessionId) {
            onStatus?.('Starting sandbox...');
            await codeInterpreterManager.startSession(7200);
          }
          const result = await codeInterpreterManager.executeCode(input.code);
          if (!result.success) return JSON.stringify({ error: result.errors.join('\n'), output: result.text });
          return result.text || 'Code executed successfully (no output).';
        } catch (err) {
          onStatus?.(`Code execution error: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      },
    }),

    save_file_locally: () => tool({
      name: 'save_file_locally',
      description: 'Save a file from the sandbox to the user\'s local filesystem.',
      inputSchema: z.object({
        sandbox_path: z.string().describe('Path in sandbox (e.g. /tmp/output.docx)'),
        local_path: z.string().describe('Absolute path on user filesystem'),
      }),
      callback: async (input) => {
        try {
          if (!codeInterpreterManager.sessionId) throw new Error('No sandbox session — run execute_code first');
          const localPath = resolveLocalPath(input.local_path);
          const base64 = await codeInterpreterManager.readFileBase64(input.sandbox_path);
          const buffer = Buffer.from(base64, 'base64');
          await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
          await fsPromises.writeFile(localPath, buffer);
          return JSON.stringify({ success: true, path: localPath, size: buffer.length });
        } catch (err) {
          onStatus?.(`Save error: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      },
    }),

    read_local_file: () => tool({
      name: 'read_local_file',
      description: 'Read a file from the user\'s local filesystem into the sandbox.',
      inputSchema: z.object({
        local_path: z.string().describe('Absolute path to local file'),
        sandbox_path: z.string().describe('Path in sandbox to write (e.g. /tmp/input.docx)'),
      }),
      callback: async (input) => {
        try {
          const localPath = resolveLocalPath(input.local_path);
          const buffer = await fsPromises.readFile(localPath);
          await uploadToSandbox(input.sandbox_path, buffer);
          return JSON.stringify({ success: true, local: localPath, sandbox: input.sandbox_path, size: buffer.length });
        } catch (err) {
          onStatus?.(`Read error: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      },
    }),

    web: () => tool({
      name: 'web',
      description: 'Browse the web. Provide a URL to read a page, or a query to search the web.',
      inputSchema: z.object({
        url: z.string().optional().describe('URL to navigate to'),
        query: z.string().optional().describe('Search query'),
      }),
      callback: async (input) => {
        try {
          if (input.url) {
            onStatus?.(`Reading ${input.url}...`);
            const res = await fetch(input.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HiveAgent/1.0)' },
              signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`Failed to read URL (${res.status})`);
            const html = await res.text();
            const content = html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{2,}/g, ' ')
              .trim()
              .substring(0, 15000);
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            return JSON.stringify({ url: input.url, title: titleMatch?.[1]?.trim() || '', content });
          }

          if (!webSearchManager?.ready) throw new Error('Web search not available — AgentCore Gateway not initialized');
          onStatus?.(`Searching: ${input.query}...`);
          const results = await webSearchManager.search(input.query, 5);
          return JSON.stringify({ query: input.query, source: 'agentcore', results });
        } catch (err) {
          onStatus?.(`Web error: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      },
    }),

    generate_image: () => tool({
      name: 'generate_image',
      description: 'Generate an image using AI. Returns the sandbox path of the generated image.',
      inputSchema: z.object({
        prompt: z.string().describe('Detailed description of the image'),
        negative_prompt: z.string().optional().describe('What to avoid in the image'),
        width: z.number().optional().describe('Width in pixels (default 1024)'),
        height: z.number().optional().describe('Height in pixels (default 1024)'),
      }),
      callback: async (input) => {
        try {
          const w = input.width || 1024;
          const h = input.height || 1024;
          onStatus?.(`Generating image: ${input.prompt?.slice(0, 40)}...`);

          let base64Image;
          let modelUsed;
          const smEndpoint = settings?.sagemakerImageEndpoint;

          if (smEndpoint) {
            try {
              const { SageMakerRuntimeClient, InvokeEndpointCommand } = require('@aws-sdk/client-sagemaker-runtime');
              const smClient = new SageMakerRuntimeClient({ region: settings.region || 'us-east-1' });
              const payload = JSON.stringify({
                text_prompts: [
                  { text: input.prompt },
                  ...(input.negative_prompt ? [{ text: input.negative_prompt, weight: -1 }] : []),
                ],
                width: w, height: h, samples: 1, steps: 30, cfg_scale: 7.5,
              });
              const params = {
                EndpointName: smEndpoint, ContentType: 'application/json', Accept: 'application/json', Body: Buffer.from(payload),
              };
              if (settings.sagemakerImageComponent) params.InferenceComponentName = settings.sagemakerImageComponent;
              const response = await smClient.send(new InvokeEndpointCommand(params));
              base64Image = JSON.parse(Buffer.from(response.Body).toString()).generated_image;
              modelUsed = 'sdxl-1.0-sagemaker';
            } catch (err) {
              log.warn('[swarm] SageMaker image gen failed, falling back to Nova Canvas:', err.message);
            }
          }

          if (!base64Image) {
            const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
            const client = new BedrockRuntimeClient({ region: settings?.region || 'us-east-1', credentials: settings?.credentials });
            const body = JSON.stringify({
              taskType: 'TEXT_IMAGE',
              textToImageParams: {
                text: input.prompt,
                ...(input.negative_prompt && { negativeText: input.negative_prompt }),
              },
              imageGenerationConfig: { numberOfImages: 1, width: w, height: h, cfgScale: 8.0 },
            });
            const response = await client.send(new InvokeModelCommand({
              modelId: 'amazon.nova-canvas-v1:0', body, accept: 'application/json', contentType: 'application/json',
            }));
            base64Image = JSON.parse(new TextDecoder().decode(response.body)).images[0];
            modelUsed = 'amazon.nova-canvas-v1:0';
          }

          // Write to sandbox for document embedding
          if (!codeInterpreterManager.sessionId) await codeInterpreterManager.startSession(7200);
          const sandboxPath = `/tmp/generated_${Date.now()}.png`;
          const code = `import base64\ndata = base64.b64decode("""${base64Image}""")\nwith open("${sandboxPath}", "wb") as f:\n    f.write(data)\nprint(f"Image saved: ${sandboxPath} ({len(data)} bytes)")`;
          await codeInterpreterManager.executeCode(code);

          return JSON.stringify({ success: true, model: modelUsed, sandbox_path: sandboxPath, width: w, height: h });
        } catch (err) {
          onStatus?.(`Image generation error: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      },
    }),

    list_directory: () => tool({
      name: 'list_directory',
      description: 'List files and folders in a local directory.',
      inputSchema: z.object({ dir_path: z.string().describe('Absolute path to directory') }),
      callback: async (input) => {
        try {
          const dirPath = resolveLocalPath(input.dir_path);
          const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
          const items = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
          return JSON.stringify({ path: dirPath, count: items.length, entries: items });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      },
    }),
  };

  return toolNames
    .filter(name => registry[name])
    .map(name => registry[name]());
}

module.exports = { createSwarmTools };
