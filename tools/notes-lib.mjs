import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function dataRoot() {
  return process.env.HASNA_NOTES_ROOT || join(homedir(), '.hasna', 'apps', 'notes');
}

export function notesDir(root = dataRoot()) {
  return join(root, 'notes');
}

function labelsFile(root = dataRoot()) {
  return join(root, 'labels.json');
}

function settingsFile(root = dataRoot()) {
  return join(root, 'settings.json');
}

function machinesManifestFile() {
  return process.env.HASNA_MACHINES_MANIFEST || join(homedir(), '.hasna', 'machines', 'machines.json');
}

export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const CONTENT_FORMAT_MARKDOWN = 'markdown';

export function normalizeLabels(labels) {
  const seen = new Set();
  const out = [];
  for (const raw of labels || []) {
    const label = String(raw || '').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return null;
  if (/^(true|1|yes|online)$/i.test(String(value))) return true;
  if (/^(false|0|no|offline)$/i.test(String(value))) return false;
  return null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pickString(entry, keys, fallback = '') {
  for (const key of keys) {
    const value = entry?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function pickTimestamp(entry, keys) {
  for (const key of keys) {
    const value = entry?.[key];
    if (!value) continue;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return '';
}

function maxISO(values) {
  let max = '';
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isNaN(time)) continue;
    if (!max || time > Date.parse(max)) max = new Date(time).toISOString();
  }
  return max;
}

function normalizeCapabilities(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (value && typeof value === 'object') return value;
  if (value == null || value === '') return [];
  return [String(value)];
}

function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function splitTopLevelCommas(s) {
  const out = [];
  let cur = '', inQuotes = false, escaped = false;
  for (const ch of s) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && inQuotes) { cur += ch; escaped = true; continue; }
    if (ch === '"') { inQuotes = !inQuotes; cur += ch; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unquote(value) {
  const v = String(value || '').trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function yamlScalar(value) {
  const v = String(value ?? '');
  const needs = !v || /[:#[\],"\n\\]/.test(v) || /^\s|\s$/.test(v);
  if (!needs) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function parseList(value) {
  let v = String(value || '').trim();
  if (v.startsWith('[')) v = v.slice(1);
  if (v.endsWith(']')) v = v.slice(0, -1);
  return normalizeLabels(splitTopLevelCommas(v).map(x => unquote(x.trim())));
}

function parseFrontmatter(lines) {
  const fields = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

export const MARKDOWN_COMMANDS = [
  { id: 'bold', label: 'Bold', type: 'inline', markdown: '**text**' },
  { id: 'italic', label: 'Italic', type: 'inline', markdown: '*text*' },
  { id: 'code', label: 'Inline code', type: 'inline', markdown: '`text`' },
  { id: 'link', label: 'Link', type: 'inline', markdown: '[text](url)' },
  { id: 'h1', label: 'Heading 1', type: 'block', markdown: '# text' },
  { id: 'h2', label: 'Heading 2', type: 'block', markdown: '## text' },
  { id: 'h3', label: 'Heading 3', type: 'block', markdown: '### text' },
  { id: 'paragraph', label: 'Paragraph', type: 'block', markdown: 'text' },
  { id: 'bullet-list', label: 'Bullet list', type: 'block', markdown: '- text' },
  { id: 'numbered-list', label: 'Numbered list', type: 'block', markdown: '1. text' },
  { id: 'quote', label: 'Quote', type: 'block', markdown: '> text' },
  { id: 'code-block', label: 'Code block', type: 'block', markdown: '```\\ntext\\n```' },
  { id: 'checklist', label: 'Checklist', type: 'block', markdown: '- [ ] text' },
  { id: 'divider', label: 'Divider', type: 'insert', markdown: '---' },
];

export function markdownSafeText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+\-.!>|])/g, '\\$1');
}

function escapeHTML(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '';
  if (raw.startsWith('//')) return '';
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (/^(\/(?!\/)|[?#]|\.\.?\/)/.test(raw)) return raw;
  return '';
}

function stripMarkdownEscapes(text) {
  return String(text || '').replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, '$1');
}

export function markdownPlainText(markdown) {
  let text = String(markdown || '').replace(/\r\n/g, '\n');
  text = text.replace(/```[\s\S]*?```/g, block => block.replace(/^```[^\n]*\n?|\n?```$/g, ''));
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>\n]+>/g, ' ');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/^\s*---+\s*$/gm, ' ');
  text = text.replace(/[*_~#]+/g, '');
  return stripMarkdownEscapes(text).replace(/\s+/g, ' ').trim();
}

function renderInlineMarkdown(text) {
  const placeholders = [];
  const hold = html => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };
  const restore = value => {
    let out = value;
    for (let pass = 0; pass <= placeholders.length; pass += 1) {
      const before = out;
      placeholders.forEach((html, i) => { out = out.replaceAll(`\u0000${i}\u0000`, html); });
      if (out === before) break;
    }
    return out;
  };
  let out = String(text || '').replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, (_, ch) => hold(escapeHTML(ch)));
  out = out.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHTML(code)}</code>`));
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, label) => hold(escapeHTML(label)));
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = safeURL(href);
    return safe ? hold(`<a href="${escapeHTML(safe)}" rel="nofollow noopener noreferrer">${escapeHTML(label)}</a>`) : hold(escapeHTML(label));
  });
  out = escapeHTML(out);
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return restore(out);
}

export function renderMarkdownSafe(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let inCode = false;
  let code = [];
  let quote = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.join('')}</${list.type}>`);
    list = null;
  };
  const closeQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map(renderInlineMarkdown).join('<br>')}</blockquote>`);
    quote = [];
  };
  const closeBlocks = () => { closeParagraph(); closeList(); closeQuote(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
        inCode = false;
        code = [];
      } else {
        closeBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeBlocks();
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      closeBlocks();
      html.push('<hr>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeBlocks();
      html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      closeParagraph();
      closeList();
      quote.push(quoted[1]);
      continue;
    }
    const checklist = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (checklist) {
      closeParagraph();
      closeQuote();
      if (!list || list.type !== 'ul') { closeList(); list = { type: 'ul', items: [] }; }
      const checked = checklist[1].toLowerCase() === 'x' ? ' checked' : '';
      list.items.push(`<li><input type="checkbox" disabled${checked}> ${renderInlineMarkdown(checklist[2])}</li>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      closeParagraph();
      closeQuote();
      if (!list || list.type !== 'ul') { closeList(); list = { type: 'ul', items: [] }; }
      list.items.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      closeParagraph();
      closeQuote();
      if (!list || list.type !== 'ol') { closeList(); list = { type: 'ol', items: [] }; }
      list.items.push(`<li>${renderInlineMarkdown(numbered[1])}</li>`);
      continue;
    }
    closeList();
    closeQuote();
    paragraph.push(line.trim());
  }
  if (inCode) html.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
  closeBlocks();
  return html.join('\n');
}

