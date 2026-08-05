const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const CodeInterpreterManager = require('../models/codeInterpreterManager');
const TranscriptMapper = require('../models/transcriptMapper');
const { createAgent } = require('../models/strandsAgentFactory');
const { buildFileContentBlocks } = require('../utils');
const config = require('../../../config');
const logger = require('electron-log/main');

/**
 * Chat tab model invocation — simple, non-agentic back-and-forth with any
 * configured model. Uses the same createAgent() factory as Work/Swarm (so
 * Mantle routing, retry classification, and thinking support all come for
 * free and never drift out of sync with those tabs), but with an empty
 * `tools: []` array and no persistent memory — the whole point of Chat is
 * a single model call with no tool loop.
 *
 * Previously this hand-rolled a Bedrock Converse streaming loop directly
 * against ConverseStreamCommand. Now that Bedrock Converse/BedrockModel has
 * been removed entirely in favor of Mantle-only routing, this goes through
 * createAgent()/agent.stream() like every other model call in Hive.
 */
async function invokeChatModel(ctx, model, prompt, conversationHistory, files = [], event = null, signal = null) {
  const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
  if (!settings.mantleApiKey) {
    throw new Error('Mantle API key not configured — set it in Settings > Mantle API Key');
  }

  if (files && files.length > 5) {
    throw new Error('Maximum 5 documents allowed per message');
  }

  const messageContent = [{ text: prompt }];

  if (files && files.length > 0) {
    logger.info(`Processing ${files.length} files for Chat analysis`);
    const ci = new CodeInterpreterManager(ctx.awsClients.agentCoreConfig);
    const fileBlocks = await buildFileContentBlocks(files, {
      codeInterpreter: ci,
      stopSession: true,
    });
    messageContent.push(...fileBlocks);
  }

  const { agent, dispose } = createAgent({
    modelId: model,
    region: settings.region,
    mantleApiKey: settings.mantleApiKey,
    systemPrompt: 'You are a helpful assistant. Answer questions clearly and concisely based on the conversation and any attached files.',
    tools: [],
    id: 'chat',
    maxTokens: 4096,
  });

  const userInput = [
    ...(conversationHistory || []),
    { role: 'user', content: messageContent },
  ];

  let fullText = '';
  try {
    for await (const streamEvent of agent.stream(userInput)) {
      if (signal?.aborted) break;
      if (streamEvent.type === 'modelStreamUpdateEvent') {
        const inner = streamEvent.event;
        if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          fullText += inner.delta.text;
          if (event) event.sender.send('bedrock-stream-chunk', inner.delta.text);
        }
      }
    }
  } finally {
    dispose();
  }

  if (event) event.sender.send('bedrock-stream-complete');
  return fullText;
}

function getMediaFormat(uri) {
  const lowerUri = uri.toLowerCase();
  const formats = { '.mp3': 'mp3', '.wav': 'wav', '.flac': 'flac', '.ogg': 'ogg', '.amr': 'amr', '.webm': 'webm', '.mp4': 'mp4', '.mov': 'mov', '.avi': 'avi', '.mkv': 'mkv', '.flv': 'flv' };
  for (const [ext, fmt] of Object.entries(formats)) {
    if (lowerUri.endsWith(ext)) return fmt;
  }
  return 'mp4';
}

async function uploadFile(ctx, file, bucket, key) {
  const upload = new Upload({
    client: ctx.awsClients.s3,
    params: { Bucket: bucket, Key: key, Body: file.buffer, ContentType: file.mimetype },
    ...(file.buffer.length >= 20 * 1024 * 1024 ? { queueSize: 4, partSize: 5 * 1024 * 1024 } : {}),
  });
  await upload.done();
  return `s3://${bucket}/${key}`;
}

function register(ipcMain, ctx) {
  ipcMain.handle('cancel-bedrock', () => {
    if (ctx.bedrockAbortController) { ctx.bedrockAbortController.abort(); ctx.bedrockAbortController = null; }
  });

  ipcMain.handle('send-to-bedrock', async (event, { model, prompt, conversationHistory, files = [] }) => {
    ctx.bedrockAbortController = new AbortController();
    const { signal } = ctx.bedrockAbortController;
    try {
      return await invokeChatModel(ctx, model, prompt, conversationHistory, files, event, signal);
    } finally {
      ctx.bedrockAbortController = null;
    }
  });

  ipcMain.handle('get-bedrock-models', async () => {
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    return settings.bedrockModels || config.bedrockModels;
  });

  ipcMain.handle('transcribe-media', async (event, { file }) => {
    if (!ctx.awsClients.transcribe) throw new Error('AWS credentials not configured');

    const fileBuffer = Buffer.from(file.buffer);
    const fileObj = { buffer: fileBuffer, originalname: file.name, mimetype: file.type };

    event.sender.send('transcription-progress', { status: 'UPLOADING', message: 'Uploading file to S3...' });

    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    const mediaUri = await uploadFile(ctx, fileObj, settings.bucketName, `${Date.now()}-${fileObj.originalname}`);
    const mediaFormat = getMediaFormat(mediaUri);
    const jobName = `transcription-${Date.now()}`;

    const startCmd = new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: mediaUri },
      MediaFormat: mediaFormat,
      LanguageCode: settings.transcriptionLanguage,
      OutputBucketName: settings.outputBucketName,
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 5 },
    });
    await ctx.awsClients.transcribe.send(startCmd);

    event.sender.send('transcription-progress', { status: 'IN_PROGRESS', message: 'Transcription job started. Processing audio...' });

    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const statusCmd = new GetTranscriptionJobCommand({ TranscriptionJobName: jobName });
      const statusRes = await ctx.awsClients.transcribe.send(statusCmd);
      const job = statusRes.TranscriptionJob;

      if (job.TranscriptionJobStatus === 'COMPLETED') {
        event.sender.send('transcription-progress', { status: 'RETRIEVING', message: 'Retrieving transcription results...' });
        const url = new URL(job.Transcript.TranscriptFileUri);
        const bucket = url.pathname.split('/')[1];
        const key = url.pathname.split('/').slice(2).join('/');
        const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
        const objRes = await ctx.awsClients.s3.send(getCmd);
        const transcript = JSON.parse(await objRes.Body.transformToString());
        const mapper = new TranscriptMapper(transcript);
        return { status: 'COMPLETED', transcript: mapper.getAllTimestampedText(), jobName };
      } else if (job.TranscriptionJobStatus === 'FAILED') {
        throw new Error(`Transcription job failed: ${job.FailureReason || 'Unknown error'}`);
      }

      const elapsed = Math.floor((attempt + 1) * pollInterval / 1000);
      event.sender.send('transcription-progress', { status: 'IN_PROGRESS', message: `Processing audio... (${elapsed}s elapsed)` });
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Transcription job timed out after 5 minutes');
  });
}

module.exports = { register, invokeChatModel };
