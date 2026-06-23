// Hasna Notes — local AI sidecar.
//
// A tiny dependency-light HTTP server (Node's built-in `http`, no framework) that the
// macOS host spawns on launch. It exposes local AI capabilities to the file:// renderer,
// both implemented with the **Vercel AI SDK** (ai-sdk.dev) over OpenAI:
//
//   POST /title       — summarize a note body into a short 3–4 word title
//                        (generateText + openai('gpt-4o-mini'))
//   POST /transcribe  — speech-to-text for voice notes
//                        (experimental_transcribe + openai.transcription('gpt-4o-transcribe'))
//   WS   /realtime-transcribe
//                      — normalized streaming transcript events from OpenAI Realtime
//                        or optional ElevenLabs Scribe v2 Realtime
//   POST /chat        — AI SDK streamText/tool-call chat over a supplied notes snapshot
//   GET  /health      — liveness probe
//
// Configuration is entirely via env, provided by the host:
//   OPENAI_API_KEY  — the OpenAI key (never logged)
//   PORT            — TCP port to bind on 127.0.0.1
//
// CORS is wide-open (Access-Control-Allow-Origin: *) ONLY because the renderer is a
// local file:// page talking to 127.0.0.1; the server binds to loopback so nothing
// off-box can reach it. The API key is never written to stdout/stderr.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { generateText, experimental_transcribe as transcribe, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// Provider instance bound to the host-supplied key. Created up front so a missing key
// surfaces as a clean 500 from the request handler rather than a crash on boot.
const openai = createOpenAI({ apiKey: API_KEY });

const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const DEFAULT_OPENAI_REALTIME_SESSION_MODEL = 'gpt-realtime';
const DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const OPENAI_REALTIME_TRANSCRIPTION_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MODEL_CONFIG_WARNINGS = [];

function envModel(value) {
  return String(value || '').trim();
}

function isTranscriptionOnlyModel(model) {
  const m = envModel(model).toLowerCase();
  return m === 'gpt-realtime-whisper' ||
    m.includes('transcribe') ||
    m === 'whisper-1';
}

function normalizeBoundedTranscribeModel(model) {
  const m = envModel(model);
  if (!m) return DEFAULT_TRANSCRIBE_MODEL;
  if (m === DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL) {
    MODEL_CONFIG_WARNINGS.push(
      `Ignoring HASNA_NOTES_TRANSCRIBE_MODEL=${m}; bounded transcription uses ${DEFAULT_TRANSCRIBE_MODEL}.`
    );
    return DEFAULT_TRANSCRIBE_MODEL;
  }
  return m;
}

function normalizeRealtimeSessionModel(model) {
  const m = envModel(model) || DEFAULT_OPENAI_REALTIME_SESSION_MODEL;
  if (isTranscriptionOnlyModel(m)) {
    const remediation = m === DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL
      ? `Use ${m} as HASNA_NOTES_OPENAI_REALTIME_TRANSCRIPTION_MODEL / audio.input.transcription.model instead.`
      : `Use ${m} as HASNA_NOTES_TRANSCRIBE_MODEL only when explicitly choosing bounded transcription.`;
    MODEL_CONFIG_WARNINGS.push(
      `Ignoring realtime session model ${m}; transcription-only models are not valid realtime session models. ${remediation}`
    );
    return DEFAULT_OPENAI_REALTIME_SESSION_MODEL;
  }
  return m;
}

function normalizeRealtimeTranscriptionModel(model) {
  return envModel(model) || DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL;
}