function selectedRange(text, start, end) {
  const length = String(text || '').length;
  const s = Math.max(0, Math.min(length, Number(start ?? length)));
  const e = Math.max(0, Math.min(length, Number(end ?? s)));
  return [Math.min(s, e), Math.max(s, e)];
}

function lineRangeForSelection(text, start, end) {
  const before = text.lastIndexOf('\n', Math.max(0, start - 1));
  const lineStart = before < 0 ? 0 : before + 1;
  const after = text.indexOf('\n', end);
  const lineEnd = after < 0 ? text.length : after;
  return [lineStart, lineEnd];
}

function stripBlockPrefix(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '');
}

function replaceRange(text, start, end, value, selectionStart, selectionEnd) {
  return {
    markdown: text.slice(0, start) + value + text.slice(end),
    selectionStart,
    selectionEnd,
  };
}

export function applyMarkdownCommand(markdown, input = {}) {
  const text = String(markdown || '');
  const commandId = String(input.commandId || input.id || '');
  let [start, end] = selectedRange(text, input.selectionStart, input.selectionEnd);
  const selected = text.slice(start, end);
  const fallback = selected || 'text';
  const wrapInline = (prefix, suffix = prefix) => {
    const next = prefix + fallback + suffix;
    return replaceRange(text, start, end, next, start + prefix.length, start + prefix.length + fallback.length);
  };

  if (commandId === 'bold') return wrapInline('**');
  if (commandId === 'italic') return wrapInline('*');
  if (commandId === 'code') return wrapInline('`');
  if (commandId === 'link') {
    const label = markdownSafeText(selected || input.label || 'link');
    const href = safeURL(input.href || input.url || '') || 'https://';
    const next = `[${label}](${href})`;
    return replaceRange(text, start, end, next, start + 1, start + 1 + String(label).length);
  }
  if (commandId === 'code-block') {
    const language = String(input.language || '').replace(/[`\s]/g, '');
    const body = selected || '';
    const next = '```' + language + '\n' + body + '\n```';
    return replaceRange(text, start, end, next, start + 4 + language.length, start + 4 + language.length + body.length);
  }
  if (commandId === 'divider') {
    const prefix = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
    const suffix = end < text.length && text[end] !== '\n' ? '\n' : '';
    const next = `${prefix}---${suffix}`;
    return replaceRange(text, start, end, next, start + next.length, start + next.length);
  }

  const [lineStart, lineEnd] = lineRangeForSelection(text, start, end);
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const transformed = lines.map((line, index) => {
    const content = stripBlockPrefix(line);
    if (commandId === 'h1') return '# ' + content;
    if (commandId === 'h2') return '## ' + content;
    if (commandId === 'h3') return '### ' + content;
    if (commandId === 'paragraph') return content;
    if (commandId === 'bullet-list') return '- ' + content;
    if (commandId === 'numbered-list') return `${index + 1}. ${content}`;
    if (commandId === 'quote') return '> ' + content;
    if (commandId === 'checklist') return '- [ ] ' + content;
    return line;
  }).join('\n');
  return replaceRange(text, lineStart, lineEnd, transformed, lineStart, lineStart + transformed.length);
}

export function parseNote(raw, fallbackID = randomUUID()) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    const first = text.split('\n').find(l => l.trim()) || 'Untitled Note';
    return noteFromFields({ id: fallbackID, title: first.replace(/^#+\s*/, '').slice(0, 80), body: text });
  }
  const lines = text.split('\n');
  const close = lines.findIndex((line, i) => i > 0 && line === '---');
  if (close < 0) return noteFromFields({ id: fallbackID, body: text });
  const fields = parseFrontmatter(lines.slice(1, close));
  const body = lines.slice(close + 1).join('\n');
  const parsedID = unquote(fields.id || '');
  return noteFromFields({
    id: isUUID(parsedID) ? parsedID : fallbackID,
    title: unquote(fields.title || 'Untitled Note'),
    labels: fields.labels ? parseList(fields.labels) : parseList(fields.tags || ''),
    status: fields.status || 'active',
    folder: unquote(fields.folder || ''),
    titleSource: fields.titleSource || (isDefaultTitle(unquote(fields.title || '')) ? 'default' : 'manual'),
    titleLocked: fields.titleLocked == null ? undefined : /^(true|1|yes)$/i.test(fields.titleLocked || ''),
    titleContentFingerprint: unquote(fields.titleContentFingerprint || ''),
    contentFormat: unquote(fields.contentFormat || fields.contentType || CONTENT_FORMAT_MARKDOWN),
    createdAt: fields.createdAt || new Date().toISOString(),
    updatedAt: fields.updatedAt || fields.createdAt || new Date().toISOString(),
    author: unquote(fields.author || process.env.USER || 'unknown'),
    agent: unquote(fields.agent || 'hasna-notes-app'),
    machine: unquote(fields.machine || hostnameFallback()),
    createdByActorType: unquote(fields.createdByActorType || ''),
    createdByName: unquote(fields.createdByName || ''),
    sourceMachine: unquote(fields.sourceMachine || ''),
    sourceMachineFriendlyName: unquote(fields.sourceMachineFriendlyName || ''),
    originMachine: unquote(fields.originMachine || ''),
    originMachineFriendlyName: unquote(fields.originMachineFriendlyName || ''),
    targetMachineFriendlyName: unquote(fields.targetMachineFriendlyName || ''),
    previousMachine: unquote(fields.previousMachine || ''),
    openedFrom: unquote(fields.openedFrom || ''),
    sourceContext: unquote(fields.sourceContext || ''),
    archivedAt: unquote(fields.archivedAt || ''),
    trashedAt: unquote(fields.trashedAt || ''),
    trashMachine: unquote(fields.trashMachine || ''),
    trashExpiresAt: unquote(fields.trashExpiresAt || ''),
    restoredAt: unquote(fields.restoredAt || ''),
    movedAt: unquote(fields.movedAt || ''),
    body,
  });
}

function noteFromFields(fields) {
  const title = fields.title || 'Untitled Note';
  const titleSource = fields.titleSource || (isDefaultTitle(title) ? 'default' : 'manual');
  const machine = fields.machine || fields.targetMachine || hostnameFallback();
  const actorType = fields.createdByActorType || fields.actorType || process.env.HASNA_NOTES_ACTOR_TYPE || 'human';
  const actorName = fields.createdByName || fields.actorName || process.env.HASNA_NOTES_ACTOR_NAME || fields.author || process.env.USER || 'unknown';
  const sourceMachine = fields.sourceMachine || process.env.HASNA_NOTES_SOURCE_MACHINE || hostnameFallback();
  return {
    id: isUUID(fields.id) ? String(fields.id).toLowerCase() : randomUUID(),
    title,
    labels: normalizeLabels(fields.labels || []),
    status: fields.status || 'active',
    folder: fields.folder || '',
    titleLocked: fields.titleLocked == null ? (titleSource === 'manual' && !isDefaultTitle(title)) : !!fields.titleLocked,
    titleSource,
    titleContentFingerprint: fields.titleContentFingerprint || '',
    contentFormat: CONTENT_FORMAT_MARKDOWN,
    createdAt: fields.createdAt || new Date().toISOString(),
    updatedAt: fields.updatedAt || new Date().toISOString(),
    author: fields.author || process.env.USER || 'unknown',
    agent: fields.agent || 'hasna-notes-app',
    machine,
    createdByActorType: actorType,
    createdByName: actorName,
    sourceMachine,
    sourceMachineFriendlyName: fields.sourceMachineFriendlyName || process.env.HASNA_NOTES_SOURCE_MACHINE_NAME || '',
    originMachine: fields.originMachine || machine,
    originMachineFriendlyName: fields.originMachineFriendlyName || fields.sourceMachineFriendlyName || '',
    targetMachineFriendlyName: fields.targetMachineFriendlyName || '',
    previousMachine: fields.previousMachine || '',
    openedFrom: fields.openedFrom || '',
    sourceContext: fields.sourceContext || '',
    archivedAt: fields.archivedAt || '',
    trashedAt: fields.trashedAt || '',
    trashMachine: fields.trashMachine || '',
    trashExpiresAt: fields.trashExpiresAt || '',
    restoredAt: fields.restoredAt || '',
    movedAt: fields.movedAt || '',
    body: fields.body || '',
  };
}

function hostnameFallback() {
  return process.env.HOSTNAME || 'unknown';
}

export function serializeNote(note) {
  const n = noteFromFields(note);
  const lines = [
    '---',
    `id: ${n.id.toLowerCase()}`,
    `title: ${yamlScalar(n.title)}`,
    `labels: [${normalizeLabels(n.labels).map(yamlScalar).join(', ')}]`,
    `status: ${n.status}`,
    `folder: ${yamlScalar(n.folder)}`,
    `contentFormat: ${CONTENT_FORMAT_MARKDOWN}`,
    `titleLocked: ${n.titleLocked ? 'true' : 'false'}`,
    `titleSource: ${n.titleSource}`,
    `titleContentFingerprint: ${yamlScalar(n.titleContentFingerprint)}`,
    `createdAt: ${n.createdAt}`,
    `updatedAt: ${n.updatedAt}`,
    `author: ${yamlScalar(n.author)}`,
    `agent: ${yamlScalar(n.agent)}`,
    `machine: ${yamlScalar(n.machine)}`,
    `createdByActorType: ${yamlScalar(n.createdByActorType)}`,
    `createdByName: ${yamlScalar(n.createdByName)}`,
    `sourceMachine: ${yamlScalar(n.sourceMachine)}`,
    `sourceMachineFriendlyName: ${yamlScalar(n.sourceMachineFriendlyName)}`,
    `originMachine: ${yamlScalar(n.originMachine)}`,
    `originMachineFriendlyName: ${yamlScalar(n.originMachineFriendlyName)}`,
    `targetMachineFriendlyName: ${yamlScalar(n.targetMachineFriendlyName)}`,
    `previousMachine: ${yamlScalar(n.previousMachine)}`,
    `openedFrom: ${yamlScalar(n.openedFrom)}`,
    `sourceContext: ${yamlScalar(n.sourceContext)}`,
    `archivedAt: ${yamlScalar(n.archivedAt)}`,
    `trashedAt: ${yamlScalar(n.trashedAt)}`,
    `trashMachine: ${yamlScalar(n.trashMachine)}`,
    `trashExpiresAt: ${yamlScalar(n.trashExpiresAt)}`,
    `restoredAt: ${yamlScalar(n.restoredAt)}`,
    `movedAt: ${yamlScalar(n.movedAt)}`,
    '---',
  ];
  return lines.join('\n') + '\n' + n.body;
}

export async function loadNotes(root = dataRoot()) {
  const dir = notesDir(root);
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir).catch(() => []);
  const notes = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (raw == null) continue;
    notes.push(parseNote(raw, file.replace(/\.md$/, '')));
  }
  return notes.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

export async function saveNote(note, root = dataRoot()) {
  const dir = notesDir(root);
  await mkdir(dir, { recursive: true });
  const n = noteFromFields(note);
  const path = join(dir, `${n.id.toLowerCase()}.md`);
  const tmp = join(dir, `.${n.id}.${randomUUID()}.tmp`);
  await writeFile(tmp, serializeNote(n), 'utf8');
  await rename(tmp, path);
  return n;
}

export async function deleteNote(id, root = dataRoot()) {
  const path = join(notesDir(root), `${String(id).toLowerCase()}.md`);
  if (existsSync(path)) await rm(path);
}

export async function listNotes(opts = {}, root = dataRoot()) {
  const limit = Math.max(1, Number(opts.limit || 10));
  const offset = Math.max(0, Number(opts.offset || 0));
  const q = String(opts.query || '').toLowerCase();
  const all = (await loadNotes(root)).filter(n => {
    if (opts.label && !n.labels.includes(opts.label)) return false;
    if (opts.machine && n.machine !== opts.machine) return false;
    if (opts.status && n.status !== opts.status) return false;
    if (!opts.status && !opts.includeArchived && n.status === 'archived') return false;
    if (!opts.status && !opts.includeTrash && n.status === 'trash') return false;
    if (q && !(`${n.title} ${n.body} ${n.labels.join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const items = all.slice(offset, offset + limit);
  return { items, limit, offset, total: all.length, hasMore: offset + items.length < all.length, nextOffset: offset + items.length };
}

export async function loadLabelList(root = dataRoot()) {
  const labels = JSON.parse(await readFile(labelsFile(root), 'utf8').catch(() => '{"labels":[]}')).labels || [];
  const fromNotes = (await loadNotes(root)).flatMap(n => n.labels);
  return normalizeLabels([...labels, ...fromNotes]).sort((a, b) => a.localeCompare(b));
}

export async function saveLabelList(labels, root = dataRoot()) {
  const file = labelsFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ labels: normalizeLabels(labels) }, null, 2) + '\n');
}

export async function loadSettings(root = dataRoot()) {
  const raw = await readFile(settingsFile(root), 'utf8').catch(() => '{}');
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  return {
    trashRetentionDays: parsePositiveInt(parsed.trashRetentionDays, DEFAULT_TRASH_RETENTION_DAYS),
  };
}

export async function saveSettings(settings, root = dataRoot()) {
  const file = settingsFile(root);
  await mkdir(dirname(file), { recursive: true });
  const next = {
    trashRetentionDays: parsePositiveInt(settings?.trashRetentionDays, DEFAULT_TRASH_RETENTION_DAYS),
  };
  await writeFile(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function machineFromEntry(entry) {
  const e = objectValue(entry);
  const id = pickString(e, ['id', 'slug', 'machineId', 'name', 'hostname']);
  if (!id) return null;
  const slug = pickString(e, ['slug'], id);
  const friendlyName = pickString(e, ['friendlyName', 'displayName', 'label', 'title']);
  const displayName = friendlyName || pickString(e, ['displayName', 'name'], slug || id);
  const online = parseBoolean(e.online ?? e.isOnline ?? e.reachable);
  const status = pickString(e, ['status', 'state', 'availability'], online === true ? 'online' : (online === false ? 'offline' : 'unknown'));
  const updatedAt = pickTimestamp(e, ['updatedAt', 'lastUpdated', 'modifiedAt']);
  const lastSeenAt = pickTimestamp(e, ['lastSeenAt', 'lastHeartbeatAt', 'heartbeatAt', 'seenAt']);
  const syncedAt = pickTimestamp(e, ['syncedAt', 'lastSyncedAt', 'notesSyncedAt']);
  const recentActivityAt = pickTimestamp(e, ['recentActivityAt', 'lastActivityAt', 'activityAt']);
  return {
    id,
    slug,
    displayName,
    friendlyName,
    sshAddress: pickString(e, ['sshAddress', 'ssh', 'host', 'hostname'], id),
    platform: pickString(e, ['platform', 'os'], 'unknown'),
    status,
    online,
    source: pickString(e, ['source', 'sourceMachine', 'sourceId']),
    origin: pickString(e, ['origin', 'originMachine', 'originId']),
    updatedAt,
    lastSeenAt,
    syncedAt,
    recentActivityAt,
    capabilities: normalizeCapabilities(e.capabilities),
    metadata: objectValue(e.metadata),
    provenance: objectValue(e.provenance),
    sync: objectValue(e.sync),
  };
}

export function parseMachineManifestJSON(raw) {
  let parsed = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    parsed = JSON.parse(String(raw));
  }
  const root = Array.isArray(parsed) ? { machines: parsed } : objectValue(parsed);
  const entries = Array.isArray(root.machines) ? root.machines
    : Array.isArray(root.items) ? root.items
      : Array.isArray(root.data) ? root.data
        : [];
  return entries.map(machineFromEntry).filter(Boolean);
}

async function runMachinesCLI() {
  const candidates = [
    process.env.HASNA_MACHINES_CLI,
    join(homedir(), '.bun', 'bin', 'machines'),
    '/usr/local/bin/machines',
    '/opt/homebrew/bin/machines',
    'machines',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['manifest', 'list', '--json'], { timeout: 2500, maxBuffer: 1024 * 1024 });
      if (stdout && stdout.trim()) return stdout;
    } catch {}
  }
  return null;
}

export async function loadMachineManifest(opts = {}) {
  const manifestPath = opts.manifestPath || opts.manifest || machinesManifestFile();
  const raw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (raw) {
    try {
      const machines = parseMachineManifestJSON(raw);
      if (machines.length) return machines;
    } catch {}
  }
  if (opts.runCLI === false) return [];
  const cliRaw = await runMachinesCLI();
  if (!cliRaw) return [];
  try { return parseMachineManifestJSON(cliRaw); }
  catch { return []; }
}

function machineAliases(machine, idOverride = '') {
  return new Set([idOverride, machine?.id, machine?.slug].filter(Boolean).map(String));
}

function noteCountsForMachine(notes, aliases) {
  const set = aliases instanceof Set ? aliases : new Set([aliases].filter(Boolean).map(String));
  const mine = notes.filter(n => set.has(n.machine));
  const active = mine.filter(n => n.status !== 'archived' && n.status !== 'trash');
  return {
    noteCount: active.length,
    activeNoteCount: active.length,
    archivedNoteCount: mine.filter(n => n.status === 'archived').length,
    trashNoteCount: mine.filter(n => n.status === 'trash').length,
    totalNoteCount: mine.length,
    latestNoteUpdatedAt: maxISO(mine.map(n => n.updatedAt)),
  };
}