const TITLE_MODEL = process.env.HASNA_NOTES_TITLE_MODEL || 'gpt-4o-mini';
const CHAT_MODEL = process.env.HASNA_NOTES_CHAT_MODEL || process.env.HASNA_NOTES_TITLE_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_MODEL = normalizeBoundedTranscribeModel(process.env.HASNA_NOTES_TRANSCRIBE_MODEL);
const OPENAI_REALTIME_SESSION_MODEL = normalizeRealtimeSessionModel(
  process.env.HASNA_NOTES_OPENAI_REALTIME_SESSION_MODEL ||
  process.env.HASNA_NOTES_OPENAI_REALTIME_MODEL
);
const OPENAI_REALTIME_TRANSCRIPTION_MODEL = normalizeRealtimeTranscriptionModel(
  process.env.HASNA_NOTES_OPENAI_REALTIME_TRANSCRIPTION_MODEL ||
  process.env.HASNA_NOTES_REALTIME_TRANSCRIPTION_MODEL
);
const ELEVENLABS_REALTIME_MODEL = process.env.HASNA_NOTES_ELEVENLABS_REALTIME_MODEL || 'scribe_v2_realtime';
const DEFAULT_REALTIME_PROVIDER = (process.env.HASNA_NOTES_TRANSCRIPTION_PROVIDER || 'openai').toLowerCase();

// ------------------------------------------------------------------ helpers

// Apply the loopback-CORS headers to every response (incl. errors and preflight).
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