function machineDetailFrom(machine, notes, idOverride = '') {
  const id = idOverride || machine?.id || '';
  const aliases = machineAliases(machine, id);
  const counts = noteCountsForMachine(notes, aliases);
  const recentActivityAt = maxISO([
    machine?.recentActivityAt,
    machine?.syncedAt,
    machine?.lastSeenAt,
    machine?.updatedAt,
    counts.latestNoteUpdatedAt,
  ]);
  return {
    id,
    slug: machine?.slug || id,
    displayName: machine?.displayName || machine?.friendlyName || id,
    friendlyName: machine?.friendlyName || '',
    sshAddress: machine?.sshAddress || id,
    platform: machine?.platform || 'unknown',
    status: machine?.status || 'unknown',
    online: machine?.online ?? null,
    source: machine?.source || (machine ? 'open-machines' : 'notes'),
    origin: machine?.origin || '',
    updatedAt: machine?.updatedAt || counts.latestNoteUpdatedAt || '',
    lastSeenAt: machine?.lastSeenAt || '',
    syncedAt: machine?.syncedAt || '',
    recentActivityAt,
    capabilities: machine?.capabilities ?? [],
    metadata: machine?.metadata ?? {},
    provenance: machine?.provenance ?? {},
    sync: machine?.sync ?? {},
    ...counts,
  };
}

export async function listMachineDetails(opts = {}, root = dataRoot()) {
  const notes = await loadNotes(root);
  const byId = new Map();
  const aliasToId = new Map();
  for (const machine of await loadMachineManifest(opts)) {
    const detail = machineDetailFrom(machine, notes);
    byId.set(detail.id, detail);
    for (const alias of machineAliases(machine, detail.id)) aliasToId.set(alias, detail.id);
  }
  for (const note of notes) {
    if (!note.machine || aliasToId.has(note.machine) || byId.has(note.machine)) continue;
    const detail = machineDetailFrom(null, notes, note.machine);
    byId.set(note.machine, detail);
    aliasToId.set(note.machine, note.machine);
  }
  const local = opts.thisMachine || hostnameFallback();
  if (local && !aliasToId.has(local) && !byId.has(local)) byId.set(local, machineDetailFrom(null, notes, local));
  const items = [...byId.values()].sort((a, b) => {
    const d = Date.parse(b.recentActivityAt || b.updatedAt || 0) - Date.parse(a.recentActivityAt || a.updatedAt || 0);
    if (d) return d;
    return String(a.displayName).localeCompare(String(b.displayName));
  });
  return { items, total: items.length };
}

export async function getMachineDetails(id, opts = {}, root = dataRoot()) {
  const machineId = String(id || '').trim();
  if (!machineId) throw new Error('machine_required');
  const page = await listMachineDetails(opts, root);
  return page.items.find(m => m.id === machineId || m.slug === machineId) || machineDetailFrom(null, await loadNotes(root), machineId);
}