function sendJSON(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Read and JSON-parse a request body, capped so a runaway upload can't exhaust memory.
// 25 MB is comfortably above a base64-encoded short voice note.
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const MAX = 25 * 1024 * 1024;
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Normalize a model-produced title: strip surrounding quotes, collapse whitespace, drop a
// trailing period, and cap at 4 words so a chatty model can't return a paragraph.
function cleanTitle(s) {
  let t = String(s || '').trim();
  t = t.replace(/\s+/g, ' ');
  // strip a single layer of wrapping quotes (straight or curly)
  t = t.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
  t = t.replace(/[.\s]+$/, '').trim();
  const words = t.split(' ').filter(Boolean);
  if (words.length > 4) t = words.slice(0, 4).join(' ');
  if (/^(untitled|new note|note|summary)$/i.test(t)) return '';
  return t;
}

// ------------------------------------------------------------------ handlers

async function handleTitle(req, res) {
  if (!API_KEY) return sendJSON(res, 500, { error: 'no_api_key' });
  let body;
  try { body = await readJSON(req); }
  catch (e) { return sendJSON(res, 400, { error: String(e.message || e) }); }

  const text = String(body.text || '').trim();
  if (!text) return sendJSON(res, 400, { error: 'empty_text' });

  const prompt =
    'Write a specific, human note title of 3 to 4 words maximum that summarizes the note below. ' +
    'Plain text only — no quotes, no surrounding punctuation, no trailing period, ' +
    'no "Title:" prefix, and no generic titles like "Untitled" or "Meeting Notes". ' +
    'Use title case. Respond with the title and nothing else.\n\n' +
    'NOTE:\n' + text.slice(0, 4000);

  try {
    const { text: out } = await generateText({
      model: openai(TITLE_MODEL),
      prompt,
      temperature: 0.2,
    });
    const title = cleanTitle(out);
    return sendJSON(res, 200, { title });
  } catch (e) {
    // Never echo the key; log only the error message.
    console.error('Sidecar: /title failed:', e && e.message ? e.message : e);
    return sendJSON(res, 502, { error: 'title_failed' });
  }
}

async function handleTranscribe(req, res) {
  if (!API_KEY) return sendJSON(res, 500, { error: 'no_api_key' });
  let body;
  try { body = await readJSON(req); }
  catch (e) { return sendJSON(res, 400, { error: String(e.message || e) }); }

  const b64 = String(body.audioBase64 || '');
  if (!b64) return sendJSON(res, 400, { error: 'empty_audio' });

  let audio;
  try { audio = Buffer.from(b64, 'base64'); }
  catch { return sendJSON(res, 400, { error: 'bad_base64' }); }
  if (!audio.length) return sendJSON(res, 400, { error: 'empty_audio' });

  const mediaType = String(body.mime || 'audio/webm');

  try {
    const result = await transcribe({
      model: openai.transcription(TRANSCRIBE_MODEL),
      audio,
      providerOptions: { openai: {} },
      // mediaType is best-effort; the provider also sniffs the buffer.
      ...(mediaType ? { mediaType } : {}),
    });
    return sendJSON(res, 200, { text: String(result.text || '').trim() });
  } catch (e) {
    console.error('Sidecar: /transcribe failed:', e && e.message ? e.message : e);
    return sendJSON(res, 502, { error: 'transcribe_failed' });
  }
}

function chooseRealtimeProvider(requested) {
  if (requested === 'elevenlabs' && ELEVENLABS_API_KEY) return 'elevenlabs';
  if (requested === 'openai' && API_KEY) return 'openai';
  if (API_KEY) return 'openai';
  if (ELEVENLABS_API_KEY) return 'elevenlabs';
  return '';
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function noteRef(note) {
  return {
    id: note.id,
    title: note.title || 'Untitled Note',
    labels: Array.isArray(note.labels) ? note.labels : [],
    status: note.status || 'active',
    machine: note.machine || '',
    updatedAt: note.updatedAt || '',
  };
}

function plainNoteText(note) {
  return String(note.body || note.content || '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/^```[^\n]*\n?|\n?```$/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function notesFromBody(body) {
  return Array.isArray(body.notes) ? body.notes.map(note => ({
    id: String(note.id || ''),
    title: String(note.title || 'Untitled Note'),
    body: String(note.body || note.content || ''),
    labels: Array.isArray(note.labels) ? note.labels.map(String) : [],
    status: String(note.status || 'active'),
    machine: String(note.machine || ''),
    updatedAt: String(note.updatedAt || ''),
    createdAt: String(note.createdAt || ''),
  })).filter(note => note.id) : [];
}

function snapshotTools(notes) {
  const findById = id => notes.find(note => note.id === String(id));
  const search = (query, limit = 10) => {
    const q = String(query || '').toLowerCase();
    const found = notes.filter(note => {
      if (note.status === 'trash') return false;
      return !q || `${note.title} ${note.body} ${note.labels.join(' ')}`.toLowerCase().includes(q);
    }).slice(0, Math.max(1, Number(limit || 10)));
    return found;
  };
  return {
    search_notes: tool({
      description: 'Search the provided Hasna Notes snapshot.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      }),
      execute: async ({ query, limit }) => {
        const items = search(query, limit).map(noteRef);
        return { items, sources: items };
      },
    }),
    read_note: tool({
      description: 'Read one note body from the provided Hasna Notes snapshot.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      }),
      execute: async ({ id }) => {
        const note = findById(id);
        return note ? { note, sources: [noteRef(note)] } : { error: 'note_not_found' };
      },
    }),
    summarize_notes: tool({
      description: 'Summarize matching notes from the provided snapshot.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      }),
      execute: async ({ query, limit }) => {
        const selected = search(query || '', limit || 10);
        return {
          summary: selected.length
            ? selected.map(note => `- ${note.title}: ${plainNoteText(note).slice(0, 220)}`).join('\n')
            : 'No matching notes found.',
          sources: selected.map(noteRef),
        };
      },
    }),
    consolidate_preview: tool({
      description: 'Prepare a dry-run consolidation preview. This tool never writes.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' }, title: { type: 'string' }, limit: { type: 'number' } },
      }),
      execute: async ({ query, title, limit }) => {
        const selected = search(query || '', limit || 20);
        return {
          dryRun: true,
          title: title || 'Consolidated Notes',
          bodyPreview: selected.map(note => `## ${note.title}\n\n${note.body || ''}`).join('\n\n').slice(0, 2000),
          sources: selected.map(noteRef),
        };
      },
    }),
  };
}