function addDays(isoOrDate, days) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate || Date.now());
  return new Date(d.getTime() + days * 86400000).toISOString();
}

async function mutateNote(id, mutate, root = dataRoot()) {
  const note = await getNote(id, root);
  if (!note) throw new Error('note_not_found');
  mutate(note);
  note.updatedAt = new Date().toISOString();
  await saveNote(note, root);
  return note;
}

export async function moveNoteToMachine(id, targetMachine, opts = {}, root = dataRoot()) {
  const target = String(targetMachine || '').trim();
  if (!target) throw new Error('target_machine_required');
  return mutateNote(id, (note) => {
    if (!note.originMachine) note.originMachine = note.machine;
    if (!note.originMachineFriendlyName && note.sourceMachineFriendlyName) {
      note.originMachineFriendlyName = note.sourceMachineFriendlyName;
    }
    note.previousMachine = note.machine;
    note.machine = target;
    note.movedAt = new Date().toISOString();
    if (opts.targetMachineFriendlyName) note.targetMachineFriendlyName = opts.targetMachineFriendlyName;
  }, root);
}

export async function archiveNote(id, root = dataRoot()) {
  return mutateNote(id, (note) => {
    note.status = 'archived';
    note.archivedAt = new Date().toISOString();
    note.trashedAt = '';
    note.trashMachine = '';
    note.trashExpiresAt = '';
  }, root);
}

export async function trashNote(id, opts = {}, root = dataRoot()) {
  const settings = await loadSettings(root);
  const retentionDays = parsePositiveInt(opts.retentionDays, settings.trashRetentionDays);
  return mutateNote(id, (note) => {
    note.status = 'trash';
    note.trashedAt = new Date().toISOString();
    note.trashMachine = opts.trashMachine || note.machine || hostnameFallback();
    note.trashExpiresAt = addDays(note.trashedAt, retentionDays);
  }, root);
}

export async function restoreNote(id, root = dataRoot()) {
  return mutateNote(id, (note) => {
    note.status = 'active';
    note.archivedAt = '';
    note.trashedAt = '';
    note.trashMachine = '';
    note.trashExpiresAt = '';
    note.restoredAt = new Date().toISOString();
  }, root);
}

export async function purgeExpiredTrash(root = dataRoot(), now = new Date()) {
  const purged = [];
  for (const note of await loadNotes(root)) {
    if (note.status !== 'trash' || !note.trashExpiresAt) continue;
    if (Date.parse(note.trashExpiresAt) <= now.getTime()) {
      await deleteNote(note.id, root);
      purged.push(note.id);
    }
  }
  return { purged, count: purged.length };
}

export async function renameLabel(oldName, newName, root = dataRoot()) {
  const labels = (await loadLabelList(root)).map(l => l === oldName ? newName : l);
  await saveLabelList(labels, root);
  for (const note of await loadNotes(root)) {
    if (!note.labels.includes(oldName)) continue;
    note.labels = normalizeLabels(note.labels.map(l => l === oldName ? newName : l));
    note.updatedAt = new Date().toISOString();
    await saveNote(note, root);
  }
}