async function handleChat(req, res) {
  if (!API_KEY) return sendJSON(res, 500, { error: 'no_api_key' });
  let body;
  try { body = await readJSON(req); }
  catch (e) { return sendJSON(res, 400, { error: String(e.message || e) }); }

  const notes = notesFromBody(body);
  const prompt = String(body.prompt || body.message || '').trim();
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!prompt && !messages) return sendJSON(res, 400, { error: 'empty_prompt' });

  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  const writeEvent = event => res.write(JSON.stringify(event) + '\n');
  writeEvent({ type: 'ready', provider: 'openai', model: CHAT_MODEL });

  try {
    const result = streamText({
      model: openai(CHAT_MODEL),
      system: 'You are Hasna Notes Chat. Use tools to inspect notes before answering. Cite sources by note title/id. Destructive or broad writes must be described as previews only; never claim you wrote unless the host confirms through its own tools.',
      ...(messages ? { messages } : { prompt }),
      tools: snapshotTools(notes),
      stopWhen: stepCountIs(Number(body.maxSteps || 8)),
      temperature: 0.2,
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') writeEvent({ type: 'text-delta', text: part.text || part.delta || '' });
      else if (part.type === 'tool-call') writeEvent({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
      else if (part.type === 'tool-result') writeEvent({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: part.output });
      else if (part.type === 'error') writeEvent({ type: 'error', error: part.error?.message || String(part.error || 'chat_error') });
    }
    const text = await result.text.catch(() => '');
    writeEvent({ type: 'finish', text });
    res.end();
  } catch (e) {
    console.error('Sidecar: /chat failed:', e && e.message ? e.message : e);
    writeEvent({ type: 'error', error: 'chat_failed' });
    res.end();
  }
}

function bridgeOpenAIRealtime(client, sampleRate) {
  if (isTranscriptionOnlyModel(OPENAI_REALTIME_SESSION_MODEL)) {
    safeSend(client, {
      type: 'error',
      provider: 'openai',
      error: 'invalid_realtime_session_model',
    });
    return;
  }

  const openaiPartials = new Map();
  const upstream = new WebSocket(OPENAI_REALTIME_TRANSCRIPTION_WS_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  upstream.on('open', () => {
    upstream.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: sampleRate || 24000 },
            transcription: {
              model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
              delay: process.env.HASNA_NOTES_REALTIME_DELAY || 'low',
            },
            turn_detection: null,
          },
        },
      },
    }));
    safeSend(client, {
      type: 'ready',
      provider: 'openai',
      sampleRate: sampleRate || 24000,
      model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
      sessionModel: OPENAI_REALTIME_SESSION_MODEL,
      mode: 'transcription_session',
    });
  });

  upstream.on('message', (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = ev.item_id || 'default';
      const text = (openaiPartials.get(itemId) || '') + (ev.delta || '');
      openaiPartials.set(itemId, text);
      safeSend(client, { type: 'transcript.delta', provider: 'openai', itemId, text, delta: ev.delta || '' });
    } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = ev.item_id || 'default';
      openaiPartials.delete(itemId);
      safeSend(client, { type: 'transcript.completed', provider: 'openai', itemId, text: ev.transcript || '' });
    } else if (ev.type === 'error') {
      safeSend(client, { type: 'error', provider: 'openai', error: ev.error?.message || ev.error || 'openai_realtime_error' });
    }
  });

  upstream.on('error', (err) => safeSend(client, { type: 'error', provider: 'openai', error: err.message || 'openai_realtime_error' }));
  upstream.on('close', () => { try { client.close(); } catch {} });

  client.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'audio' && msg.audio && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audio }));
    } else if (msg.type === 'commit' && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
  });
  client.on('close', () => { try { upstream.close(); } catch {} });
}