export async function deleteLabelEverywhere(name, root = dataRoot()) {
  await saveLabelList((await loadLabelList(root)).filter(l => l !== name), root);
  for (const note of await loadNotes(root)) {
    if (!note.labels.includes(name)) continue;
    note.labels = note.labels.filter(l => l !== name);
    note.updatedAt = new Date().toISOString();
    await saveNote(note, root);
  }
}

export async function assignLabel(id, label, root = dataRoot()) {
  const note = (await loadNotes(root)).find(n => n.id.toLowerCase() === String(id).toLowerCase());
  if (!note) throw new Error('note_not_found');
  note.labels = normalizeLabels([...note.labels, label]);
  note.updatedAt = new Date().toISOString();
  await saveNote(note, root);
  await saveLabelList([...(await loadLabelList(root)), label], root);
  return note;
}

export async function unassignLabel(id, label, root = dataRoot()) {
  const note = (await loadNotes(root)).find(n => n.id.toLowerCase() === String(id).toLowerCase());
  if (!note) throw new Error('note_not_found');
  note.labels = note.labels.filter(l => l !== label);
  note.updatedAt = new Date().toISOString();
  await saveNote(note, root);
  return note;
}

export function isDefaultTitle(title) {
  return ['', 'New Note', 'Untitled Note'].includes(String(title || '').trim());
}

export function contentFingerprint(text) {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(String(text || '').slice(0, 4000));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16);
}

export function cleanGeneratedTitle(value) {
  let title = String(value || '').trim();
  title = title.replace(/\s+/g, ' ');
  title = title.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
  title = title.replace(/[.\s]+$/, '').trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 4) title = words.slice(0, 4).join(' ');
  if (/^(untitled|new note|note|summary)$/i.test(title)) return '';
  return title;
}

export function heuristicTitle(text) {
  const readable = markdownPlainText(text);
  const words = readable
    .split(/\s+/)
    .map(w => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(w => w.length > 2 && !/^(the|and|for|with|this|that|from|into|onto|about|there|their|have|will|your)$/i.test(w));
  const title = words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return cleanGeneratedTitle(title) || 'Untitled Note';
}

export async function generateTitle(text, opts = {}) {
  const readable = markdownPlainText(text) || String(text || '').trim();
  if (opts.sidecar) {
    const res = await fetch(String(opts.sidecar).replace(/\/$/, '') + '/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: readable }),
    });
    if (res.ok) {
      const data = await res.json();
      const title = cleanGeneratedTitle(data.title);
      if (title) return { title, provider: 'sidecar' };
    }
  }
  return { title: heuristicTitle(readable), provider: 'heuristic' };
}

export async function getNote(id, root = dataRoot()) {
  const key = String(id || '').toLowerCase();
  return (await loadNotes(root)).find(n => String(n.id).toLowerCase() === key) || null;
}