function bridgeElevenLabsRealtime(client, sampleRate) {
  const params = new URLSearchParams({
    model_id: ELEVENLABS_REALTIME_MODEL,
    audio_format: sampleRate === 24000 ? 'pcm_24000' : 'pcm_16000',
    commit_strategy: 'manual',
    include_timestamps: 'false',
  });
  const upstream = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  });

  upstream.on('open', () => {
    safeSend(client, { type: 'ready', provider: 'elevenlabs', sampleRate, model: ELEVENLABS_REALTIME_MODEL });
  });
  upstream.on('message', (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.message_type === 'partial_transcript') {
      safeSend(client, { type: 'transcript.delta', provider: 'elevenlabs', text: ev.text || '' });
    } else if (ev.message_type === 'committed_transcript' || ev.message_type === 'committed_transcript_with_timestamps') {
      safeSend(client, { type: 'transcript.completed', provider: 'elevenlabs', text: ev.text || '', languageCode: ev.language_code });
    } else if (String(ev.message_type || '').toLowerCase().includes('error')) {
      safeSend(client, { type: 'error', provider: 'elevenlabs', error: ev.message || ev.error || ev.message_type });
    }
  });
  upstream.on('error', (err) => safeSend(client, { type: 'error', provider: 'elevenlabs', error: err.message || 'elevenlabs_realtime_error' }));
  upstream.on('close', () => { try { client.close(); } catch {} });

  client.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'audio' && msg.audio && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: msg.audio,
        sample_rate: msg.sampleRate || sampleRate,
        commit: false,
      }));
    } else if (msg.type === 'commit' && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: sampleRate,
        commit: true,
      }));
    }
  });
  client.on('close', () => { try { upstream.close(); } catch {} });
}

// ------------------------------------------------------------------ server

const server = http.createServer((req, res) => {
  // Preflight: answer every OPTIONS with 204 + CORS headers.
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      ok: true,
      titleModel: TITLE_MODEL,
      chatModel: CHAT_MODEL,
      transcribeModel: TRANSCRIBE_MODEL,
      realtime: !!API_KEY || !!ELEVENLABS_API_KEY,
      realtimeProvider: chooseRealtimeProvider(DEFAULT_REALTIME_PROVIDER),
      realtimeModels: {
        openaiSession: OPENAI_REALTIME_SESSION_MODEL,
        openaiTranscription: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
        elevenlabs: ELEVENLABS_REALTIME_MODEL,
      },
      realtimeEndpoints: {
        openai: '/v1/realtime?intent=transcription',
      },
      configWarnings: MODEL_CONFIG_WARNINGS,
    });
  }
  if (req.method === 'POST' && url === '/title') {
    return handleTitle(req, res);
  }
  if (req.method === 'POST' && url === '/transcribe') {
    return handleTranscribe(req, res);
  }
  if (req.method === 'POST' && url === '/chat') {
    return handleChat(req, res);
  }

  sendJSON(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname !== '/realtime-transcribe') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    wss.emit('connection', client, req, url);
  });
});

wss.on('connection', (client, _req, url) => {
  const requested = (url.searchParams.get('provider') || DEFAULT_REALTIME_PROVIDER).toLowerCase();
  const provider = chooseRealtimeProvider(requested);
  const sampleRate = Number(url.searchParams.get('sampleRate') || (provider === 'elevenlabs' ? 16000 : 24000));

  if (!provider) {
    safeSend(client, { type: 'error', error: 'no_realtime_provider' });
    client.close();
    return;
  }

  if (provider === 'elevenlabs') {
    bridgeElevenLabsRealtime(client, sampleRate);
  } else {
    bridgeOpenAIRealtime(client, sampleRate);
  }
});

server.listen(PORT, HOST, () => {
  // The host greps this line for the port. Never includes the key.
  console.log(`Sidecar: listening on http://${HOST}:${PORT} (key=${API_KEY ? 'present' : 'MISSING'})`);
});

// Clean shutdown when the host terminates the child.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { try { wss.close(); } catch {} try { server.close(); } catch {} process.exit(0); });
}
