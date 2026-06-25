// ===================== Hasna Notes desktop UI — real notes app =====================
//
// This is a REAL notes app rendered from data, in the approved visual
// style. Data arrives one of two ways:
//
//   1. Native macOS host (WKWebView): the Swift shell injects `window.__BOOT__` at
//      document-start (notes + machines + this machine's id) read from the on-disk
//      Markdown store, and later calls `window.HasnaNotes.hydrate(boot)` after any
//      save/create/delete so the UI re-renders from fresh data. Writes are sent back
//      to Swift via `window.webkit.messageHandlers.notes.postMessage({action,note})`.
//
//   2. Plain browser / Playwright: no `__BOOT__`, so we fall back to a small built-in
//      SAMPLE (notes across two machines) and keep the model in memory — writes just
//      mutate the in-memory model + re-render, so the whole UI is testable headless.
//
// No chat/composer/task/diff screens — those are gone. Navigation is hash-free
// for the editor (selection is in-memory); only Settings uses a hash (#settings) so a
// screenshot harness can deep-link to it.
(function () {
  'use strict';

  // ------------------------------------------------------------------ sample data
  // Used ONLY in a plain browser (no native __BOOT__). 4 notes across 2 machines.
  function sampleBoot() {
    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    return {
      thisMachine: 'apple03',
      machines: [
        { id: 'apple03' },
        { id: 'machine001' },
      ],
      notes: [
        {
          id: 's-1', title: 'Welcome to Hasna Notes',
          body: 'Plain-text Markdown notes, synced across your machines.\n\n' +
            'Every note is a file on disk — the source of truth. Edit the title or ' +
            'body and it saves automatically.\n\n' +
            '- New Note (top of the sidebar) starts a fresh note\n' +
            '- Search filters as you type\n' +
            '- Machines lets you see notes across the whole fleet',
          labels: ['welcome', 'docs'], status: 'active', folder: '',
          machine: 'apple03', updatedAt: iso(now - 1000 * 60 * 8),
          createdAt: iso(now - 1000 * 60 * 60 * 26),
        },
        {
          id: 's-2', title: 'Release checklist',
          body: '## Before shipping\n\n1. Run the full test suite\n2. Scan for secrets\n' +
            '3. Bump the patch version\n4. Tag the release\n\nNotes round-trip byte-for-byte.',
          labels: ['release'], status: 'active', folder: '',
          machine: 'apple03', updatedAt: iso(now - 1000 * 60 * 60 * 5),
          createdAt: iso(now - 1000 * 60 * 60 * 50),
        },
        {
          id: 's-3', title: 'Meeting notes — fleet sync',
          body: 'Bidirectional rsync, newest-wins. Each machine ends up with the newest ' +
            'version of every note. Non-mac and unreachable machines are skipped.',
          labels: ['meeting', 'sync'], status: 'reviewed', folder: '',
          machine: 'machine001', updatedAt: iso(now - 1000 * 60 * 60 * 28),
          createdAt: iso(now - 1000 * 60 * 60 * 72),
        },
        {
          id: 's-4', title: 'Ideas',
          body: 'A scratchpad of half-formed thoughts. Markdown all the way down.',
          labels: [], status: 'inbox', folder: '',
          machine: 'machine001', updatedAt: iso(now - 1000 * 60 * 60 * 96),
          createdAt: iso(now - 1000 * 60 * 60 * 120),
        },
      ],
    };
  }

  // ------------------------------------------------------------------ model state
  const ALL = '__all__';
  // Default titles that are eligible for AI auto-titling (Feature 6).
  const DEFAULT_TITLES = ['', 'New Note', 'Untitled Note'];
  const state = {
    notes: [],            // [{id,title,body,labels,status,folder,machine,updatedAt,createdAt}]
    labels: [],           // persisted labels from labels.json; note labels are still source for counts
    machines: [],         // [{id}]
    thisMachine: 'unknown',
    selectedId: null,     // currently-open note id (or null = empty state)
    machineFilter: ALL,   // ALL or a machine id
    labelFilter: ALL,     // ALL or a label name (UI-only forward-compatible filter)
    query: '',            // search text
    screen: 'home',       // 'home' | 'chat' | 'labels' | 'notes' | 'noteslist' | 'settings' | 'compact'
    statusFilter: 'active', // active | archived | trash | all
    noteListLimit: 6,     // sidebar Notes list; "View more" opens the full Notes page
    machineListLimit: 4,  // sidebar Machines list; "View more" opens Settings → Machines
    recentLimit: 3,       // Home recent cards — kept deliberately light (no inline expand)
    settings: { trashRetentionDays: 30 },
    chat: {
      id: 'chat-local',
      status: 'ready',
      messages: [],
      toolCalls: [],
      sources: [],
      pendingConfirmations: [],
      error: '',
      goal: null,
    },
  };

  // Per-note flag: once the user edits a title by hand, never auto-title that note again.
  // Keyed by note id. Lives only in this session (a fresh manual edit re-sets it).
  const titleManuallyEdited = Object.create(null);
  // Per-note auto-title state so we only fire once per default-titled note.
  const autoTitled = Object.create(null);
  const machineDetailWaiters = Object.create(null);

  const native = () =>
    !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.notes);

  // The native `window` message channel (compact-mode control).
  const nativeWindow = () =>
    !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.window);

  // AI sidecar config injected by the host as window.__AI__ = {port, available}.
  // In a plain browser it's absent, so AI features are unavailable (and can be faked
  // for screenshots by setting window.__AI__ before load).
  function ai() {
    const a = window.__AI__ || {};
    return {
      port: a.port || 0,
      available: !!a.available,
      realtime: !!a.realtime,
      realtimeProvider: a.realtimeProvider || 'openai',
      token: a.token || '',
    };
  }
  function aiURL(path) {
    const { port } = ai();
    return 'http://127.0.0.1:' + port + path;
  }
  function aiHeaders(extra) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    const token = ai().token;
    if (token) headers['X-Hasna-Notes-Token'] = token;
    return headers;
  }

  // ------------------------------------------------------------------ dom helpers
  const $ = id => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Relative "updated" label, e.g. "just now", "8m ago", "3h ago", "yesterday", "Jun 3".
  function relTime(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return day + 'd ago';
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Compact relative-age for sidebar note rows: "2h", "Yesterday", "3d", "Jun 3".
  function relTimeShort(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    const day = Math.floor(hr / 24);
    if (day === 1) return 'Yesterday';
    if (day < 7) return day + 'd';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Labels for a note: forward-compatible — prefer `note.labels`, fall back to `note.tags`.
  function noteLabels(n) {
    const raw = (n && Array.isArray(n.labels) && n.labels.length) ? n.labels : (n && n.tags) || [];
    return Array.isArray(raw) ? raw.filter(Boolean).map(String) : [];
  }

  function normalizeLabelList(labels) {
    const seen = Object.create(null);
    const out = [];
    (labels || []).forEach(raw => {
      const label = String(raw || '').trim();
      const key = label.toLowerCase();
      if (!label || seen[key]) return;
      seen[key] = true;
      out.push(label);
    });
    return out;
  }

  function defaultProvenance(machine) {
    const m = machine || state.thisMachine || 'unknown';
    return {
      createdByActorType: 'human',
      createdByName: '',
      sourceMachine: m,
      sourceMachineFriendlyName: '',
      originMachine: m,
      originMachineFriendlyName: '',
      targetMachineFriendlyName: '',
      previousMachine: '',
      openedFrom: '',
      sourceContext: '',
      archivedAt: '',
      trashedAt: '',
      trashMachine: '',
      trashExpiresAt: '',
      restoredAt: '',
      movedAt: '',
    };
  }

  function addDaysISO(iso, days) {
    const d = new Date(iso || Date.now());
    d.setDate(d.getDate() + Math.max(1, Number(days || 30)));
    return d.toISOString();
  }

  const MARKDOWN_COMMANDS = [
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

  const CHAT_TOOL_SCHEMAS = [
    chatTool('list_notes', 'List latest notes with filters and pagination.', true, false),
    chatTool('search_notes', 'Search note titles, labels, and Markdown body text.', true, false),
    chatTool('read_note', 'Read one note by id.', true, false),
    chatTool('note_info', 'Read friendly note provenance and metadata by id.', true, false),
    chatTool('create_note', 'Create a new note with agent provenance.', false, false),
    chatTool('update_note', 'Replace title and/or body for one note.', false, true),
    chatTool('append_note', 'Append Markdown text to one note.', false, true),
    chatTool('label_note', 'Assign one label to one note.', false, false),
    chatTool('unlabel_note', 'Remove one label from one note.', false, false),
    chatTool('archive_note', 'Archive one note.', false, true),
    chatTool('trash_note', 'Move one note to Trash.', false, true),
    chatTool('restore_note', 'Restore one note.', false, true),
    chatTool('summarize_notes', 'Summarize selected, searched, or all visible notes.', true, false),
    chatTool('find_related_notes', 'Find notes related to a note id or query.', true, false),
    chatTool('consolidate_notes', 'Preview or create a larger consolidated note from several notes.', false, true),
  ];

  function chatTool(name, description, readOnly, requiresConfirmation) {
    return {
      name,
      description,
      safety: { readOnly: !!readOnly, mutates: !readOnly, requiresConfirmation: !!requiresConfirmation },
    };
  }

  function markdownSafeText(text) {
    return String(text || '').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+\-.!>|])/g, '\\$1');
  }

  // Spoken transcripts are plain prose, NOT markdown the user typed — they must be
  // stored verbatim. Running them through markdownSafeText() inserted stray backslashes
  // before ordinary punctuation ("3.5" → "3\.5", "well-being" → "well\-being",
  // "(note)" → "\(note\)"), which is the transcription-backslash bug. Normalize CRLF
  // and trim the ends, but otherwise preserve the text and its line breaks byte-for-byte.
  function transcriptToNoteBody(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  function escapeHTML(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripMarkdownEscapes(text) {
    return String(text || '').replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, '$1');
  }

  function safeMarkdownURL(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '';
    if (raw.startsWith('//')) return '';
    if (/^(https?:|mailto:)/i.test(raw)) return raw;
    if (/^(\/(?!\/)|[?#]|\.\.?\/)/.test(raw)) return raw;
    return '';
  }

  function markdownPlainText(markdown) {
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
      const token = '\u0000' + placeholders.length + '\u0000';
      placeholders.push(html);
      return token;
    };
    const restore = value => {
      let out = value;
      for (let pass = 0; pass <= placeholders.length; pass += 1) {
        const before = out;
        placeholders.forEach((html, i) => { out = out.replaceAll('\u0000' + i + '\u0000', html); });
        if (out === before) break;
      }
      return out;
    };
    let out = String(text || '').replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, (_, ch) => hold(escapeHTML(ch)));
    out = out.replace(/`([^`]+)`/g, (_, code) => hold('<code>' + escapeHTML(code) + '</code>'));
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, label) => hold(escapeHTML(label)));
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safe = safeMarkdownURL(href);
      return safe ? hold('<a href="' + escapeHTML(safe) + '" rel="nofollow noopener noreferrer">' + escapeHTML(label) + '</a>') : hold(escapeHTML(label));
    });
    out = escapeHTML(out);
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return restore(out);
  }

  function renderMarkdownSafe(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let paragraph = [], list = null, inCode = false, code = [], quote = [];
    const closeParagraph = () => { if (paragraph.length) { html.push('<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>'); paragraph = []; } };
    const closeList = () => { if (list) { html.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } };
    const closeQuote = () => { if (quote.length) { html.push('<blockquote>' + quote.map(renderInlineMarkdown).join('<br>') + '</blockquote>'); quote = []; } };
    const closeBlocks = () => { closeParagraph(); closeList(); closeQuote(); };
    lines.forEach(line => {
      if (/^\s*```/.test(line)) {
        if (inCode) { html.push('<pre><code>' + escapeHTML(code.join('\n')) + '</code></pre>'); inCode = false; code = []; }
        else { closeBlocks(); inCode = true; }
        return;
      }
      if (inCode) { code.push(line); return; }
      if (!line.trim()) { closeBlocks(); return; }
      if (/^\s*---+\s*$/.test(line)) { closeBlocks(); html.push('<hr>'); return; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { closeBlocks(); html.push('<h' + heading[1].length + '>' + renderInlineMarkdown(heading[2]) + '</h' + heading[1].length + '>'); return; }
      const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (quoted) { closeParagraph(); closeList(); quote.push(quoted[1]); return; }
      const checklist = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
      if (checklist) {
        closeParagraph(); closeQuote();
        if (!list || list.type !== 'ul') { closeList(); list = { type: 'ul', items: [] }; }
        list.items.push('<li><input type="checkbox" disabled' + (checklist[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' + renderInlineMarkdown(checklist[2]) + '</li>');
        return;
      }
      const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (bullet) { closeParagraph(); closeQuote(); if (!list || list.type !== 'ul') { closeList(); list = { type: 'ul', items: [] }; } list.items.push('<li>' + renderInlineMarkdown(bullet[1]) + '</li>'); return; }
      const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (numbered) { closeParagraph(); closeQuote(); if (!list || list.type !== 'ol') { closeList(); list = { type: 'ol', items: [] }; } list.items.push('<li>' + renderInlineMarkdown(numbered[1]) + '</li>'); return; }
      closeList(); closeQuote(); paragraph.push(line.trim());
    });
    if (inCode) html.push('<pre><code>' + escapeHTML(code.join('\n')) + '</code></pre>');
    closeBlocks();
    return html.join('\n');
  }

  function selectedMarkdownRange(text, start, end) {
    const length = String(text || '').length;
    const s = Math.max(0, Math.min(length, Number(start == null ? length : start)));
    const e = Math.max(0, Math.min(length, Number(end == null ? s : end)));
    return [Math.min(s, e), Math.max(s, e)];
  }

  function markdownLineRange(text, start, end) {
    const before = text.lastIndexOf('\n', Math.max(0, start - 1));
    const lineStart = before < 0 ? 0 : before + 1;
    const after = text.indexOf('\n', end);
    const lineEnd = after < 0 ? text.length : after;
    return [lineStart, lineEnd];
  }

  function stripMarkdownBlockPrefix(line) {
    return line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '');
  }

  function markdownReplaceRange(text, start, end, value, selectionStart, selectionEnd) {
    return {
      markdown: text.slice(0, start) + value + text.slice(end),
      selectionStart,
      selectionEnd,
    };
  }

  function applyMarkdownCommand(markdown, input) {
    const text = String(markdown || '');
    const options = input || {};
    const commandId = String(options.commandId || options.id || '');
    let range = selectedMarkdownRange(text, options.selectionStart, options.selectionEnd);
    const start = range[0], end = range[1];
    const selected = text.slice(start, end);
    const fallback = selected || 'text';
    const wrapInline = (prefix, suffix) => {
      suffix = suffix == null ? prefix : suffix;
      const next = prefix + fallback + suffix;
      return markdownReplaceRange(text, start, end, next, start + prefix.length, start + prefix.length + fallback.length);
    };

    if (commandId === 'bold') return wrapInline('**');
    if (commandId === 'italic') return wrapInline('*');
    if (commandId === 'code') return wrapInline('`');
    if (commandId === 'link') {
      const label = markdownSafeText(selected || options.label || 'link');
      const href = safeMarkdownURL(options.href || options.url || '') || 'https://';
      const next = '[' + label + '](' + href + ')';
      return markdownReplaceRange(text, start, end, next, start + 1, start + 1 + String(label).length);
    }
    if (commandId === 'code-block') {
      const language = String(options.language || '').replace(/[`\s]/g, '');
      const body = selected || '';
      const next = '```' + language + '\n' + body + '\n```';
      return markdownReplaceRange(text, start, end, next, start + 4 + language.length, start + 4 + language.length + body.length);
    }
    if (commandId === 'divider') {
      const prefix = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
      const suffix = end < text.length && text[end] !== '\n' ? '\n' : '';
      const next = prefix + '---' + suffix;
      return markdownReplaceRange(text, start, end, next, start + next.length, start + next.length);
    }

    const lr = markdownLineRange(text, start, end);
    const transformed = text.slice(lr[0], lr[1]).split('\n').map((line, index) => {
      const content = stripMarkdownBlockPrefix(line);
      if (commandId === 'h1') return '# ' + content;
      if (commandId === 'h2') return '## ' + content;
      if (commandId === 'h3') return '### ' + content;
      if (commandId === 'paragraph') return content;
      if (commandId === 'bullet-list') return '- ' + content;
      if (commandId === 'numbered-list') return (index + 1) + '. ' + content;
      if (commandId === 'quote') return '> ' + content;
      if (commandId === 'checklist') return '- [ ] ' + content;
      return line;
    }).join('\n');
    return markdownReplaceRange(text, lr[0], lr[1], transformed, lr[0], lr[0] + transformed.length);
  }

  // The distinct label set across all notes, with counts, sorted by name.
  function allLabels() {
    const counts = Object.create(null);
    state.labels.forEach(label => { counts[label] = counts[label] || 0; });
    state.notes.forEach(n => { noteLabels(n).forEach(l => { counts[l] = (counts[l] || 0) + 1; }); });
    return Object.keys(counts).sort((a, b) => a.localeCompare(b)).map(name => ({ name: name, count: counts[name] }));
  }

  // ------------------------------------------------------------------ data model ops
  function sortNotes(list) {
    return list.slice().sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

	  // Notes after machine-filter + label-filter + search, newest first. The list the user sees.
	  function visibleNotes() {
	    const q = state.query.trim().toLowerCase();
	    return sortNotes(state.notes.filter(n => {
	      if (state.machineFilter !== ALL && !noteMatchesMachine(n, state.machineFilter)) return false;
	      if (state.labelFilter !== ALL && noteLabels(n).indexOf(state.labelFilter) < 0) return false;
      if (state.statusFilter === 'active' && (n.status === 'archived' || n.status === 'trash')) return false;
      if (state.statusFilter === 'archived' && n.status !== 'archived') return false;
      if (state.statusFilter === 'trash' && n.status !== 'trash') return false;
      if (q) {
        const hay = ((n.title || '') + ' ' + (n.body || '') + ' ' + noteLabels(n).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }));
  }

  function visibleNotesPage() {
    const list = visibleNotes();
    return {
      items: list.slice(0, state.noteListLimit),
      total: list.length,
      limit: state.noteListLimit,
      hasMore: list.length > state.noteListLimit,
    };
  }

	  function noteById(id) { return state.notes.find(n => n.id === id) || null; }

	  function noteMatchesMachine(note, machineId) {
	    if (!note || machineId === ALL) return true;
	    return machineAliases(machineId).has(note.machine);
	  }

  function machineCount(id) {
    return state.notes.filter(n => noteMatchesMachine(n, id) && n.status !== 'trash' && n.status !== 'archived').length;
  }

  function latestISO(values) {
    let latest = '';
    values.forEach(value => {
      const time = Date.parse(value || 0);
      if (!Number.isNaN(time) && (!latest || time > Date.parse(latest))) latest = new Date(time).toISOString();
    });
    return latest;
  }

	  function machineAliases(machineOrId) {
	    const m = typeof machineOrId === 'string' ? machineById(machineOrId) : machineOrId;
	    return new Set([
	      typeof machineOrId === 'string' ? machineOrId : '',
	      m && m.id,
	      m && m.slug,
	      m && m.friendlyName,
	      m && m.displayName,
	    ].filter(Boolean).map(String));
	  }

  function machineNoteCounts(machineOrId) {
    const aliases = machineAliases(machineOrId);
    const notes = state.notes.filter(n => aliases.has(n.machine));
    const active = notes.filter(n => n.status !== 'trash' && n.status !== 'archived');
    return {
      noteCount: active.length,
      activeNoteCount: active.length,
      archivedNoteCount: notes.filter(n => n.status === 'archived').length,
      trashNoteCount: notes.filter(n => n.status === 'trash').length,
      totalNoteCount: notes.length,
      latestNoteUpdatedAt: latestISO(notes.map(n => n.updatedAt)),
    };
  }

	  function machineById(id) {
	    const needle = String(id || '');
	    return state.machines.find(m =>
	      m.id === needle ||
	      m.slug === needle ||
	      m.friendlyName === needle ||
	      m.displayName === needle
	    ) || null;
	  }

  function machineDetails(id) {
    const machineId = String(id || '').trim();
    const source = machineById(machineId) || { id: machineId, slug: machineId, displayName: machineId, source: 'notes' };
    const counts = machineNoteCounts(source);
    const recentActivityAt = latestISO([
      source.recentActivityAt,
      source.syncedAt,
      source.lastSeenAt,
      source.updatedAt,
      counts.latestNoteUpdatedAt,
    ]);
    return Object.assign({}, source, counts, {
      id: source.id || machineId,
      slug: source.slug || source.id || machineId,
      displayName: source.displayName || source.friendlyName || source.id || machineId,
      friendlyName: source.friendlyName || '',
      status: source.status || (source.online === true ? 'online' : (source.online === false ? 'offline' : 'unknown')),
      online: source.online == null ? null : !!source.online,
      source: source.source || 'notes',
      origin: source.origin || '',
      recentActivityAt,
      capabilities: source.capabilities || [],
      metadata: source.metadata || {},
      provenance: source.provenance || {},
      sync: source.sync || {},
    });
  }

  function machineDetailsList() {
    const ids = new Set(state.machines.map(m => m.id).filter(Boolean));
    state.notes.forEach(n => {
      if (!n.machine) return;
      const existing = machineById(n.machine);
      ids.add(existing ? existing.id : n.machine);
    });
    if (state.thisMachine) ids.add(machineDetails(state.thisMachine).id);
    return [...ids].map(machineDetails).sort((a, b) => {
      const d = Date.parse(b.recentActivityAt || b.updatedAt || 0) - Date.parse(a.recentActivityAt || a.updatedAt || 0);
      if (d) return d;
      return String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  function requestMachineDetails(id) {
    const fallback = machineDetails(id);
    const requestId = 'machine-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const promise = new Promise(resolve => {
      machineDetailWaiters[requestId] = resolve;
      setTimeout(() => {
        if (!machineDetailWaiters[requestId]) return;
        delete machineDetailWaiters[requestId];
        resolve(fallback);
      }, 1500);
    });
    window.dispatchEvent(new CustomEvent('hasna:machine-details-request', { detail: { requestId, machineId: fallback.id, machine: fallback } }));
    if (native()) {
      try { window.webkit.messageHandlers.notes.postMessage({ action: 'machineDetails', machine: fallback.id, requestId }); }
      catch (e) { /* host gone */ }
    } else {
      setTimeout(() => receiveMachineDetails({ requestId, machine: fallback }), 0);
    }
    return promise;
  }

	  function receiveMachineDetails(payload) {
    const p = payload || {};
    const detail = normalizeMachine(p.machine || p);
    const incomingAliases = machineAliases(detail);
    const idx = state.machines.findIndex(m => {
      const aliases = machineAliases(m);
      return [...incomingAliases].some(alias => aliases.has(alias));
    });
    if (idx >= 0) state.machines[idx] = Object.assign({}, state.machines[idx], detail);
    else if (detail.id) state.machines.push(detail);
    const resolved = machineDetails(detail.id);
    let canonicalizedSelection = false;
    const resolvedAliases = machineAliases(resolved);
    if (state.machineFilter !== ALL && resolvedAliases.has(state.machineFilter) && state.machineFilter !== resolved.id) {
      state.machineFilter = resolved.id;
      const selected = noteById(state.selectedId);
      if (!selected || !noteMatchesMachine(selected, resolved.id)) {
        const v = visibleNotes();
        state.selectedId = v.length ? v[0].id : null;
      }
      canonicalizedSelection = true;
    }
    window.dispatchEvent(new CustomEvent('hasna:machine-details', { detail: { requestId: p.requestId || '', machineId: resolved.id, machine: resolved } }));
    if (canonicalizedSelection) {
      window.dispatchEvent(new CustomEvent('hasna:machine-select', {
        detail: {
          machineId: resolved.id,
          machine: resolved,
          selectedNoteId: state.selectedId,
          reason: 'details',
          view: viewSnapshot(),
        },
      }));
    }
    const waiter = p.requestId && machineDetailWaiters[p.requestId];
    if (waiter) {
      delete machineDetailWaiters[p.requestId];
      waiter(resolved);
    }
	    if (canonicalizedSelection) render();
	    else renderMachines();
	    return resolved;
	  }

	  function clearSearchInput() {
	    state.query = '';
	    const si = $('search-input');
	    if (si) si.value = '';
	  }

	  function selectMachine(machineId, opts) {
	    const options = opts || {};
	    commitEdit();
	    const isAll = machineId === ALL;
	    const detail = isAll ? null : machineDetails(machineId);
	    const target = isAll ? ALL : (detail.id || String(machineId || '').trim());
	    if (!isAll && !target) return null;

	    state.machineFilter = target;
	    state.statusFilter = options.statusFilter || 'active';
	    state.labelFilter = ALL;
	    clearSearchInput();
	    state.noteListLimit = 10;
	    state.screen = 'notes';
	    showApp();

	    const preferred = options.noteId ? noteById(options.noteId) : null;
	    if (preferred && (isAll || noteMatchesMachine(preferred, target))) {
	      state.selectedId = preferred.id;
	    } else {
	      const v = visibleNotes();
	      state.selectedId = v.length ? v[0].id : null;
	    }

	    const selectedMachine = isAll ? null : machineDetails(target);
	    window.dispatchEvent(new CustomEvent('hasna:machine-select', {
	      detail: {
	        machineId: target,
	        machine: selectedMachine,
	        selectedNoteId: state.selectedId,
	        reason: options.reason || 'sidebar',
	        view: viewSnapshot(),
	      },
	    }));
	    if (!isAll) requestMachineDetails(target);
	    render();
	    return selectedMachine;
	  }

	  // ------------------------------------------------------------------ persistence bridge
  // Send a write to the native host (or, in-browser, just keep the in-memory model).
  function postNative(action, note, extra) {
    if (native()) {
      try { window.webkit.messageHandlers.notes.postMessage(Object.assign({ action: action, note: note }, extra || {})); }
      catch (e) { /* host gone — ignore */ }
    }
  }

  // Send a native window-control message (compact mode). No-op in a plain browser.
  function postWindow(action, extra) {
    if (nativeWindow()) {
      try { window.webkit.messageHandlers.window.postMessage(Object.assign({ action: action }, extra || {})); }
      catch (e) { /* host gone — ignore */ }
    }
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    // force reflow so the transition runs even on rapid repeats
    void t.offsetWidth;
    t.classList.add('toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('toast-show');
      // hide after the fade-out finishes
      setTimeout(() => { if (!t.classList.contains('toast-show')) t.hidden = true; }, 220);
    }, 1900);
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    renderLabels();
    renderNotesList();
    renderMachines();
    renderContent();
    renderSettingsMeta();
    renderHome();
    renderNavActive();
  }

  // Labels filter group near the top of the sidebar: "All" + one row per distinct label
  // (name + count). Selecting a label filters the notes list. Hidden entirely when there
  // are no labels anywhere, to keep the sidebar compact.
  function renderLabels() {
    const host = $('labels-list');
    const section = $('labels-section');
    if (!host) return;
    host.innerHTML = '';
    const labels = allLabels();
    if (labels.length === 0) {
      if (section) section.hidden = true;
      // If a label filter was active but its label vanished, reset to All.
      if (state.labelFilter !== ALL) state.labelFilter = ALL;
      return;
    }
    if (section) section.hidden = false;

    host.appendChild(labelRow(ALL, 'All', state.notes.length));
    labels.forEach(l => host.appendChild(labelRow(l.name, l.name, l.count)));
  }

  function labelRow(id, label, count) {
    const row = el('div', 'label-row');
    row.dataset.label = id;
    if (state.labelFilter === id) row.classList.add('active');
    const left = el('div', 'lr-left');
    const ico = document.createElement('span');
    ico.className = 'lr-ico';
    ico.innerHTML = (id === ALL)
      ? '<svg viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M3 8h10M3 11.5h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none"><path d="M7.5 2.5H12a1.5 1.5 0 011.5 1.5v4.5L8 14 2 8l5.5-5.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9.8" cy="6.2" r="1" fill="currentColor"/></svg>';
    left.appendChild(ico);
    left.appendChild(el('span', 'lr-name', label));
    row.appendChild(left);
    row.appendChild(el('span', 'lr-count', String(count)));
    row.addEventListener('click', () => {
      state.labelFilter = id;
      state.noteListLimit = 10;
      // If the open note is filtered out, drop selection to newest visible.
      const sel = noteById(state.selectedId);
      if (sel && state.labelFilter !== ALL && noteLabels(sel).indexOf(state.labelFilter) < 0) {
        const v = visibleNotes();
        state.selectedId = v.length ? v[0].id : null;
      }
      render();
    });
    return row;
  }

  // Reflect the active sidebar item (Home vs a note selection).
  function renderNavActive() {
    const home = $('nav-home');
    if (home) home.classList.toggle('active', state.screen === 'home');
    const chat = $('nav-chat');
    if (chat) chat.classList.toggle('active', state.screen === 'chat');
    const labels = $('nav-labels');
    if (labels) labels.classList.toggle('active', state.screen === 'labels');
  }

  // Decide which content panel is visible: Home, Chat, Labels, the full Notes page, or the editor.
  function renderContent() {
    const home = $('home-state');
    const np = $('notes-page');
    const chat = $('chat-page');
    const labels = $('labels-page-main');
    const ed = $('editor'), empty = $('empty-state'), nomatch = $('nomatch-state');
    const hideEditorStates = () => {
      if (ed) ed.hidden = true;
      if (empty) empty.hidden = true;
      if (nomatch) nomatch.hidden = true;
    };
    if (state.screen === 'home') {
      if (home) home.hidden = false;
      if (np) np.hidden = true;
      if (chat) chat.hidden = true;
      if (labels) labels.hidden = true;
      hideEditorStates();
      return;
    }
    if (state.screen === 'chat') {
      if (home) home.hidden = true;
      if (np) np.hidden = true;
      if (chat) chat.hidden = false;
      if (labels) labels.hidden = true;
      hideEditorStates();
      renderChatPage();
      return;
    }
    if (state.screen === 'labels') {
      if (home) home.hidden = true;
      if (np) np.hidden = true;
      if (chat) chat.hidden = true;
      if (labels) labels.hidden = false;
      hideEditorStates();
      renderLabelsPage();
      return;
    }
    if (state.screen === 'noteslist') {
      if (home) home.hidden = true;
      if (np) np.hidden = false;
      if (chat) chat.hidden = true;
      if (labels) labels.hidden = true;
      hideEditorStates();
      renderNotesPage();
      return;
    }
    if (home) home.hidden = true;
    if (np) np.hidden = true;
    if (chat) chat.hidden = true;
    if (labels) labels.hidden = true;
    renderEditor();
  }

  // Home: recent-notes cards. Quick-note + record wiring is in bind().
  function renderHome() {
    const wrap = $('home-recent');
    const host = $('home-cards');
    if (!wrap || !host) return;
    const allRecent = sortNotes(state.notes.filter(n => n.status !== 'trash' && n.status !== 'archived'));
    const recent = allRecent.slice(0, state.recentLimit);
    host.innerHTML = '';
    // "All notes" affordance: only worth showing once there are more than the recent few.
    const allBtn = $('home-all-notes');
    if (allBtn) allBtn.hidden = allRecent.length <= state.recentLimit;
    if (recent.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    recent.forEach(n => {
      const card = el('div', 'home-card');
      const body = n.body || n.content || '';
      card.dataset.noteId = n.id;
      card.dataset.copyText = body;
      card.appendChild(el('div', 'home-card-title', (n.title && n.title.trim()) || 'Untitled Note'));
      const sub = body.replace(/\s+/g, ' ').trim().slice(0, 72) || 'No content';
      card.appendChild(el('div', 'home-card-sub', sub));
      // Relative time on its own third row so it never crowds the preview text.
      card.appendChild(el('div', 'home-card-meta', relTime(n.updatedAt)));

      // Hover copy button (top-right, absolute → no layout shift) + inline "Copied" tag.
      const copied = el('span', 'home-card-copied', 'Copied');
      const copyBtn = el('button', 'home-card-copy');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy note';
      copyBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.5h-.5a1 1 0 01-1-1V3a1 1 0 011-1h6.5a1 1 0 011 1v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // copy without opening the note
        copyToClipboard(body);
        copied.classList.add('show');
        copyBtn.classList.add('copied');
        setTimeout(() => { copied.classList.remove('show'); copyBtn.classList.remove('copied'); }, 1100);
      });
      card.appendChild(copied);
      card.appendChild(copyBtn);

      card.addEventListener('click', () => selectNote(n.id));
      host.appendChild(card);
    });
  }

  // Friendly, abbreviated relative time for note rows/cards ("Just now", "3m", "2h",
  // "Yesterday", "4d", or a short date). Trimmed so it never crowds a row.
  function noteRowTime(iso) {
    return relTimeShort(iso) || '';
  }

  // ------------------------------------------------------------------ Notes page
  // The dedicated full-list page reached from the sidebar "View more" / Home "All notes".
  function showNotesPage() {
    commitEdit();
    state.screen = 'noteslist';
    showApp();
    render();
  }

  function showChatPage() {
    commitEdit();
    state.screen = 'chat';
    showApp();
    render();
    const input = $('chat-input'); if (input) input.focus();
  }

  function showLabelsPage() {
    commitEdit();
    state.screen = 'labels';
    showApp();
    render();
    const input = $('label-create-input'); if (input) input.focus();
  }

  function renderNotesPage() {
    const host = $('np-list');
    const countEl = $('np-count');
    const emptyEl = $('np-empty');
    if (!host) return;
    host.innerHTML = '';
    const list = sortNotes(state.notes.filter(n => n.status !== 'trash' && n.status !== 'archived'));
    if (countEl) countEl.textContent = list.length === 1 ? '1 note' : list.length + ' notes';
    if (emptyEl) emptyEl.hidden = list.length !== 0;
    list.forEach(n => {
      const row = el('div', 'np-row');
      row.dataset.id = n.id;
      const body = (n.body || n.content || '').replace(/\s+/g, ' ').trim();
      row.appendChild(el('div', 'np-row-title', (n.title && n.title.trim()) || 'Untitled Note'));
      row.appendChild(el('div', 'np-row-sub', body.slice(0, 120) || 'No content'));
      // Third row: machine + friendly relative time, kept compact and muted.
      const meta = el('div', 'np-row-meta');
      const machine = (n.sourceMachineFriendlyName || n.machine || '').trim();
      if (machine && machine !== 'unknown') meta.appendChild(el('span', 'np-row-machine', machine));
      const age = relTime(n.updatedAt);
      if (age) meta.appendChild(el('span', 'np-row-age', age));
      row.appendChild(meta);
      row.addEventListener('click', () => selectNote(n.id));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(e, n.id); });
      host.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ Machines page
  // The fuller machines list lives under Settings → Machines (kept off the Home page).
  function renderMachinesPage() {
    const host = $('machines-page');
    const emptyEl = $('machines-page-empty');
    if (!host) return;
    host.innerHTML = '';
    const machines = machineDetailsList();
    if (emptyEl) emptyEl.hidden = machines.length !== 0;
    machines.forEach(m => {
      const card = el('div', 'mp-row');
      const left = el('div', 'mp-left');
      const name = (m.displayName || m.id || 'Unknown machine').trim();
      left.appendChild(el('div', 'mp-name', name));
      const sub = [];
      if (m.platform) sub.push(m.platform);
      const seen = m.recentActivityAt || m.latestNoteUpdatedAt || m.updatedAt;
      if (seen) sub.push('Active ' + relTime(seen));
      left.appendChild(el('div', 'mp-sub', sub.join(' · ') || 'No recent activity'));
      card.appendChild(left);
      const count = Number(m.noteCount || 0);
      card.appendChild(el('span', 'mp-count', count === 1 ? '1 note' : count + ' notes'));
      // Clicking a machine filters the sidebar list to it and returns to the app.
      card.addEventListener('click', () => { selectMachine(m.id, { reason: 'settings' }); showApp(); });
      host.appendChild(card);
    });
  }

  // ------------------------------------------------------------------ Labels page
  function persistLabels() {
    state.labels = normalizeLabelList(state.labels);
    postNative('labels', { labels: state.labels });
  }

  function rememberLabels(labels) {
    state.labels = normalizeLabelList([].concat(state.labels || [], labels || []));
  }

  function createLabelLocal(name) {
    const label = String(name || '').trim();
    if (!label) return null;
    rememberLabels([label]);
    persistLabels();
    render();
    return label;
  }

  function renameLabelLocal(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to) return null;
    state.labels = normalizeLabelList(state.labels.map(label => label.toLowerCase() === from.toLowerCase() ? to : label).concat([to]));
    state.notes.forEach(note => {
      const next = normalizeLabelList(noteLabels(note).map(label => label.toLowerCase() === from.toLowerCase() ? to : label));
      if (next.join('\n') !== noteLabels(note).join('\n')) {
        note.labels = next;
        note.updatedAt = new Date().toISOString();
        postNative('save', serializeNote(note));
      }
    });
    if (state.labelFilter.toLowerCase && state.labelFilter.toLowerCase() === from.toLowerCase()) state.labelFilter = to;
    persistLabels();
    render();
    return to;
  }

  function deleteLabelLocal(name, confirmed) {
    const label = String(name || '').trim();
    if (!label) return null;
    const affected = state.notes.filter(note => noteLabels(note).some(item => item.toLowerCase() === label.toLowerCase()));
    if (!confirmed && affected.length && !window.confirm('Delete label "' + label + '" from ' + affected.length + ' note(s)?')) return null;
    state.labels = state.labels.filter(item => item.toLowerCase() !== label.toLowerCase());
    affected.forEach(note => {
      note.labels = noteLabels(note).filter(item => item.toLowerCase() !== label.toLowerCase());
      note.updatedAt = new Date().toISOString();
      postNative('save', serializeNote(note));
    });
    if (state.labelFilter.toLowerCase && state.labelFilter.toLowerCase() === label.toLowerCase()) state.labelFilter = ALL;
    persistLabels();
    render();
    return { label, affected: affected.length };
  }

  function renderLabelsPage() {
    const host = $('labels-page-list');
    const countEl = $('labels-count');
    const emptyEl = $('labels-page-empty');
    if (!host) return;
    const labels = allLabels();
    host.innerHTML = '';
    if (countEl) countEl.textContent = labels.length === 1 ? '1 label' : labels.length + ' labels';
    if (emptyEl) emptyEl.hidden = labels.length !== 0;
    labels.forEach(item => {
      const row = el('div', 'lp-row');
      row.dataset.label = item.name;
      const left = el('button', 'lp-main');
      left.type = 'button';
      left.title = 'Filter notes';
      left.innerHTML = '<span class="lp-tag-ico"><svg viewBox="0 0 16 16" fill="none"><path d="M6.8 2.4h4.4a1.4 1.4 0 011.4 1.4v4.4L8 13 3 8l3.8-5.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10.1" cy="5.5" r=".8" fill="currentColor"/></svg></span>';
      left.appendChild(el('span', 'lp-name', item.name));
      left.appendChild(el('span', 'lp-count', item.count === 1 ? '1 note' : item.count + ' notes'));
      left.addEventListener('click', () => {
        state.labelFilter = item.name;
        showNotesPage();
      });
      row.appendChild(left);
      const actions = el('div', 'lp-actions');
      const edit = el('button', 'lp-icon');
      edit.type = 'button';
      edit.title = 'Rename label';
      edit.innerHTML = '<svg viewBox="0 0 18 18" fill="none"><path d="M4 13.5V15h1.5l7.8-7.8-1.5-1.5L4 13.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M12.4 4.8l1.8 1.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      edit.addEventListener('click', () => {
        const next = window.prompt('Rename label', item.name);
        if (next && next.trim() && next.trim() !== item.name) renameLabelLocal(item.name, next.trim());
      });
      const del = el('button', 'lp-icon lp-danger');
      del.type = 'button';
      del.title = 'Delete label';
      del.innerHTML = '<svg viewBox="0 0 18 18" fill="none"><path d="M4 5.5h10M7.5 5.5V4.2a1 1 0 011-1h1a1 1 0 011 1v1.3M5.5 5.5l.6 8a1 1 0 001 .94h3.8a1 1 0 001-.94l.6-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      del.addEventListener('click', () => deleteLabelLocal(item.name, false));
      actions.appendChild(edit);
      actions.appendChild(del);
      row.appendChild(actions);
      host.appendChild(row);
    });
  }

  // Clipboard write with a textarea fallback (file:// / older WebKit). No toast — the
  // home-card shows its own inline "Copied" confirmation.
  function copyToClipboard(text) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      } catch (e) { /* ignore */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else { fallback(); }
  }

  function renderNotesList() {
    const host = $('notes-list');
    const emptySide = $('notes-empty-side');
    if (!host) return;
    host.innerHTML = '';
    const page = visibleNotesPage();
    const list = page.items;

    if (list.length === 0) {
      if (emptySide) {
        emptySide.hidden = false;
        emptySide.textContent = state.query.trim()
          ? 'No matching notes'
          : (state.machineFilter === ALL ? 'No notes' : 'No notes on this machine');
      }
      return;
    }
    if (emptySide) emptySide.hidden = true;

    list.forEach(n => {
      const row = el('div', 'note-row');
      row.dataset.id = n.id;
      if (n.id === state.selectedId && state.screen === 'notes') row.classList.add('active');
      const title = el('span', 'note-title', (n.title && n.title.trim()) ? n.title : 'Untitled Note');
      if (!(n.title && n.title.trim())) title.classList.add('untitled');
      row.appendChild(title);
      // Subtle right-aligned relative-age tag ("2h", "Yesterday", "3d"). Never wraps.
      const age = relTimeShort(n.updatedAt);
      if (age) {
        const ageEl = el('span', 'note-age', age);
        ageEl.title = relTime(n.updatedAt);
        row.appendChild(ageEl);
      }
      row.addEventListener('click', () => selectNote(n.id));
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/x-hasna-note-id', n.id);
        ev.dataTransfer.setData('text/plain', n.id);
        ev.dataTransfer.effectAllowed = 'move';
      });
      // Right-click → context menu (Rename / Duplicate / Copy text / Delete).
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(e, n.id); });
      host.appendChild(row);
    });
    if (page.hasMore) {
      const more = el('button', 'view-more', 'View more');
      more.type = 'button';
      // Navigate to the dedicated Notes page rather than expanding the sidebar inline.
      more.addEventListener('click', showNotesPage);
      host.appendChild(more);
    }
  }

  function renderMachines() {
    const host = $('machines-list');
    if (!host) return;
    host.innerHTML = '';

    // "All Machines" row first.
    host.appendChild(machineRow(ALL, 'All Machines', state.notes.filter(n => n.status !== 'trash' && n.status !== 'archived').length, true));

    // One row per machine. Union of manifest machines + machines seen in notes, so a
    // note from a machine missing from the manifest still gets a row.
    const machines = machineDisplays();
    machines.slice(0, state.machineListLimit).forEach(m => host.appendChild(machineRow(m.id, m.displayName, m.noteCount, false, m)));
    const more = $('machines-more');
    if (more) more.hidden = machines.length <= state.machineListLimit;
  }

  function machineDisplays() {
    return machineDetailsList();
  }

  function machineRow(id, label, count, isAll, machine) {
    const row = el('div', 'machine-row');
    row.dataset.machine = id;
    if (machine && machine.updatedAt) row.dataset.updatedAt = machine.updatedAt;
    if (machine && machine.status) row.dataset.status = machine.status;
    if (machine && machine.online != null) row.dataset.online = String(!!machine.online);
    if (machine && machine.friendlyName) row.dataset.friendlyName = machine.friendlyName;
    if (state.machineFilter === id) row.classList.add('active');

    const left = el('div', 'mr-left');
    const ico = document.createElement('span');
    ico.className = 'mr-ico';
    // "All": layered-stack glyph. Single machine: a small desktop/monitor glyph.
    ico.innerHTML = isAll
      ? '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 5.5L8 2.5l5.5 3L8 8.5 2.5 5.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.5 8.5L8 11.5l5.5-3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none"><rect x="2.2" y="3" width="11.6" height="8" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M6 13.3h4M8 11v2.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    left.appendChild(ico);
    left.appendChild(el('span', 'mr-name', label));
    row.appendChild(left);
	    row.appendChild(el('span', 'mr-count', String(count)));

	    row.addEventListener('click', () => {
	      selectMachine(id, { reason: 'sidebar' });
	    });
    row.addEventListener('dragover', (ev) => {
      if (id === ALL) return;
      if (ev.dataTransfer.types.includes('application/x-hasna-note-id') || ev.dataTransfer.types.includes('text/plain')) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
      }
    });
    row.addEventListener('drop', (ev) => {
      if (id === ALL) return;
      const noteId = ev.dataTransfer.getData('application/x-hasna-note-id') || ev.dataTransfer.getData('text/plain');
      if (!noteId) return;
      ev.preventDefault();
      moveNoteToMachine(noteId, id, machine && machine.friendlyName);
    });
    row.addEventListener('contextmenu', () => {
      if (id === ALL) return;
      const detail = machineDetails(id);
      window.dispatchEvent(new CustomEvent('hasna:machine-context', { detail: { machineId: id, machine: detail } }));
    });
    return row;
  }

  function renderEditor() {
    const editor = $('editor');
    const empty = $('empty-state');
    const nomatch = $('nomatch-state');
    const list = visibleNotes();
    const note = noteById(state.selectedId);
    const selVisible = note && list.some(n => n.id === note.id);

    // Decide which panel shows.
    if (selVisible) {
      editor.hidden = false; empty.hidden = true; nomatch.hidden = true;
      fillEditor(note);
      return;
    }
    editor.hidden = true;

    if (state.notes.length === 0) {
      // Truly zero notes anywhere.
      empty.hidden = false; nomatch.hidden = true;
    } else if (list.length === 0) {
      // There are notes, but the current filter/search hides them all.
      empty.hidden = true; nomatch.hidden = false;
      const desc = $('nomatch-desc');
      if (desc) {
        desc.textContent = state.query.trim()
          ? 'No notes match “' + state.query.trim() + '”.'
          : 'No notes on this machine yet.';
      }
    } else {
      // There ARE visible notes but none selected — select the newest and show it.
      state.selectedId = list[0].id;
      renderEditor();
    }
  }

  function fillEditor(note) {
    const titleEl = $('editor-title');
    const bodyEl = $('editor-body');
    // Only overwrite the field value when it differs, so we don't disturb the caret
    // while the user is typing (render() can be called from machine-filter clicks etc).
    if (titleEl.value !== note.title) titleEl.value = note.title || '';
    if (bodyEl.value !== note.body) bodyEl.value = note.body || '';

    $('em-machine').textContent = note.machine || state.thisMachine;
    $('em-updated').textContent = 'updated ' + relTime(note.updatedAt);

    const tags = $('em-tags');
    tags.innerHTML = '';
    (note.labels || []).forEach(t => {
      const dot = el('span', 'em-dot', '·');
      tags.appendChild(dot);
      tags.appendChild(el('span', 'em-tag', t));
    });
  }

  // ------------------------------------------------------------------ editor actions
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(commitEdit, 600);
  }

  // ---------- AI auto-title (Feature 6) ----------
  // While typing a body whose note still has a default title (and the title was never
  // manually edited), once the body crosses ~10–12 words, debounce then ask the sidecar
  // for a short title and apply it. Only fires once per note while still default-titled.
  let autoTitleTimer = null;
  function isDefaultTitle(t) { return DEFAULT_TITLES.indexOf((t || '').trim()) >= 0; }
  function wordCount(s) { return (s || '').trim().split(/\s+/).filter(Boolean).length; }
  function titleFingerprint(text) {
    let h = 0xcbf29ce484222325n;
    const bytes = new TextEncoder().encode(String(text || '').slice(0, 4000));
    for (const b of bytes) {
      h ^= BigInt(b);
      h = BigInt.asUintN(64, h * 0x100000001b3n);
    }
    return h.toString(16);
  }

  function maybeAutoTitle() {
    if (!ai().available) return;                      // no key/sidecar
    const note = noteById(state.selectedId);
    if (!note) return;
    if (titleManuallyEdited[note.id]) return;         // user named it — never override
    // Use the LIVE editor fields, not the model: the model's body/title only update on the
    // save debounce (commitEdit), which lags the keystrokes that drive this check.
    const titleEl = $('editor-title');
    const bodyEl = $('editor-body');
    const liveTitle = titleEl ? titleEl.value : note.title;
    const liveBody = bodyEl ? bodyEl.value : note.body;
    const titleText = markdownPlainText(liveBody);
    if (!isDefaultTitle(liveTitle)) return;           // already has a real title
    const fp = titleFingerprint(titleText);
    if (note.titleSource === 'generated' && note.titleContentFingerprint === fp) return;
    if (autoTitled[note.id] === fp) return;           // already tried this content
    if (wordCount(titleText) < 10) return;             // not enough content yet

    if (autoTitleTimer) clearTimeout(autoTitleTimer);
    const id = note.id;
    autoTitleTimer = setTimeout(() => { requestAutoTitle(id, liveBody); }, 1200);
  }

  function requestAutoTitle(id, body) {
    const note = noteById(id);
    if (!note) return;
    // Re-check guards (state may have changed during the debounce window). For the open
    // note, the live title field is the most current source of truth.
    const titleEl = (state.selectedId === id) ? $('editor-title') : null;
    const curTitle = titleEl ? titleEl.value : note.title;
    const readable = markdownPlainText(body);
    const fp = titleFingerprint(readable);
    if (titleManuallyEdited[id] || note.titleLocked || (!isDefaultTitle(curTitle) && note.titleSource !== 'generated')) return;
    if (autoTitled[id] === fp) return;
    autoTitled[id] = fp;                              // mark BEFORE the request for this body
    fetch(aiURL('/title'), {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({ text: readable }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const title = data && data.title ? String(data.title).trim() : '';
        const cur = noteById(id);
        if (!title || !cur) return;
        // Bail if the user named/changed it meanwhile.
        if (titleManuallyEdited[id] || cur.titleLocked || (!isDefaultTitle(cur.title) && cur.titleSource !== 'generated')) return;
        cur.title = title;
        cur.titleLocked = false;
        cur.titleSource = 'generated';
        cur.titleContentFingerprint = fp;
        cur.updatedAt = new Date().toISOString();
        postNative('save', serializeNote(cur));
        // Reflect in the open editor (only if this note is still open) + sidebar.
        if (state.selectedId === id) {
          const te = $('editor-title');
          if (te && isDefaultTitle(te.value)) te.value = title;
        }
        renderNotesList();
        renderHome();
      })
      .catch(() => { delete autoTitled[id]; });       // allow a retry on network failure
  }

  function queueAutoTitlesForStaleNotes() {
    if (!ai().available) return;
    let queued = 0;
    for (const note of sortNotes(state.notes)) {
      if (queued >= 5) break;                         // keep boot/hydrate cheap
      if (!note || note.titleLocked || titleManuallyEdited[note.id]) continue;
      const body = note.body || note.content || '';
      const readable = markdownPlainText(body);
      if (wordCount(readable) < 10) continue;
      const fp = titleFingerprint(readable);
      const isStaleGenerated = note.titleSource === 'generated' && note.titleContentFingerprint !== fp;
      if (!isDefaultTitle(note.title) && !isStaleGenerated) continue;
      if (autoTitled[note.id] === fp) continue;
      queued += 1;
      requestAutoTitle(note.id, body);
    }
  }

  // Pull the current title/body into the model + persist. Bumps updatedAt.
  function commitEdit() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    // Only commit while the note editor is the active view; on Home/Settings/Compact the
    // editor fields are stale (they don't reflect state.selectedId) and must not be written.
    if (state.screen !== 'notes') return;
    const note = noteById(state.selectedId);
    if (!note) return;
    const newTitle = $('editor-title').value;
    const newBody = $('editor-body').value;
    if (note.title === newTitle && note.body === newBody) return; // nothing changed
    note.title = newTitle;
    note.body = newBody;
    if (titleManuallyEdited[note.id] || (!isDefaultTitle(newTitle) && note.titleSource !== 'generated')) {
      note.titleLocked = true;
      note.titleSource = 'manual';
    } else if (isDefaultTitle(newTitle)) {
      note.titleLocked = false;
      note.titleSource = 'default';
      note.titleContentFingerprint = '';
    }
    note.updatedAt = new Date().toISOString();
    postNative('save', serializeNote(note));
    // Re-render the sidebar (title/order may have changed) but keep editor fields intact.
    renderNotesList();
    $('em-updated').textContent = 'updated ' + relTime(note.updatedAt);
  }

  // The shape we hand to the native host (and store in-memory).
	  function serializeNote(n) {
	    return {
	      id: n.id, title: n.title, body: n.body, content: n.body,
	      contentFormat: 'markdown',
	      labels: n.labels || [], tags: n.labels || [],
      status: n.status || 'active', folder: n.folder || '',
      machine: n.machine, updatedAt: n.updatedAt, createdAt: n.createdAt,
      createdByActorType: n.createdByActorType || 'human',
      createdByName: n.createdByName || '',
      sourceMachine: n.sourceMachine || n.machine || state.thisMachine,
      sourceMachineFriendlyName: n.sourceMachineFriendlyName || '',
      originMachine: n.originMachine || n.machine || state.thisMachine,
      originMachineFriendlyName: n.originMachineFriendlyName || '',
      targetMachineFriendlyName: n.targetMachineFriendlyName || '',
      previousMachine: n.previousMachine || '',
      openedFrom: n.openedFrom || '',
      sourceContext: n.sourceContext || '',
      archivedAt: n.archivedAt || '',
      trashedAt: n.trashedAt || '',
      trashMachine: n.trashMachine || '',
      trashExpiresAt: n.trashExpiresAt || '',
      restoredAt: n.restoredAt || '',
      movedAt: n.movedAt || '',
      titleLocked: !!n.titleLocked,
      titleSource: n.titleSource || (isDefaultTitle(n.title) ? 'default' : 'manual'),
      titleContentFingerprint: n.titleContentFingerprint || '',
    };
  }

  function newNote() {
    const nowIso = new Date().toISOString();
    const note = {
      id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      title: '', body: '', labels: [], status: 'active', folder: '',
      contentFormat: 'markdown',
      machine: state.thisMachine, updatedAt: nowIso, createdAt: nowIso,
      ...defaultProvenance(state.thisMachine),
      titleLocked: false, titleSource: 'default', titleContentFingerprint: '',
    };
    state.notes.push(note);
    state.selectedId = note.id;
    // New notes always belong to this machine; if the filter would hide it, reset to All.
    if (state.machineFilter !== ALL && state.machineFilter !== note.machine) {
      state.machineFilter = ALL;
    }
    state.labelFilter = ALL;
    state.noteListLimit = 10;
    state.query = '';
    const si = $('search-input'); if (si) si.value = '';
    state.screen = 'notes';
    showApp();
    postNative('create', serializeNote(note));
    render();
    const titleEl = $('editor-title');
    if (titleEl) titleEl.focus();
  }

  // Create a note WITHOUT navigating to it (Home / compact quick-note flow). Stays on the
  // current screen, shows a toast, and clears nothing of the current selection.
  function quickCreate(title, body, meta) {
    const nowIso = new Date().toISOString();
    const extra = meta || {};
    const note = {
      id: extra.id || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
      title: title || '', body: body || '', labels: noteLabels(extra), status: extra.status || 'active', folder: extra.folder || '',
      contentFormat: 'markdown',
      machine: extra.machine || state.thisMachine, updatedAt: nowIso, createdAt: nowIso,
      ...defaultProvenance(state.thisMachine),
      ...extra,
      titleLocked: !!(title && title.trim()), titleSource: title && title.trim() ? 'manual' : 'default',
      titleContentFingerprint: '',
    };
    state.notes.push(note);
    postNative('create', serializeNote(note));
    if (!note.titleLocked && body && body.trim()) {
      requestAutoTitle(note.id, body);
    }
    // Re-render the sidebar list + home cards, but do NOT change selectedId/screen.
    renderLabels();
    renderNotesList();
    renderHome();
    return note;
  }

  function deleteCurrent() {
    const note = noteById(state.selectedId);
    if (!note) return;
    deleteNote(note);
  }

  function selectNote(id) {
    commitEdit();              // flush any pending edit before switching away
    state.selectedId = id;
    state.screen = 'notes';
    showApp();
    render();
  }

  // ------------------------------------------------------------------ settings + theme
  const SETTINGS_TABS = ['appearance', 'machines', 'about'];
  const win = $('window');

  function showSettings(tab) {
    state.screen = 'settings';
    win.setAttribute('data-active-shell', 'settings');
    const t = SETTINGS_TABS.indexOf(tab) >= 0 ? tab : 'appearance';
    document.querySelectorAll('.set-item').forEach(s => s.classList.remove('active'));
    const item = document.querySelector('.set-item[data-tab="' + t + '"]');
    if (item) item.classList.add('active');
    document.querySelectorAll('.set-page').forEach(p => p.classList.remove('active'));
    const page = document.querySelector('.set-page[data-tab="' + t + '"]');
    if (page) page.classList.add('active');
    if (t === 'machines') renderMachinesPage();
  }

  function showApp() {
    win.setAttribute('data-active-shell', 'app');
  }

  // Navigate to the Home landing screen (stays in the app shell, shows #home-state).
  function showHome() {
    commitEdit();
    state.screen = 'home';
    showApp();
    render();
    const qn = $('qn-input'); if (qn) qn.focus();
  }

  // Enter/leave the compact quick-note layout. Drives BOTH the native window (resize via
  // the `window` bridge) and the web layout (a dedicated compact shell).
  function setCompact(on) {
    if (on) {
      commitEdit();
      state.screen = 'compact';
      win.setAttribute('data-active-shell', 'compact');
      postWindow('setCompact', { on: true });
      const ci = $('compact-input'); if (ci) setTimeout(() => ci.focus(), 60);
    } else {
      postWindow('setCompact', { on: false });
      state.screen = 'home';
      showApp();
      render();
    }
  }

  // Theme: persisted in localStorage, applied as data-theme on <html>. "system"
  // follows the OS via prefers-color-scheme.
  const THEME_KEY = 'hasna-notes-theme';
  let mq = null;
  function applyTheme(theme) {
    const root = document.documentElement;
    let effective = theme;
    if (theme === 'system') {
      effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
    }
    root.setAttribute('data-theme', effective);
    root.setAttribute('data-theme-pref', theme);
    // Reflect selection in the theme cards.
    document.querySelectorAll('.theme-card').forEach(c => {
      c.classList.toggle('theme-selected', c.getAttribute('data-theme') === theme);
    });
  }
  function setTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    bindSystemWatch(theme);
    applyTheme(theme);
  }
  function bindSystemWatch(theme) {
    if (!window.matchMedia) return;
    if (!mq) mq = window.matchMedia('(prefers-color-scheme: dark)');
    // Re-apply when the OS theme flips, but only while the pref is "system".
    if (!bindSystemWatch._bound) {
      const onChange = () => {
        const pref = (function () { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } })() || 'system';
        if (pref === 'system') applyTheme('system');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
      bindSystemWatch._bound = true;
    }
  }
  function initTheme() {
    let pref = 'system';
    try { pref = localStorage.getItem(THEME_KEY) || 'system'; } catch (e) {}
    bindSystemWatch(pref);
    applyTheme(pref);
  }

  function renderSettingsMeta() {
    const m = $('about-machine'); if (m) m.textContent = state.thisMachine || '—';
    const c = $('about-count'); if (c) c.textContent = String(state.notes.length);
  }

  // ------------------------------------------------------------------ context menu (Feature 3)
  let ctxNoteId = null;

  function openContextMenu(e, noteId) {
    const menu = $('ctx-menu');
    if (!menu) return;
    ctxNoteId = noteId;
    menu.hidden = false;
    // Position at the cursor, clamped to the viewport.
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 160;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function closeContextMenu() {
    const menu = $('ctx-menu');
    if (menu && !menu.hidden) menu.hidden = true;
    ctxNoteId = null;
  }

  function onCtxAction(e) {
    const act = e.currentTarget.getAttribute('data-act');
    const id = ctxNoteId;
    closeContextMenu();
    if (!id) return;
    const note = noteById(id);
    if (!note) return;
    if (act === 'rename') startInlineRename(id);
    else if (act === 'duplicate') duplicateNote(note);
    else if (act === 'copy') copyNoteText(note);
    else if (act === 'archive') archiveNote(note.id);
    else if (act === 'move') promptMoveNote(note.id);
    else if (act === 'restore') restoreNote(note.id);
    else if (act === 'delete') deleteNote(note);
  }

  // Inline-rename: swap the row's title span for an input, commit on Enter/blur.
  function startInlineRename(id) {
    const row = document.querySelector('.note-row[data-id="' + cssEsc(id) + '"]');
    const note = noteById(id);
    if (!row || !note) return;
    const titleSpan = row.querySelector('.note-title');
    if (!titleSpan) return;
    const input = el('input', 'note-rename');
    input.type = 'text';
    input.value = (note.title && note.title.trim()) || '';
    input.placeholder = 'Untitled Note';
    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      if (save) {
        const v = input.value.trim();
        note.title = v || 'Untitled Note';
        titleManuallyEdited[id] = true;   // a manual rename counts as a manual title
        note.titleLocked = true;
        note.titleSource = 'manual';
        note.updatedAt = new Date().toISOString();
        postNative('save', serializeNote(note));
        if (state.selectedId === id) {
          const te = $('editor-title'); if (te) te.value = note.title;
        }
      }
      renderNotesList();
      renderHome();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    // Don't let clicks inside the input bubble to the row (which would selectNote).
    input.addEventListener('click', (ev) => ev.stopPropagation());
  }

  // Escape a string for use in a [data-id="..."] selector.
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function duplicateNote(src) {
    const baseTitle = (src.title && src.title.trim()) || 'Untitled Note';
    const dup = quickCreate(baseTitle + ' copy', src.body || '');
    // Carry over labels/folder for a faithful copy.
    dup.labels = noteLabels(src).slice();
    dup.folder = src.folder || '';
    postNative('save', serializeNote(dup));
    toast('Note duplicated');
  }

  function copyNoteText(note) {
    const text = note.body || '';
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      } catch (e) { /* ignore */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'), () => { fallback(); toast('Copied to clipboard'); });
    } else { fallback(); toast('Copied to clipboard'); }
  }

  function archiveNote(id) {
    const note = noteById(id);
    if (!note) return;
    note.status = 'archived';
    note.archivedAt = new Date().toISOString();
    note.trashedAt = '';
    note.trashMachine = '';
    note.trashExpiresAt = '';
    note.updatedAt = new Date().toISOString();
    postNative('archive', serializeNote(note));
    dispatchNoteEvent('hasna:note-archive', note);
    render();
  }

  function restoreNote(id) {
    const note = noteById(id);
    if (!note) return;
    note.status = 'active';
    note.archivedAt = '';
    note.trashedAt = '';
    note.trashMachine = '';
    note.trashExpiresAt = '';
    note.restoredAt = new Date().toISOString();
    note.updatedAt = note.restoredAt;
    postNative('restore', serializeNote(note));
    dispatchNoteEvent('hasna:note-restore', note);
    render();
  }

  function trashNote(note, options) {
    if (note.status === 'trash') return note;
    const now = new Date().toISOString();
    note.status = 'trash';
    note.trashedAt = now;
    note.trashMachine = note.machine || state.thisMachine;
    note.trashExpiresAt = addDaysISO(now, state.settings.trashRetentionDays);
    note.updatedAt = now;
    postNative('trash', serializeNote(note), { confirmed: !!(options && options.confirmed) });
    dispatchNoteEvent('hasna:note-trash', note);
    return note;
  }

  function purgeNote(id, options) {
    const note = noteById(id);
    if (!note) return;
    postNative('purge', serializeNote(note), { confirmed: !!(options && options.confirmed) });
    state.notes = state.notes.filter(n => n.id !== id);
    if (state.selectedId === id) {
      const v = visibleNotes();
      state.selectedId = v.length ? v[0].id : null;
    }
    dispatchNoteEvent('hasna:note-purge', note);
    render();
  }

		  function moveNoteToMachine(id, machine, friendlyName) {
		    const note = noteById(id);
		    const requested = String(machine || '').trim();
		    if (!note || !requested) return null;
		    const destination = machineDetails(requested);
		    const target = destination.id || requested;
		    const targetMachineFriendlyName = friendlyName || destination.friendlyName || destination.displayName || '';
		    if (noteMatchesMachine(note, target) && note.machine === target) {
		      selectMachine(target, { noteId: id, reason: 'move' });
		      return note;
		    }
		    if (!note.originMachine) note.originMachine = note.machine || state.thisMachine;
		    note.previousMachine = note.machine || '';
		    note.machine = target;
	    note.targetMachineFriendlyName = targetMachineFriendlyName;
	    note.movedAt = new Date().toISOString();
		    note.updatedAt = note.movedAt;
		    postNative('move', serializeNote(note));
		    const selectedMachine = selectMachine(target, { noteId: note.id, reason: 'move' });
		    dispatchNoteEvent('hasna:note-move', note, {
		      targetMachine: target,
		      targetMachineFriendlyName,
		      selectedMachine,
		      selectedNoteId: state.selectedId,
		      view: viewSnapshot(),
		    });
		    return note;
		  }

  function promptMoveNote(id) {
    const machines = machineDisplays().filter(m => m.id !== ALL);
    const target = window.prompt('Move to machine', machines[0] ? machines[0].id : state.thisMachine);
    if (target) moveNoteToMachine(id, target);
  }

  function dispatchNoteEvent(name, note, extra) {
    window.dispatchEvent(new CustomEvent(name, {
      detail: Object.assign({ note: serializeNote(note), noteId: note.id }, extra || {}),
    }));
  }

  function noteInfo(id) {
    const note = noteById(id);
    if (!note) return null;
    const bootInfo = note.info || {};
    return {
      createdBy: note.createdByName || note.author || 'Unknown',
      createdByActorType: note.createdByActorType || 'human',
      createdAt: note.createdAt,
      sourceMachine: note.sourceMachine || note.machine,
      sourceMachineFriendlyName: note.sourceMachineFriendlyName || bootInfo.sourceMachineFriendlyName || '',
      originMachine: note.originMachine || note.machine,
      originMachineFriendlyName: note.originMachineFriendlyName || bootInfo.originMachineFriendlyName || '',
      currentMachine: note.machine,
      openedFrom: note.openedFrom || '',
      sourceContext: note.sourceContext || '',
    };
  }

  function cleanupExpiredTrash() {
    const expired = expiredTrashNotes();
    if (!expired.length) return [];
    if (!confirmExpiredTrashCleanup(expired)) return [];
    expired.forEach(n => {
      postNative('purge', serializeNote(n), { confirmed: true });
      dispatchNoteEvent('hasna:note-purge', n, { reason: 'retention-cleanup' });
    });
    if (expired.length) {
      const ids = new Set(expired.map(n => n.id));
      state.notes = state.notes.filter(n => !ids.has(n.id));
      render();
    }
    return expired.map(n => n.id);
  }

  function expiredTrashNotes() {
    const now = Date.now();
    return state.notes.filter(n => n.status === 'trash' && n.trashExpiresAt && Date.parse(n.trashExpiresAt) <= now);
  }

  function confirmExpiredTrashCleanup(expired) {
    if (typeof window.confirm !== 'function') return false;
    return window.confirm('Delete expired Trash notes permanently?\n\n' +
      expired.length + ' note(s) will be permanently deleted. This cannot be undone.');
  }

  function notifyExpiredTrashReady() {
    const expired = expiredTrashNotes();
    if (!expired.length) return [];
    window.dispatchEvent(new CustomEvent('hasna:trash-cleanup-ready', {
      detail: {
        count: expired.length,
        noteIds: expired.map(n => n.id),
        notes: expired.map(serializeNote),
      },
    }));
    return expired.map(n => n.id);
  }

  function setStatusFilter(filter) {
    state.statusFilter = ['active', 'archived', 'trash', 'all'].includes(filter) ? filter : 'active';
    state.noteListLimit = 10;
    render();
  }

  function noteTitleForConfirm(note) {
    return (note && note.title && note.title.trim()) || 'Untitled Note';
  }

  function deleteConfirmationMessage(note, options) {
    const permanent = !!(options && options.permanent) || (note && note.status === 'trash');
    const title = noteTitleForConfirm(note);
    if (permanent) {
      return 'Delete permanently?\n\n"' + title + '" will be permanently deleted. This cannot be undone.';
    }
    return 'Move note to Trash?\n\n"' + title + '" can be restored from Trash.';
  }

  function confirmNoteDelete(note, options) {
    if (typeof window.confirm !== 'function') return false;
    return window.confirm(deleteConfirmationMessage(note, options));
  }

  // Delete a specific note (by reference). Normal delete moves to Trash first; a note
  // already in Trash is permanently purged.
  function deleteNote(note) {
    const permanent = note.status === 'trash';
    if (!confirmNoteDelete(note, { permanent })) return null;
    if (permanent) { purgeNote(note.id, { confirmed: true }); return; }
    trashNote(note, { confirmed: true });
    render();
    return serializeNote(note);
  }

  function trashNoteWithConfirmation(id) {
    const note = noteById(id);
    if (!note) return null;
    if (note.status === 'trash') return serializeNote(note);
    if (!confirmNoteDelete(note)) return null;
    trashNote(note, { confirmed: true });
    render();
    return serializeNote(note);
  }

  function purgeNoteWithConfirmation(id) {
    const note = noteById(id);
    if (!note) return null;
    if (!confirmNoteDelete(note, { permanent: true })) return null;
    purgeNote(id, { confirmed: true });
    return { id, permanent: true };
  }

	  // ------------------------------------------------------------------ app-level voice notes
	  const rec = {
	    status: 'idle',       // idle | recording | paused | stopping | transcribing | complete | error
	    mode: 'bounded',      // realtime | bounded
	    provider: 'bounded',
    mediaRecorder: null,
    chunks: [],
    stream: null,
    timer: null,
    started: 0,
    busy: false,
    ws: null,
    audioContext: null,
    source: null,
    processor: null,
    targetRate: 24000,
	    partialTranscript: '',
	    finalTranscript: '',
	    progressPhase: '',
	    progressPercent: null,
	    error: '',
	    startToken: 0,
	    finalizeTimer: null,
	  };

  const nativeRecording = () =>
    !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.recording);

  function recElapsed() {
    const s = rec.started ? Math.floor((Date.now() - rec.started) / 1000) : 0;
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function recordingSnapshot() {
    return {
      status: rec.status,
      mode: rec.mode,
      provider: rec.provider,
	      elapsed: recElapsed(),
	      partialTranscript: rec.partialTranscript,
	      finalTranscript: rec.finalTranscript,
	      progress: {
	        phase: rec.progressPhase,
	        percent: rec.progressPercent,
	      },
	      progressPhase: rec.progressPhase,
	      progressPercent: rec.progressPercent,
	      busy: !!rec.busy,
	      canPause: rec.status === 'recording',
	      canResume: rec.status === 'paused',
	      canStop: rec.status === 'recording' || rec.status === 'paused',
	      error: rec.error,
	    };
	  }

  // Map the rich rec.status to the contract lifecycle verb the host's `window` handler
  // expects, detecting started/resumed/paused/stopped transitions from the prior status.
  let lastEmittedRecStatus = 'idle';
	  function recLifecycleVerb(status) {
	    if (status === 'recording') return (lastEmittedRecStatus === 'paused') ? 'resumed' : 'started';
	    if (status === 'paused') return 'paused';
	    if (status === 'stopping') return 'stopping';
	    if (status === 'transcribing') return 'transcribing';
	    if (status === 'complete') return 'complete';
	    if (status === 'error') return 'error';
	    if (status === 'idle') return 'stopped';
	    return null;
	  }

	  function setRecordingProgress(phase, percent) {
	    rec.progressPhase = phase || '';
	    rec.progressPercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(1, Number(percent))) : null;
	    const detail = Object.assign(recordingSnapshot(), { phase: rec.progressPhase, percent: rec.progressPercent });
	    window.dispatchEvent(new CustomEvent('hasna:recording-progress', { detail }));
	    if (nativeRecording()) {
	      try { window.webkit.messageHandlers.recording.postMessage({ action: 'progress', state: detail }); }
	      catch (e) { /* host gone */ }
	    }
	  }

  function emitRecordingState(extra) {
    const detail = Object.assign(recordingSnapshot(), extra || {});
    window.dispatchEvent(new CustomEvent('hasna:recording-state', { detail }));
    if (nativeRecording()) {
      try { window.webkit.messageHandlers.recording.postMessage({ action: 'state', state: detail }); }
      catch (e) { /* host gone */ }
    }
    // Contract: also emit the lifecycle to the host on the `window` handler so the macOS
    // menu-bar status item can reflect it: postWindow('recording', {state, elapsedMs}).
    // Only on real status transitions (not on every 500ms tick) to avoid spamming the host.
	    if (!extra || !extra.tick) {
	      const verb = recLifecycleVerb(rec.status);
	      if (verb) {
	        const elapsedMs = rec.started ? (Date.now() - rec.started) : 0;
	        postWindow('recording', { state: verb, status: rec.status, elapsedMs: elapsedMs, progress: recordingSnapshot().progress });
	      }
	    } else {
	      // Lightweight ticking update so the menu-bar timer can stay current.
	      if (rec.status === 'recording') {
	        postWindow('recording', { state: 'tick', status: rec.status, elapsedMs: rec.started ? (Date.now() - rec.started) : 0, progress: recordingSnapshot().progress });
	      }
	    }
    lastEmittedRecStatus = rec.status;
    setRecUI(rec.status);
  }

  function emitTranscript(type, text, extra) {
    const detail = Object.assign({ text: text || '', provider: rec.provider, mode: rec.mode }, extra || {});
    window.dispatchEvent(new CustomEvent(type, { detail }));
    if (nativeRecording()) {
      try { window.webkit.messageHandlers.recording.postMessage({ action: type, transcript: detail }); }
      catch (e) { /* host gone */ }
    }
  }

  // Drive the redesigned record UI: timer INSIDE the circle, stop-square on hover (CSS),
  // pause/resume side control, the persistent fixed recording pill (every screen), and the
  // transcript surface. No "Record voice note" / "tap to stop" labels.
	  function setRecUI(stateName) {
    // The recording control now lives INSIDE the quick-note pill; pause/stop controls
    // live in the persistent bottom pill (no duplicate large surface on Home).
    const wrap = $('qn-form');
    const recBtn = $('rec-btn');
    const timerIn = $('rec-timer-in');
	    const active = (stateName === 'recording' || stateName === 'paused' || stateName === 'stopping' || stateName === 'transcribing');

	    if (wrap) {
	      wrap.classList.remove('recording', 'transcribing', 'paused', 'stopping', 'complete', 'error');
	      if (stateName === 'recording') wrap.classList.add('recording');
	      else if (stateName === 'paused') wrap.classList.add('recording', 'paused');
	      else if (stateName === 'stopping') wrap.classList.add('stopping');
	      else if (stateName === 'transcribing') wrap.classList.add('transcribing');
	      else if (stateName === 'complete') wrap.classList.add('complete');
	      else if (stateName === 'error') wrap.classList.add('error');
	    }
	    if (timerIn && active) timerIn.textContent = stateName === 'transcribing' ? '' : recElapsed();
    if (recBtn) {
      const cfg = ai();
      recBtn.setAttribute('aria-label',
	        active ? (stateName === 'transcribing' ? 'Transcribing recording' : 'Stop recording') : ((cfg.available || cfg.realtime) ? 'Record a voice note' : 'Voice notes need an OpenAI key'));
	    }
    updateComposerControls();
    renderRecPill();
    renderTranscript();
  }

  // The persistent fixed recording pill — visible on EVERY screen whenever recording is
  // active (independent of data-active-shell). Updates the timer + pause/resume label.
	  function renderRecPill() {
	    const pill = $('rec-pill');
	    if (!pill) return;
	    const active = (rec.status === 'recording' || rec.status === 'paused' || rec.status === 'stopping' || rec.status === 'transcribing');
	    pill.hidden = !active;
	    if (!active) return;
	    pill.classList.toggle('paused', rec.status === 'paused');
	    pill.classList.toggle('transcribing', rec.status === 'transcribing');
	    pill.classList.toggle('stopping', rec.status === 'stopping');
	    const t = $('rec-pill-timer'); if (t) t.textContent = recElapsed();
	    const pb = $('rec-pill-pause');
	    if (pb) {
	      pb.hidden = !(rec.status === 'recording' || rec.status === 'paused');
	      pb.title = (rec.status === 'paused') ? 'Resume' : 'Pause';
	    }
	  }

  // Transcript surface: committed final text + a muted trailing partial line. Internal
  // scroll, fixed min-height — never shifts page layout. Hidden until any text arrives.
  function renderTranscript() {
    const surface = $('transcript');
    const finalEl = $('transcript-final');
    const partialEl = $('transcript-partial');
    if (!surface) return;
    const f = rec.finalTranscript || '';
    const p = rec.partialTranscript || '';
    if (!f && !p) { surface.hidden = true; return; }
    surface.hidden = false;
    if (finalEl && finalEl.textContent !== f) finalEl.textContent = f ? (f + (p ? ' ' : '')) : '';
    if (partialEl && partialEl.textContent !== p) partialEl.textContent = p;
    // Keep the newest text in view without janking the rest of the page.
    const body = $('transcript-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

	  function onRecordClick() {
	    const cfg = ai();
	    if ((!cfg.available && !cfg.realtime) || rec.busy) return;
	    if (rec.status === 'recording' || rec.status === 'paused') { stopRecording(); return; }
	    if (rec.status === 'stopping' || rec.status === 'transcribing') return;
	    startRecording();
	  }

  // Pick a recording container that OpenAI gpt-4o-transcribe accepts. The model rejects
  // some AAC/m4a containers, so prefer webm/opus and ogg/opus first, then fall back to
  // whatever the platform offers (the sidecar surfaces a clear error if unsupported).
  function pickRecorderMime() {
    const prefs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
    ];
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      for (const t of prefs) { if (MediaRecorder.isTypeSupported(t)) return t; }
    }
    return '';   // let MediaRecorder choose its default
  }

  function startRecording() {
    const cfg = ai();
    if (!cfg.available && !cfg.realtime) {
      toast('Voice notes need an OpenAI or ElevenLabs key');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Microphone not available'); return;
    }
	    rec.error = '';
	    rec.partialTranscript = '';
	    rec.finalTranscript = '';
	    rec.status = 'idle';
	    setRecordingProgress('requesting-microphone', null);
	    rec.busy = true;
	    const token = ++rec.startToken;
	    emitRecordingState();
	    navigator.mediaDevices.getUserMedia({ audio: true })
	      .then(stream => {
	        if (token !== rec.startToken || rec.status !== 'idle') {
	          stream.getTracks().forEach(t => t.stop());
	          return;
	        }
        rec.stream = stream;
        if (cfg.realtime) return startRealtimeRecording(stream, cfg);
        return startBoundedRecording(stream);
      })
      .catch(() => {
        rec.busy = false;
        rec.status = 'error';
        rec.error = 'Microphone permission denied';
        toast(rec.error);
        emitRecordingState();
      });
  }

  function startBoundedRecording(stream) {
    rec.mode = 'bounded';
    rec.provider = 'openai-bounded';
    rec.chunks = [];
    const mime = pickRecorderMime();
    let mr;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { mr = new MediaRecorder(stream); }
    rec.mediaRecorder = mr;
    mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
    mr.onstop = onBoundedRecordingStopped;
    mr.start();
    beginRecordingClock();
  }

  function startRealtimeRecording(stream, cfg) {
    rec.mode = 'realtime';
    rec.provider = cfg.realtimeProvider || 'openai';
    rec.targetRate = rec.provider === 'elevenlabs' ? 16000 : 24000;
    const wsURL = 'ws://127.0.0.1:' + cfg.port + '/realtime-transcribe?provider=' +
      encodeURIComponent(rec.provider) + '&sampleRate=' + rec.targetRate +
      (cfg.token ? '&token=' + encodeURIComponent(cfg.token) : '');
    const ws = new WebSocket(wsURL);
    rec.ws = ws;
    ws.addEventListener('open', () => {
      setupRealtimeAudio(stream);
      beginRecordingClock();
    });
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'ready') {
        rec.provider = msg.provider || rec.provider;
        emitRecordingState();
	      } else if (msg.type === 'transcript.delta') {
	        rec.partialTranscript = msg.text || msg.delta || '';
	        if (rec.status === 'transcribing') setRecordingProgress('receiving-final-transcript', null);
	        emitTranscript('hasna:transcript-delta', rec.partialTranscript, msg);
	        emitRecordingState();
	      } else if (msg.type === 'transcript.completed') {
	        rec.finalTranscript = [rec.finalTranscript, msg.text || msg.transcript || ''].filter(Boolean).join(' ').trim();
	        rec.partialTranscript = '';
	        if (rec.status === 'transcribing') setRecordingProgress('finalizing-transcript', 0.9);
	        emitTranscript('hasna:transcript-complete', rec.finalTranscript, msg);
        emitRecordingState();
        if (rec.status === 'transcribing') {
          if (rec.finalizeTimer) { clearTimeout(rec.finalizeTimer); rec.finalizeTimer = null; }
          setTimeout(finishRecordingWithText, 120);
        }
      } else if (msg.type === 'error') {
        failRecording(msg.error || 'Realtime transcription failed');
      }
    });
    ws.addEventListener('error', () => {
      failRecording('Realtime transcription failed');
    });
    ws.addEventListener('close', () => {
      if (rec.status === 'transcribing') finishRecordingWithText();
    });
  }

	  function failRecording(message) {
	    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
	    if (rec.finalizeTimer) { clearTimeout(rec.finalizeTimer); rec.finalizeTimer = null; }
	    rec.error = message || 'Recording failed';
	    rec.status = 'error';
	    rec.busy = false;
	    setRecordingProgress('error', null);
	    releaseRealtimeAudio();
	    stopStream();
    try { if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.close(); } catch (e) {}
    toast(rec.error);
    emitRecordingState();
  }

	  function beginRecordingClock() {
	    rec.started = Date.now();
	    rec.status = 'recording';
	    rec.busy = false;
	    setRecordingProgress('', null);
	    if (rec.timer) clearInterval(rec.timer);
    rec.timer = setInterval(() => {
      // setRecUI (via emitRecordingState) refreshes the in-circle timer + pill timer.
      emitRecordingState({ tick: true });
    }, 500);
    emitRecordingState();
  }

  function setupRealtimeAudio(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    rec.audioContext = new AudioCtx();
    rec.source = rec.audioContext.createMediaStreamSource(stream);
    rec.processor = rec.audioContext.createScriptProcessor(4096, 1, 1);
    rec.processor.onaudioprocess = (ev) => {
      if (rec.status !== 'recording') return;
      if (!rec.ws || rec.ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = floatTo16BitPCM(downsample(input, rec.audioContext.sampleRate, rec.targetRate));
      if (!pcm.byteLength) return;
      rec.ws.send(JSON.stringify({ type: 'audio', audio: arrayBufferToBase64(pcm.buffer), sampleRate: rec.targetRate }));
    };
    rec.source.connect(rec.processor);
    rec.processor.connect(rec.audioContext.destination);
  }

  function pauseRecording() {
    if (rec.status !== 'recording') return;
    if (rec.mediaRecorder && rec.mediaRecorder.state === 'recording') rec.mediaRecorder.pause();
    rec.status = 'paused';
    emitRecordingState();
  }

  function resumeRecording() {
    if (rec.status !== 'paused') return;
    if (rec.mediaRecorder && rec.mediaRecorder.state === 'paused') rec.mediaRecorder.resume();
    rec.status = 'recording';
    emitRecordingState();
  }

	  function stopRecording() {
	    if (rec.status !== 'recording' && rec.status !== 'paused') return;
	    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
	    rec.busy = true;
	    rec.status = 'stopping';
	    setRecordingProgress('stopping', 0.2);
	    emitRecordingState();
	    if (rec.mode === 'realtime') {
	      try { if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.send(JSON.stringify({ type: 'commit' })); } catch (e) {}
	      releaseRealtimeAudio();
	      stopStream();
	      rec.status = 'transcribing';
	      setRecordingProgress('awaiting-final-transcript', null);
	      emitRecordingState();
	      if (rec.finalizeTimer) clearTimeout(rec.finalizeTimer);
	      rec.finalizeTimer = setTimeout(() => {
	        rec.finalizeTimer = null;
        try { if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.close(); } catch (e) {}
        finishRecordingWithText();
	      }, 5000);
	      return;
	    }
	    if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
	    else failRecording('Recording stopped before audio was available');
	  }

  function onBoundedRecordingStopped() {
    // Release the mic.
    releaseRealtimeAudio();
    stopStream();
    const mime = (rec.mediaRecorder && rec.mediaRecorder.mimeType) || 'audio/webm';
	    const blob = new Blob(rec.chunks, { type: mime });
	    rec.chunks = [];
	    rec.mediaRecorder = null;
	    if (!blob.size) { resetRecording(); return; }
	    rec.busy = true;
	    rec.status = 'transcribing';
	    setRecordingProgress('uploading-audio', 0.35);
	    emitRecordingState();
	    blobToBase64(blob).then(b64 => {
	      setRecordingProgress('transcribing-audio', 0.6);
	      return fetch(aiURL('/transcribe'), {
	        method: 'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ audioBase64: b64, mime: mime }),
      });
	    }).then(r => {
	      if (!r || !r.ok) throw new Error('Transcription failed');
	      return r.json();
	    }).then(data => {
	      const text = data && data.text ? String(data.text).trim() : '';
	      rec.finalTranscript = text;
	      setRecordingProgress('finalizing-transcript', 0.9);
	      finishRecordingWithText();
	    }).catch(() => { failRecording('Transcription failed'); });
	  }

  function finishRecordingWithText() {
    if (rec.finalizeTimer) { clearTimeout(rec.finalizeTimer); rec.finalizeTimer = null; }
    const text = (rec.finalTranscript || rec.partialTranscript || '').trim();
    releaseRealtimeAudio();
    stopStream();
    try { if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.close(); } catch (e) {}
	    if (text) {
	      quickCreate('', transcriptToNoteBody(text));
	      toast('Voice note added');
	    } else if (rec.status !== 'error') {
	      toast('Could not transcribe audio');
	    }
	    rec.status = 'complete';
	    rec.busy = false;
	    setRecordingProgress('complete', 1);
	    emitRecordingState();
	    setTimeout(() => { if (rec.status === 'complete') resetRecording(); }, 800);
	  }

	  function resetRecording() {
	    rec.status = 'idle';
	    rec.busy = false;
	    rec.started = 0;
	    rec.mediaRecorder = null;
    rec.ws = null;
    rec.chunks = [];
	    rec.partialTranscript = '';
	    rec.finalTranscript = '';
	    rec.progressPhase = '';
	    rec.progressPercent = null;
	    rec.error = '';
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    if (rec.finalizeTimer) { clearTimeout(rec.finalizeTimer); rec.finalizeTimer = null; }
    emitRecordingState();
  }

  function stopStream() {
    if (rec.stream) { rec.stream.getTracks().forEach(t => t.stop()); rec.stream = null; }
  }

  function releaseRealtimeAudio() {
    try { if (rec.processor) rec.processor.disconnect(); } catch (e) {}
    try { if (rec.source) rec.source.disconnect(); } catch (e) {}
    try { if (rec.audioContext) rec.audioContext.close(); } catch (e) {}
    rec.processor = null;
    rec.source = null;
    rec.audioContext = null;
  }

  function downsample(input, inRate, outRate) {
    if (!input.length || inRate === outRate) return input;
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function floatTo16BitPCM(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = String(reader.result || '');
        const comma = res.indexOf(',');
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function initRecButton() {
    const btn = $('rec-btn');
    const wrap = $('qn-form');
    if (!btn || !wrap) return;
    const cfg = ai();
    if (!cfg.available && !cfg.realtime) {
      wrap.classList.add('rec-disabled');
      btn.setAttribute('title', 'Add an OpenAI or ElevenLabs key to enable voice notes');
      btn.setAttribute('aria-disabled', 'true');
    } else {
      wrap.classList.remove('rec-disabled');
      btn.setAttribute('title', 'Record a voice note');
      btn.removeAttribute('aria-disabled');
    }
    setRecUI(rec.status);
  }

  // ------------------------------------------------------------------ event wiring
  let started = false;

  // Named handlers so they can be removed on destroy() (leak-safe under host reloads).
  function onTitleInput() {
    const n = noteById(state.selectedId);
    if (!n) return;
    // If the user typed a non-default title, mark it manual so we never auto-title it.
    const v = $('editor-title').value;
    if (!isDefaultTitle(v)) {
      titleManuallyEdited[n.id] = true;
    } else {
      // Cleared back to a default title → eligible for auto-title again.
      delete titleManuallyEdited[n.id];
      delete autoTitled[n.id];
    }
    scheduleSave();
  }
  function onBodyInput() {
    const n = noteById(state.selectedId);
    if (!n) return;
    scheduleSave();
    maybeAutoTitle();
  }
  function onEditorBlur() { commitEdit(); }
  function onSearchInput(e) {
    state.query = e.target.value || '';
    state.noteListLimit = 10;
    // If the selected note is filtered out, fall through to newest visible in renderEditor.
    renderNotesList();
    renderEditor();
  }
  function onNewNote(e) { if (e) e.preventDefault(); newNote(); }
  function onDelete(e) { if (e) e.preventDefault(); deleteCurrent(); }
  function onOpenHome(e) { if (e) e.preventDefault(); showHome(); }
  function onOpenChat(e) { if (e) e.preventDefault(); showChatPage(); }
  function onOpenLabels(e) { if (e) e.preventDefault(); showLabelsPage(); }
  function onMinimize(e) { if (e) e.preventDefault(); setCompact(true); }
  function onCompactExpand(e) { if (e) e.preventDefault(); setCompact(false); }
  // "View more" under Machines opens the fuller list in Settings → Machines.
  function onMachinesMore(e) {
    if (e) e.preventDefault();
    showSettings('machines');
  }
  function onAllNotes(e) { if (e) e.preventDefault(); showNotesPage(); }
  function onChatSubmit(e) {
    if (e) e.preventDefault();
    const input = $('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChat(text).catch(err => toast(err.message || String(err)));
  }
  function onLabelCreate(e) {
    if (e) e.preventDefault();
    const input = $('label-create-input');
    if (!input) return;
    const label = input.value.trim();
    if (!label) return;
    createLabelLocal(label);
    input.value = '';
  }
  // Home quick-note submit: create without navigating, clear, toast.
  function onQuickNote(e) {
    if (e) e.preventDefault();
    const inp = $('qn-input'); if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    quickCreate(v, '');
    inp.value = '';
    inp.focus();
    updateComposerControls();
    toast('Note added');
  }
  // Toggle the pill's primary control: typed text → Add (submit); empty → Record.
  function onQnInput() { updateComposerControls(); }
  function updateComposerControls() {
    const inp = $('qn-input'); const add = $('qn-add'); const recBtn = $('rec-btn');
    if (!inp) return;
    const hasText = !!inp.value.trim();
    const recActive = (rec.status === 'recording' || rec.status === 'paused' ||
      rec.status === 'stopping' || rec.status === 'transcribing');
    // While recording, the Record control stays put (it doubles as Stop); otherwise the
    // control reflects whether the user is typing (Add) or not (Record).
    if (add) add.hidden = recActive || !hasText;
    if (recBtn) recBtn.hidden = !recActive && hasText;
  }
  // Compact quick-note submit: same create-without-navigate + toast.
  function onCompactNote(e) {
    if (e) e.preventDefault();
    const inp = $('compact-input'); if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    quickCreate(v, '');
    inp.value = '';
    inp.focus();
    toast('Note added');
  }
  function onGlobalKeydown(e) {
    if (e.key === 'Escape') closeContextMenu();
  }
  function onGlobalPointerDown(e) {
    const menu = $('ctx-menu');
    if (menu && !menu.hidden && !menu.contains(e.target)) closeContextMenu();
  }
  function onWindowScroll() { closeContextMenu(); }
  function onOpenSettings(e) { if (e) e.preventDefault(); showSettings('appearance'); }
  function onSettingsBack(e) { if (e) e.preventDefault(); showApp(); }
  function onSettingsTab(e) {
    const item = e.currentTarget;
    const tab = item.getAttribute('data-tab');
    e.preventDefault();
    showSettings(tab);
  }
  function onThemeCard(e) {
    const card = e.currentTarget;
    setTheme(card.getAttribute('data-theme'));
  }
  // Pause/resume toggles (home record control + the persistent pill share the logic).
  function onRecPauseToggle(e) {
    if (e) e.preventDefault();
    if (rec.status === 'recording') pauseRecording();
    else if (rec.status === 'paused') resumeRecording();
  }
  function onRecPillStop(e) { if (e) e.preventDefault(); stopRecording(); }

  function bind() {
    const titleEl = $('editor-title'), bodyEl = $('editor-body');
    if (titleEl) { titleEl.addEventListener('input', onTitleInput); titleEl.addEventListener('blur', onEditorBlur); }
    if (bodyEl) { bodyEl.addEventListener('input', onBodyInput); bodyEl.addEventListener('blur', onEditorBlur); }

    const search = $('search-input');
    if (search) search.addEventListener('input', onSearchInput);

    const nn = $('new-note'); if (nn) nn.addEventListener('click', onNewNote);
    const en = $('empty-new'); if (en) en.addEventListener('click', onNewNote);
    const del = $('note-delete'); if (del) del.addEventListener('click', onDelete);

    // Home + compact + minimize.
    const home = $('nav-home'); if (home) home.addEventListener('click', onOpenHome);
    const chatNav = $('nav-chat'); if (chatNav) chatNav.addEventListener('click', onOpenChat);
    const labelsNav = $('nav-labels'); if (labelsNav) labelsNav.addEventListener('click', onOpenLabels);
    const winMin = $('win-min'); if (winMin) winMin.addEventListener('click', onMinimize);
    const cExpand = $('compact-expand'); if (cExpand) cExpand.addEventListener('click', onCompactExpand);
    const qnForm = $('qn-form'); if (qnForm) qnForm.addEventListener('submit', onQuickNote);
    const qnInput = $('qn-input'); if (qnInput) qnInput.addEventListener('input', onQnInput);
    const cForm = $('compact-form'); if (cForm) cForm.addEventListener('submit', onCompactNote);
    const chatForm = $('chat-form'); if (chatForm) chatForm.addEventListener('submit', onChatSubmit);
    const labelForm = $('label-create-form'); if (labelForm) labelForm.addEventListener('submit', onLabelCreate);
    const recBtn = $('rec-btn'); if (recBtn) recBtn.addEventListener('click', onRecordClick);
    const pillPause = $('rec-pill-pause'); if (pillPause) pillPause.addEventListener('click', onRecPauseToggle);
    const pillStop = $('rec-pill-stop'); if (pillStop) pillStop.addEventListener('click', onRecPillStop);
    const machinesMore = $('machines-more'); if (machinesMore) machinesMore.addEventListener('click', onMachinesMore);
    const allNotes = $('home-all-notes'); if (allNotes) allNotes.addEventListener('click', onAllNotes);

    // Context menu items + global close handlers.
    document.querySelectorAll('.ctx-item[data-act]').forEach(it => it.addEventListener('click', onCtxAction));
    document.addEventListener('keydown', onGlobalKeydown);
    document.addEventListener('pointerdown', onGlobalPointerDown, true);
    window.addEventListener('scroll', onWindowScroll, true);

    const openSet = $('open-settings'); if (openSet) openSet.addEventListener('click', onOpenSettings);
    const back = $('settings-back'); if (back) back.addEventListener('click', onSettingsBack);
    document.querySelectorAll('.set-item[data-tab]').forEach(s => s.addEventListener('click', onSettingsTab));
    document.querySelectorAll('.theme-card[data-theme]').forEach(c => c.addEventListener('click', onThemeCard));

    initRecButton();
  }

  function unbind() {
    const titleEl = $('editor-title'), bodyEl = $('editor-body');
    if (titleEl) { titleEl.removeEventListener('input', onTitleInput); titleEl.removeEventListener('blur', onEditorBlur); }
    if (bodyEl) { bodyEl.removeEventListener('input', onBodyInput); bodyEl.removeEventListener('blur', onEditorBlur); }
    const search = $('search-input'); if (search) search.removeEventListener('input', onSearchInput);
    const nn = $('new-note'); if (nn) nn.removeEventListener('click', onNewNote);
    const en = $('empty-new'); if (en) en.removeEventListener('click', onNewNote);
    const del = $('note-delete'); if (del) del.removeEventListener('click', onDelete);
    const home = $('nav-home'); if (home) home.removeEventListener('click', onOpenHome);
    const chatNav = $('nav-chat'); if (chatNav) chatNav.removeEventListener('click', onOpenChat);
    const labelsNav = $('nav-labels'); if (labelsNav) labelsNav.removeEventListener('click', onOpenLabels);
    const winMin = $('win-min'); if (winMin) winMin.removeEventListener('click', onMinimize);
    const cExpand = $('compact-expand'); if (cExpand) cExpand.removeEventListener('click', onCompactExpand);
    const qnForm = $('qn-form'); if (qnForm) qnForm.removeEventListener('submit', onQuickNote);
    const qnInput = $('qn-input'); if (qnInput) qnInput.removeEventListener('input', onQnInput);
    const cForm = $('compact-form'); if (cForm) cForm.removeEventListener('submit', onCompactNote);
    const chatForm = $('chat-form'); if (chatForm) chatForm.removeEventListener('submit', onChatSubmit);
    const labelForm = $('label-create-form'); if (labelForm) labelForm.removeEventListener('submit', onLabelCreate);
    const recBtn = $('rec-btn'); if (recBtn) recBtn.removeEventListener('click', onRecordClick);
    const pillPause = $('rec-pill-pause'); if (pillPause) pillPause.removeEventListener('click', onRecPauseToggle);
    const pillStop = $('rec-pill-stop'); if (pillStop) pillStop.removeEventListener('click', onRecPillStop);
    const machinesMore = $('machines-more'); if (machinesMore) machinesMore.removeEventListener('click', onMachinesMore);
    const allNotes = $('home-all-notes'); if (allNotes) allNotes.removeEventListener('click', onAllNotes);
    document.querySelectorAll('.ctx-item[data-act]').forEach(it => it.removeEventListener('click', onCtxAction));
    document.removeEventListener('keydown', onGlobalKeydown);
    document.removeEventListener('pointerdown', onGlobalPointerDown, true);
    window.removeEventListener('scroll', onWindowScroll, true);
    const openSet = $('open-settings'); if (openSet) openSet.removeEventListener('click', onOpenSettings);
    const back = $('settings-back'); if (back) back.removeEventListener('click', onSettingsBack);
    document.querySelectorAll('.set-item[data-tab]').forEach(s => s.removeEventListener('click', onSettingsTab));
    document.querySelectorAll('.theme-card[data-theme]').forEach(c => c.removeEventListener('click', onThemeCard));
  }

  // ------------------------------------------------------------------ boot / hydrate
  // Adopt a boot payload into the model. Preserves the current selection when possible
  // and otherwise selects the newest note. Used by both initial load and host hydrate.
  function adopt(boot) {
    const b = boot || {};
    state.notes = Array.isArray(b.notes) ? b.notes.map(normalizeNote) : [];
    state.labels = normalizeLabelList([].concat(Array.isArray(b.labels) ? b.labels : [], state.notes.flatMap(note => note.labels || [])));
    state.machines = Array.isArray(b.machines)
      ? b.machines.map(normalizeMachine).filter(m => m.id)
      : [];
    state.thisMachine = b.thisMachine || state.thisMachine || 'unknown';
    if (b.settings && Number(b.settings.trashRetentionDays) > 0) {
      state.settings.trashRetentionDays = Number(b.settings.trashRetentionDays);
    }
    const limit = b.listDefaults && Number(b.listDefaults.limit);
    state.noteListLimit = limit > 0 ? limit : 6;
    state.machineListLimit = 4;

    // Keep the open note if it still exists; else newest visible; else null.
    if (!noteById(state.selectedId)) {
      const v = visibleNotes();
      state.selectedId = v.length ? v[0].id : null;
    }
    notifyExpiredTrashReady();
  }

  function normalizeMachine(m) {
    if (typeof m === 'string') m = { id: m };
    m = m || {};
    return {
      id: String(m.id || m.slug || ''),
      slug: m.slug || m.id || '',
      displayName: m.displayName || m.friendlyName || m.id || m.slug || '',
      friendlyName: m.friendlyName || '',
      sshAddress: m.sshAddress || m.ssh || m.host || '',
      platform: m.platform || m.os || '',
      status: m.status || (m.online === true ? 'online' : (m.online === false ? 'offline' : 'unknown')),
      online: m.online == null ? null : !!m.online,
      source: m.source || '',
      origin: m.origin || '',
      updatedAt: m.updatedAt || '',
      lastSeenAt: m.lastSeenAt || '',
      syncedAt: m.syncedAt || '',
      recentActivityAt: m.recentActivityAt || '',
      noteCount: Number(m.noteCount || 0),
      activeNoteCount: Number(m.activeNoteCount || m.noteCount || 0),
      archivedNoteCount: Number(m.archivedNoteCount || 0),
      trashNoteCount: Number(m.trashNoteCount || 0),
      totalNoteCount: Number(m.totalNoteCount || m.noteCount || 0),
      latestNoteUpdatedAt: m.latestNoteUpdatedAt || '',
      capabilities: m.capabilities || [],
      metadata: m.metadata || {},
      provenance: m.provenance || {},
      sync: m.sync || {},
    };
  }

  function normalizeNote(n) {
    return {
      id: String(n.id),
	      title: n.title || '',
	      body: n.body || n.content || '',
	      content: n.content || n.body || '',
	      contentFormat: n.contentFormat || n.contentType || 'markdown',
	      contentPreview: n.contentPreview || '',
      labels: Array.isArray(n.labels) ? n.labels : (Array.isArray(n.tags) ? n.tags : []),
      status: n.status || 'active',
      folder: n.folder || '',
      machine: n.machine || 'unknown',
      updatedAt: n.updatedAt || new Date().toISOString(),
      createdAt: n.createdAt || n.updatedAt || new Date().toISOString(),
      createdByActorType: n.createdByActorType || 'human',
      createdByName: n.createdByName || '',
      sourceMachine: n.sourceMachine || n.machine || 'unknown',
      sourceMachineFriendlyName: n.sourceMachineFriendlyName || '',
      originMachine: n.originMachine || n.machine || 'unknown',
      originMachineFriendlyName: n.originMachineFriendlyName || '',
      targetMachineFriendlyName: n.targetMachineFriendlyName || '',
      previousMachine: n.previousMachine || '',
      openedFrom: n.openedFrom || '',
      sourceContext: n.sourceContext || '',
      archivedAt: n.archivedAt || '',
      trashedAt: n.trashedAt || '',
      trashMachine: n.trashMachine || '',
      trashExpiresAt: n.trashExpiresAt || '',
      restoredAt: n.restoredAt || '',
      movedAt: n.movedAt || '',
      info: n.info || null,
      titleLocked: !!n.titleLocked,
      titleSource: n.titleSource || (isDefaultTitle(n.title) ? 'default' : 'manual'),
      titleContentFingerprint: n.titleContentFingerprint || '',
    };
  }

  // Exposed to the native host: re-render from a fresh boot payload after a write.
  function hydrate(boot) {
    adopt(boot);
    render();
    queueAutoTitlesForStaleNotes();
  }

  function init() {
    if (started) return;
    started = true;
    state.screen = 'home';   // Home is the default landing screen.
    showApp();
    initTheme();
    adopt(window.__BOOT__ || sampleBoot());
    bind();
    render();
    queueAutoTitlesForStaleNotes();
  }

  function destroy() {
    if (!started) return;
    unbind();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (autoTitleTimer) { clearTimeout(autoTitleTimer); autoTitleTimer = null; }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    releaseRealtimeAudio();
    stopStream();
    try { if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.close(); } catch (e) {}
    closeContextMenu();
    started = false;
  }

  // Host → web: control the live recorder from the macOS menu-bar status item.
  // Contract: window.HasnaNotes.recCommand('stop'|'pause'|'resume').
	  function recCommand(cmd) {
	    if (cmd === 'stop') stopRecording();
	    else if (cmd === 'pause') pauseRecording();
	    else if (cmd === 'resume') resumeRecording();
	  }

  function chatSnapshot() {
    return {
      id: state.chat.id,
      status: state.chat.status,
      messages: state.chat.messages.slice(),
      toolCalls: state.chat.toolCalls.slice(),
      sources: state.chat.sources.slice(),
      pendingConfirmations: state.chat.pendingConfirmations.slice(),
      error: state.chat.error || '',
      goal: state.chat.goal,
    };
  }

  function emitChat(name, detail) {
    const payload = Object.assign({ chat: chatSnapshot() }, detail || {});
    window.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }

  function setChatStatus(status, extra) {
    state.chat.status = status;
    if (extra && extra.error != null) state.chat.error = String(extra.error || '');
    emitChat('hasna:chat-state', Object.assign({ status }, extra || {}));
  }

  function chatNoteRef(note) {
    return {
      id: note.id,
      title: note.title || 'Untitled Note',
      updatedAt: note.updatedAt || '',
      createdAt: note.createdAt || '',
      labels: noteLabels(note),
      status: note.status || 'active',
      machine: note.machine || '',
    };
  }

  function chatPlain(note) {
    return markdownPlainText((note && (note.body || note.content)) || '');
  }

  function chatSearch(prompt, limit) {
    const raw = String(prompt || '').trim();
    const quoted = /["“]([^"”]+)["”]/.exec(raw);
    const about = /\b(?:about|for|on|related to)\s+(.+)$/i.exec(raw);
    const query = (quoted && quoted[1]) || (about && about[1]) || raw
      .replace(/\b(summarize|summary|search|find|notes?|please|show|list|consolidate|organize|combine|all|into|new|larger)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const q = query.toLowerCase();
    const notes = sortNotes(state.notes).filter(note => {
      if (note.status === 'trash') return false;
      if (!q) return note.status !== 'archived';
      return ((note.title || '') + ' ' + (note.body || '') + ' ' + noteLabels(note).join(' ')).toLowerCase().includes(q);
    });
    return { query, notes: notes.slice(0, Math.max(1, Number(limit || 10))) };
  }

  function chatPromptNoteId(prompt, opts) {
    const explicit = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.exec(String(prompt || ''));
    return (explicit && explicit[0]) || (opts && (opts.noteId || opts.selectedNoteId || opts.id)) || state.selectedId || '';
  }

  function chatStripValue(value) {
    return String(value || '')
      .replace(/[?.!]+$/, '')
      .replace(/\b(?:please|note|this|id|as|with|to|from)\b/gi, ' ')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function chatExtractLabel(prompt, opts) {
    if (opts && opts.label) return String(opts.label).trim();
    const text = String(prompt || '');
    const quoted = /\b(?:label|tag|unlabel|untag|remove\s+(?:label|tag))\b[^"“”]*["“]([^"”]+)["”]/i.exec(text);
    if (quoted) return quoted[1].trim();
    const m = /\b(?:label|tag|unlabel|untag|remove\s+(?:label|tag))\b\s+(.+)$/i.exec(text);
    return m ? chatStripValue(m[1]) : '';
  }

  function chatExtractUpdate(prompt, opts) {
    const text = String(prompt || '');
    const title = opts && opts.title != null ? opts.title : /(?:^|\b)title\s*[:=]\s*([^\n]+)/i.exec(text)?.[1]?.trim();
    const body = opts && opts.body != null ? opts.body : /(?:^|\b)(?:body|text|content)\s*[:=]\s*([\s\S]+)$/i.exec(text)?.[1]?.trim();
    if (title != null || body != null) return { title, body };
    const id = chatPromptNoteId(text, opts || {});
    const after = id ? text.slice(Math.max(0, text.indexOf(id) + id.length)).trim() : '';
    const cleaned = after.replace(/^(?:to|with|as|note|body|text|content)\b[:\s-]*/i, '').trim();
    return cleaned ? { body: cleaned } : {};
  }

  function chatFriendlyInfo(note) {
    return Object.assign({ id: note.id, title: note.title || 'Untitled Note' }, noteInfo(note.id) || {});
  }

  function saveChatNote(note, eventName) {
    note.updatedAt = new Date().toISOString();
    postNative('save', serializeNote(note));
    if (eventName) dispatchNoteEvent(eventName, note);
    render();
    return note;
  }

  function applyChatLabel(note, label, remove, dryRun) {
    const labels = noteLabels(note);
    if (dryRun) {
      return {
        dryRun: true,
        preview: { id: note.id, label, action: remove ? 'unassign' : 'assign', beforeLabels: labels },
        sources: [chatNoteRef(note)],
      };
    }
    note.labels = remove ? labels.filter(item => item.toLowerCase() !== label.toLowerCase()) : Array.from(new Set([...labels, label]));
    saveChatNote(note, remove ? 'hasna:note-unlabel' : 'hasna:note-label');
    return { note: chatNoteRef(note), sources: [chatNoteRef(note)] };
  }

  function chatSummary(notes) {
    if (!notes.length) return 'No matching notes found.';
    return 'Summary of ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + ':\n' +
      notes.map(note => '- ' + ((note.title && note.title.trim()) || 'Untitled Note') + ': ' + (chatPlain(note).slice(0, 220) || 'No body text.')).join('\n');
  }

  function chatConsolidatedBody(notes, title) {
    return '# ' + title + '\n\n' + notes.map(note => {
      return '## ' + ((note.title && note.title.trim()) || 'Untitled Note') + '\n\n' +
        ((note.body || '').trim() || '_No note body._') + '\n\n_Source: ' + note.id + '_';
    }).join('\n\n') + '\n';
  }

  function addChatToolCall(name, input) {
    const call = { id: 'tool-' + (state.chat.toolCalls.length + 1), name, input, state: 'call' };
    state.chat.toolCalls.push(call);
    emitChat('hasna:chat-tool-call', { toolCall: call });
    return call;
  }

  function finishChatToolCall(call, result, stateName) {
    call.state = stateName || 'result';
    call.result = result;
    emitChat('hasna:chat-tool-result', { toolCall: call });
  }

  function queueChatApproval(toolName, call, input, preview) {
    const approval = {
      id: 'approval-' + toolName + '-' + Date.now(),
      toolCallId: call.id,
      toolName,
      input,
      preview,
    };
    state.chat.pendingConfirmations.push(approval);
    finishChatToolCall(call, { requiresConfirmation: true, approval, preview }, 'approval-requested');
    emitChat('hasna:chat-confirmation', { approval });
    return approval;
  }

  function chatMessageText(message) {
    if (!message) return '';
    if (Array.isArray(message.parts)) {
      return message.parts.filter(part => part && part.type === 'text').map(part => part.text || '').join('\n');
    }
    return String(message.text || message.content || '');
  }

  function setChatMessageText(message, text) {
    if (!message.parts) message.parts = [{ type: 'text', text: '' }];
    if (!message.parts.length) message.parts.push({ type: 'text', text: '' });
    message.parts[0].type = 'text';
    message.parts[0].text = String(text || '');
  }

  function renderChatPage() {
    const status = $('chat-status');
    if (status) status.textContent = state.chat.status.replace(/_/g, ' ');
    renderChatGoal();
    renderChatLog();
    renderChatTools();
    renderChatSources();
    renderChatApprovals();
  }

  function renderChatLog() {
    const host = $('chat-log');
    if (!host) return;
    host.innerHTML = '';
    if (!state.chat.messages.length) {
      host.appendChild(el('div', 'chat-empty', 'No messages'));
      return;
    }
    state.chat.messages.forEach(message => {
      const row = el('div', 'chat-msg chat-' + (message.role || 'assistant'));
      row.appendChild(el('div', 'chat-role', message.role === 'user' ? 'You' : 'Hasna'));
      row.appendChild(el('div', 'chat-text', chatMessageText(message)));
      host.appendChild(row);
    });
    host.scrollTop = host.scrollHeight || 0;
  }

  function renderChatTools() {
    const host = $('chat-tools');
    if (!host) return;
    host.innerHTML = '';
    host.hidden = state.chat.toolCalls.length === 0;
    state.chat.toolCalls.forEach(call => {
      const row = el('div', 'ct-row');
      row.appendChild(el('div', 'ct-name', call.name || call.toolName || 'tool'));
      row.appendChild(el('div', 'ct-state', call.state || 'call'));
      const input = el('pre', 'ct-json', JSON.stringify(call.input || {}, null, 2));
      row.appendChild(input);
      if (call.result) row.appendChild(el('pre', 'ct-json ct-result', JSON.stringify(call.result, null, 2).slice(0, 1600)));
      host.appendChild(row);
    });
  }

  function renderChatSources() {
    const host = $('chat-sources');
    if (!host) return;
    host.innerHTML = '';
    host.hidden = state.chat.sources.length === 0;
    state.chat.sources.forEach(source => {
      const btn = el('button', 'cs-item');
      btn.type = 'button';
      btn.textContent = (source.title || 'Untitled Note') + (source.id ? ' · ' + source.id.slice(0, 8) : '');
      btn.addEventListener('click', () => { if (source.id) selectNote(source.id); });
      host.appendChild(btn);
    });
  }

  function renderChatApprovals() {
    const host = $('chat-approvals');
    if (!host) return;
    host.innerHTML = '';
    host.hidden = state.chat.pendingConfirmations.length === 0;
    state.chat.pendingConfirmations.forEach(approval => {
      const row = el('div', 'ca-row');
      row.appendChild(el('div', 'ca-title', approval.toolName || 'Approval'));
      row.appendChild(el('pre', 'ca-preview', JSON.stringify(approval.preview || approval.input || {}, null, 2).slice(0, 1600)));
      const actions = el('div', 'ca-actions');
      const approve = el('button', 'ca-btn ca-primary', 'Approve');
      approve.type = 'button';
      approve.addEventListener('click', () => {
        const out = approveChat(approval.id, true);
        if (out && typeof out.then === 'function') out.catch(err => toast(err.message || String(err)));
      });
      const cancel = el('button', 'ca-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => approveChat(approval.id, false));
      actions.appendChild(approve);
      actions.appendChild(cancel);
      row.appendChild(actions);
      host.appendChild(row);
    });
  }

  function renderChatGoal() {
    const card = $('goal-card');
    if (!card) return;
    const goal = state.chat.goal;
    card.hidden = !goal;
    if (!goal) return;
    const title = $('goal-title');
    const stateEl = $('goal-state');
    const steps = $('goal-steps');
    if (title) title.textContent = goal.objective || '';
    if (stateEl) stateEl.textContent = goal.status || 'running';
    if (steps) {
      steps.innerHTML = '';
      (goal.steps || []).forEach(step => {
        const row = el('div', 'goal-step');
        row.appendChild(el('span', 'goal-step-n', String(step.stepNumber || '')));
        row.appendChild(el('span', 'goal-step-text', step.toolCall ? (step.toolCall.name || 'tool') : (step.text || step.status || 'step')));
        row.appendChild(el('span', 'goal-step-status', step.status || 'running'));
        steps.appendChild(row);
      });
    }
  }

  function mergeChatLabels(labels) {
    if (!Array.isArray(labels)) return;
    state.labels = normalizeLabelList(labels);
    renderLabels();
    if (state.screen === 'labels') renderLabelsPage();
  }

  function mergeChatNote(note) {
    if (!note || !note.id) return;
    const normalized = normalizeNote(note);
    const idx = state.notes.findIndex(item => item.id === normalized.id);
    if (idx >= 0) state.notes[idx] = Object.assign(state.notes[idx], normalized);
    else state.notes.push(normalized);
    rememberLabels(normalized.labels || []);
    renderLabels();
    renderNotesList();
    renderHome();
    if (state.screen === 'noteslist') renderNotesPage();
    if (state.screen === 'labels') renderLabelsPage();
  }

  function mergeChatToolOutput(output) {
    if (!output || typeof output !== 'object') return;
    if (output.note) mergeChatNote(output.note);
    if (Array.isArray(output.labels)) mergeChatLabels(output.labels);
    if (Array.isArray(output.sources)) state.chat.sources = output.sources;
  }

  function sendLocalChat(prompt, options) {
    const text = String(prompt || '').trim();
    if (!text) return Promise.reject(new Error('prompt_required'));
    const opts = options || {};
    const goalObjective = !opts._skipGoalParsing && parseChatGoalCommand(text);
    if (goalObjective) return sendLocalGoalChat(goalObjective, opts);
    if (!opts._skipGoalParsing) state.chat.goal = null;
    const userMessage = { id: 'msg-' + Date.now(), role: 'user', parts: [{ type: 'text', text }] };
    state.chat.messages.push(userMessage);
    state.chat.toolCalls = [];
    state.chat.sources = [];
    state.chat.pendingConfirmations = [];
    state.chat.error = '';
    emitChat('hasna:chat-message', { message: userMessage });
    setChatStatus('submitted');
    setChatStatus('streaming');

    return Promise.resolve().then(() => {
      const lower = text.toLowerCase();
      const search = chatSearch(text, opts.limit || 10);
      const id = chatPromptNoteId(text, opts);
      const note = id ? noteById(id) : null;
      let answer = '';
      let sources = [];

      if (/\b(consolidate|organize|roll up|combine)\b/.test(lower)) {
        const call = addChatToolCall('consolidate_notes', { query: search.query, dryRun: !opts.confirm });
        sources = search.notes.map(chatNoteRef);
        const title = opts.title || 'Consolidated Notes';
        const body = chatConsolidatedBody(search.notes, title);
        const approval = {
          id: 'approval-consolidate-' + Date.now(),
          toolName: 'consolidate_notes',
          input: { title, body, labels: ['consolidated'] },
          preview: { title, noteCount: search.notes.length, bodyPreview: body.slice(0, 1200), sources },
        };
        if (opts.confirm) {
          const note = quickCreate(title, body, {
            labels: ['consolidated'],
            createdByActorType: 'agent',
            createdByName: opts.actorName || 'Hasna Notes Chat',
            openedFrom: 'chat',
            sourceContext: text.slice(0, 200),
          });
          answer = 'Created consolidated note "' + (note.title || title) + '" from ' + sources.length + ' note(s).';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          approval.toolCallId = call.id;
          state.chat.pendingConfirmations.push(approval);
          answer = 'I prepared a consolidation preview from ' + search.notes.length + ' note(s). Approve it to create "' + title + '".';
          finishChatToolCall(call, { requiresConfirmation: true, approval }, 'approval-requested');
          emitChat('hasna:chat-confirmation', { approval });
        }
      } else if (/\b(summarize|summary|recap)\b/.test(lower)) {
        const call = addChatToolCall('summarize_notes', { query: search.query });
        answer = chatSummary(search.notes);
        sources = search.notes.map(chatNoteRef);
        finishChatToolCall(call, { summary: answer, sources }, 'result');
      } else if (/\b(info|metadata|provenance|details)\b/.test(lower) && note) {
        const call = addChatToolCall('note_info', { id: note.id });
        const info = chatFriendlyInfo(note);
        sources = [chatNoteRef(note)];
        answer = [
          info.title + ' (' + info.id + ')',
          'Created by ' + info.createdBy + ' (' + info.createdByActorType + ')',
          info.createdAt ? 'Created ' + info.createdAt : '',
          info.currentMachine ? 'Machine ' + info.currentMachine : '',
          info.openedFrom ? 'Opened from ' + info.openedFrom : '',
        ].filter(Boolean).join('\n');
        finishChatToolCall(call, { info, sources }, 'result');
      } else if (/\b(read|open|show|get)\b/.test(lower) && note) {
        const call = addChatToolCall('read_note', { id: note.id });
        sources = [chatNoteRef(note)];
        answer = '# ' + ((note.title && note.title.trim()) || 'Untitled Note') + '\n\n' + (note.body || '');
        finishChatToolCall(call, { note: serializeNote(note), sources }, 'result');
      } else if (/\b(update|edit|replace)\b/.test(lower) && note) {
        const patch = chatExtractUpdate(text, opts);
        const call = addChatToolCall('update_note', Object.assign({ id: note.id, dryRun: !opts.confirm }, patch));
        sources = [chatNoteRef(note)];
        if (opts.confirm) {
          if (patch.title != null) note.title = String(patch.title);
          if (patch.body != null) note.body = String(patch.body);
          saveChatNote(note, 'hasna:note-update');
          answer = 'Updated "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          queueChatApproval('update_note', call, Object.assign({ id: note.id }, patch), {
            id: note.id,
            before: { title: note.title, bodyPreview: chatPlain(note).slice(0, 240) },
            after: { title: patch.title == null ? note.title : patch.title, bodyPreview: String(patch.body == null ? note.body : patch.body).slice(0, 240) },
          });
          answer = 'Update preview ready for ' + note.id + '.';
        }
      } else if (/\bappend\b/.test(lower) && note) {
        const patch = { text: opts.text || text.replace(/^.*?\bappend\b/i, '').replace(note.id, '').trim() };
        const call = addChatToolCall('append_note', { id: note.id, text: patch.text, dryRun: !opts.confirm });
        sources = [chatNoteRef(note)];
        if (opts.confirm) {
          note.body = [note.body || '', patch.text].filter(Boolean).join('\n\n');
          saveChatNote(note, 'hasna:note-update');
          answer = 'Appended text to "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          queueChatApproval('append_note', call, { id: note.id, text: patch.text }, {
            id: note.id,
            appendText: patch.text,
            resultingLength: (note.body || '').length + patch.text.length + 2,
          });
          answer = 'Append preview ready for ' + note.id + '.';
        }
      } else if (/\b(unlabel|untag|remove\s+(?:label|tag))\b/.test(lower) && note) {
        const label = chatExtractLabel(text, opts);
        const call = addChatToolCall('unlabel_note', { id: note.id, label, dryRun: !!opts.dryRun });
        const result = applyChatLabel(note, label, true, opts.dryRun);
        sources = result.sources;
        answer = result.dryRun ? 'Unlabel preview ready for ' + note.id + '.' : 'Removed label "' + label + '" from "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
        finishChatToolCall(call, result, 'result');
      } else if (/\b(label|tag)\b/.test(lower) && note) {
        const label = chatExtractLabel(text, opts);
        const call = addChatToolCall('label_note', { id: note.id, label, dryRun: !!opts.dryRun });
        const result = applyChatLabel(note, label, false, opts.dryRun);
        sources = result.sources;
        answer = result.dryRun ? 'Label preview ready for ' + note.id + '.' : 'Added label "' + label + '" to "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
        finishChatToolCall(call, result, 'result');
      } else if (/\barchive\b/.test(lower) && note) {
        const call = addChatToolCall('archive_note', { id: note.id, dryRun: !opts.confirm });
        sources = [chatNoteRef(note)];
        if (opts.confirm) {
          archiveNote(note.id);
          answer = 'Archived "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          queueChatApproval('archive_note', call, { id: note.id }, { id: note.id, title: note.title, fromStatus: note.status, toStatus: 'archived' });
          answer = 'Archive preview ready for ' + note.id + '.';
        }
      } else if (/\b(trash|delete)\b/.test(lower) && note) {
        const call = addChatToolCall('trash_note', { id: note.id, dryRun: !opts.confirm });
        sources = [chatNoteRef(note)];
        if (opts.confirm) {
          trashNote(note, { confirmed: true });
          render();
          answer = 'Moved "' + ((note.title && note.title.trim()) || 'Untitled Note') + '" to Trash.';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          queueChatApproval('trash_note', call, { id: note.id }, { id: note.id, title: note.title, fromStatus: note.status, toStatus: 'trash' });
          answer = 'Trash preview ready for ' + note.id + '.';
        }
      } else if (/\brestore\b/.test(lower) && note) {
        const call = addChatToolCall('restore_note', { id: note.id, dryRun: !opts.confirm });
        sources = [chatNoteRef(note)];
        if (opts.confirm) {
          restoreNote(note.id);
          answer = 'Restored "' + ((note.title && note.title.trim()) || 'Untitled Note') + '".';
          finishChatToolCall(call, { note: chatNoteRef(note), sources }, 'result');
        } else {
          queueChatApproval('restore_note', call, { id: note.id }, { id: note.id, title: note.title, fromStatus: note.status, toStatus: 'active' });
          answer = 'Restore preview ready for ' + note.id + '.';
        }
      } else {
        const call = addChatToolCall(search.query ? 'search_notes' : 'list_notes', { query: search.query });
        answer = search.notes.length
          ? 'Found notes:\n' + search.notes.map(note => '- ' + ((note.title && note.title.trim()) || 'Untitled Note') + ' (' + note.id + ')').join('\n')
          : 'No matching notes found.';
        sources = search.notes.map(chatNoteRef);
        finishChatToolCall(call, { items: sources, sources }, 'result');
      }

      state.chat.sources = sources;
      const assistantMessage = { id: 'msg-' + Date.now() + '-assistant', role: 'assistant', parts: [{ type: 'text', text: answer }], metadata: { sources } };
      state.chat.messages.push(assistantMessage);
      emitChat('hasna:chat-delta', { text: answer });
      emitChat('hasna:chat-sources', { sources });
      emitChat('hasna:chat-message', { message: assistantMessage });
      const result = { message: assistantMessage, text: answer, sources, pendingConfirmations: state.chat.pendingConfirmations.slice(), toolCalls: state.chat.toolCalls.slice() };
      emitChat('hasna:chat-finish', result);
      setChatStatus(state.chat.pendingConfirmations.length ? 'awaiting_confirmation' : 'ready');
      return result;
    }).catch(err => {
      setChatStatus('error', { error: err.message || String(err) });
      emitChat('hasna:chat-error', { error: err.message || String(err) });
      throw err;
    });
  }

  function parseChatGoalCommand(prompt) {
    const m = /^\/goal(?:\s+begin)?\s+([\s\S]+)$/i.exec(String(prompt || '').trim());
    return m ? m[1].trim() : '';
  }

  function localGoalTerminalText(text) {
    const value = String(text || '').toLowerCase();
    if (/\b(needs? (user )?input|need you to|please provide|which note|what label|what machine|which machine)\b/.test(value)) return 'needs_input';
    if (/\b(blocked|cannot continue|not possible|unable to proceed)\b/.test(value)) return 'blocked';
    return '';
  }

  function localGoalComplete(objective, result, stepIndex) {
    const toolCalls = result.toolCalls || [];
    const mutating = new Set(['create_note', 'update_note', 'append_note', 'label_note', 'unlabel_note', 'archive_note', 'trash_note', 'restore_note', 'move_note', 'create_label', 'update_label', 'delete_label', 'consolidate_notes']);
    const mutatingSuccess = toolCalls.some(call => mutating.has(call.name) && call.state === 'result' && !(call.result && (call.result.requiresConfirmation || call.result.dryRun)));
    if (mutatingSuccess) return true;
    const readIntent = /\b(summarize|summary|search|find|list|read|show|info|metadata|provenance|related|similar)\b/i.test(objective);
    const readTool = toolCalls.some(call => ['list_notes', 'search_notes', 'read_note', 'summarize_notes', 'find_related_notes', 'note_info', 'list_labels'].includes(call.name));
    return readIntent && readTool && stepIndex > 0;
  }

  function localGoalFollowup(objective, stepNumber, previous) {
    return [
      'Continue this Hasna Notes goal until it is achieved, needs user input, or is clearly blocked.',
      'Goal: ' + objective,
      'Step ' + stepNumber + ': inspect or use the safest next notes or labels operation. Do not repeat a completed step.',
      previous && previous.text ? 'Previous result:\n' + previous.text.slice(0, 900) : '',
    ].filter(Boolean).join('\n');
  }

  function sendLocalGoalChat(objective, options) {
    const goal = {
      id: 'goal-local-' + Date.now(),
      objective: String(objective || '').trim(),
      status: 'running',
      maxSteps: Math.max(1, Number((options && options.maxSteps) || 4)),
      steps: [],
    };
    state.chat.goal = goal;
    emitChat('hasna:chat-goal-state', { goal });
    renderChatGoal();
    let previous = null;
    let chain = Promise.resolve();
    for (let i = 0; i < goal.maxSteps; i += 1) {
      chain = chain.then(done => {
        if (done) return done;
        const stepNumber = i + 1;
        const prompt = i === 0 ? goal.objective : localGoalFollowup(goal.objective, stepNumber, previous);
        const runningStep = { stepNumber, status: 'running', text: prompt };
        goal.steps.push(runningStep);
        emitChat('hasna:chat-goal-state', { goal });
        renderChatGoal();
        return sendLocalChat(prompt, Object.assign({}, options || {}, { _skipGoalParsing: true })).then(result => {
          previous = result;
          const terminal = localGoalTerminalText(result.text);
          runningStep.status = result.pendingConfirmations && result.pendingConfirmations.length ? 'needs_input' : (terminal || 'complete');
          runningStep.text = result.text;
          runningStep.toolCalls = result.toolCalls || [];
          if (runningStep.status === 'needs_input') goal.status = 'needs_input';
          else if (runningStep.status === 'blocked') goal.status = 'blocked';
          else if (localGoalComplete(goal.objective, result, i)) goal.status = 'done';
          if (goal.status !== 'running') {
            state.chat.goal = goal;
            result.goal = goal;
            result.mode = 'goal';
            emitChat('hasna:chat-goal-state', { goal });
            renderChatPage();
            return result;
          }
          state.chat.goal = goal;
          emitChat('hasna:chat-goal-state', { goal });
          renderChatGoal();
          return null;
        });
      });
    }
    return chain.then(result => {
      if (result) return result;
      goal.status = 'blocked';
      goal.blocker = 'Stopped after ' + goal.maxSteps + ' goal steps without a clear completion signal.';
      state.chat.goal = goal;
      const blocked = previous || { text: goal.blocker, toolCalls: [], sources: [], pendingConfirmations: [] };
      blocked.text = goal.blocker;
      blocked.goal = goal;
      blocked.mode = 'goal';
      emitChat('hasna:chat-goal-state', { goal });
      renderChatPage();
      return blocked;
    });
  }

  function addSidecarApproval(approval, call) {
    if (!approval || !approval.id) return;
    if (state.chat.pendingConfirmations.some(item => item.id === approval.id)) return;
    const enriched = Object.assign({ sidecar: true, toolCallId: call && call.id }, approval);
    if (!enriched.toolCallId && call) enriched.toolCallId = call.id;
    state.chat.pendingConfirmations.push(enriched);
    emitChat('hasna:chat-confirmation', { approval: enriched });
  }

  function handleSidecarEvent(event, assistantMessage, acc) {
    if (!event || !event.type) return;
    if (event.type === 'text-delta') {
      acc.text += event.text || '';
      setChatMessageText(assistantMessage, acc.text);
      emitChat('hasna:chat-delta', { text: event.text || '' });
      renderChatLog();
      return;
    }
    if (event.type === 'tool-call') {
      const call = event.toolCall || { id: event.toolCallId, name: event.toolName, input: event.input, state: 'call', sidecar: true };
      call.id = call.id || event.toolCallId || ('tool-' + (state.chat.toolCalls.length + 1));
      call.name = call.name || event.toolName;
      call.state = call.state || 'call';
      call.sidecar = true;
      state.chat.toolCalls.push(call);
      emitChat('hasna:chat-tool-call', { toolCall: call });
      renderChatTools();
      return;
    }
    if (event.type === 'tool-result') {
      const call = state.chat.toolCalls.find(item => item.id === event.toolCallId) || state.chat.toolCalls[state.chat.toolCalls.length - 1];
      if (call) {
        call.state = event.output && event.output.requiresConfirmation ? 'approval-requested' : 'result';
        call.result = event.output;
        emitChat('hasna:chat-tool-result', { toolCall: call });
      }
      mergeChatToolOutput(event.output);
      renderChatTools();
      renderChatSources();
      return;
    }
    if (event.type === 'confirmation') {
      const call = state.chat.toolCalls[state.chat.toolCalls.length - 1];
      addSidecarApproval(event.approval, call);
      renderChatApprovals();
      return;
    }
    if (event.type === 'goal-state') {
      state.chat.goal = event.goal;
      renderChatGoal();
      return;
    }
    if (event.type === 'goal-step') {
      const goal = state.chat.goal || { objective: parseChatGoalCommand(acc.prompt), status: 'running', steps: [] };
      const existing = (goal.steps || []).find(step => step.stepNumber === event.stepNumber);
      if (existing) Object.assign(existing, event);
      else goal.steps = (goal.steps || []).concat([event]);
      state.chat.goal = goal;
      renderChatGoal();
      return;
    }
    if (event.type === 'finish') {
      if (!acc.text && event.text) {
        acc.text = event.text;
        setChatMessageText(assistantMessage, acc.text);
      }
      state.chat.messages.forEach(message => { if (message.sidecarPending) delete message.sidecarPending; });
      if (event.goal) state.chat.goal = event.goal;
      (event.pendingConfirmations || []).forEach(approval => addSidecarApproval(approval, state.chat.toolCalls[state.chat.toolCalls.length - 1]));
      emitChat('hasna:chat-sources', { sources: state.chat.sources });
      emitChat('hasna:chat-message', { message: assistantMessage });
      const result = {
        message: assistantMessage,
        text: acc.text,
        sources: state.chat.sources.slice(),
        pendingConfirmations: state.chat.pendingConfirmations.slice(),
        toolCalls: state.chat.toolCalls.slice(),
        goal: state.chat.goal,
      };
      emitChat('hasna:chat-finish', result);
      setChatStatus(state.chat.pendingConfirmations.length ? 'awaiting_confirmation' : 'ready');
      renderChatPage();
      acc.result = result;
      return;
    }
    if (event.type === 'error') {
      throw new Error(event.error || 'chat_failed');
    }
  }

  async function sendSidecarChat(prompt, options) {
    if (!window.fetch || !window.TextDecoder) throw new Error('fetch_unavailable');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('prompt_required');
    const opts = options || {};
    const goalObjective = parseChatGoalCommand(text);
    const userMessage = { id: 'msg-' + Date.now(), role: 'user', parts: [{ type: 'text', text }], sidecarPending: true };
    const assistantMessage = { id: 'msg-' + Date.now() + '-assistant', role: 'assistant', parts: [{ type: 'text', text: '' }], metadata: {}, sidecarPending: true };
    state.chat.messages.push(userMessage);
    state.chat.messages.push(assistantMessage);
    state.chat.toolCalls = [];
    state.chat.sources = [];
    state.chat.pendingConfirmations = [];
    state.chat.error = '';
    state.chat.goal = goalObjective ? { id: 'goal-local-' + Date.now(), objective: goalObjective, status: 'running', steps: [], maxSteps: opts.maxSteps || 10 } : null;
    emitChat('hasna:chat-message', { message: userMessage });
    setChatStatus('submitted');
    setChatStatus('streaming');
    renderChatPage();

    const response = await fetch(aiURL('/chat'), {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({
        prompt: text,
        selectedNoteId: opts.noteId || opts.selectedNoteId || state.selectedId || '',
        labels: allLabels().map(item => item.name),
        maxSteps: opts.maxSteps || (goalObjective ? 10 : 8),
        actorName: opts.actorName || 'Hasna Notes Chat',
        goal: goalObjective ? { objective: goalObjective } : undefined,
      }),
    });
    if (!response.ok || !response.body) throw new Error('chat_sidecar_unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const acc = { text: '', prompt: text, result: null };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        handleSidecarEvent(JSON.parse(line), assistantMessage, acc);
      }
    }
    if (buffer.trim()) handleSidecarEvent(JSON.parse(buffer.trim()), assistantMessage, acc);
    return acc.result || {
      message: assistantMessage,
      text: acc.text,
      sources: state.chat.sources.slice(),
      pendingConfirmations: state.chat.pendingConfirmations.slice(),
      toolCalls: state.chat.toolCalls.slice(),
      goal: state.chat.goal,
    };
  }

  function sendChat(prompt, options) {
    const cfg = ai();
    if (cfg.available && cfg.port && window.fetch) {
      return sendSidecarChat(prompt, options).catch(err => {
        state.chat.messages = state.chat.messages.filter(message => !message.sidecarPending);
        setChatStatus('error', { error: err.message || String(err) });
        emitChat('hasna:chat-error', { error: err.message || String(err) });
        return sendLocalChat(prompt, options).then(result => { renderChatPage(); return result; });
      });
    }
    return sendLocalChat(prompt, options).then(result => { renderChatPage(); return result; });
  }

  async function approveSidecarChat(approval, approved, call) {
    if (!approved) {
      if (call) finishChatToolCall(call, { approved: false, approval }, 'cancelled');
      setChatStatus('ready');
      renderChatPage();
      emitChat('hasna:chat-finish', { approved: false, approval });
      return { approved: false, approval };
    }
    const response = await fetch(aiURL('/tool'), {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({
        name: approval.toolName,
        input: Object.assign({}, approval.input || {}, { confirm: true }),
        confirm: true,
        approvalId: approval.id,
        actorName: 'Hasna Notes Chat',
        openedFrom: 'chat-approval',
        sourceContext: approval.id,
      }),
    });
    if (!response.ok) throw new Error('approval_failed');
    const result = await response.json();
    mergeChatToolOutput(result);
    if (call) finishChatToolCall(call, { approved: true, result, approval }, 'result');
    setChatStatus('ready');
    renderChatPage();
    const out = { approved: true, result, approval, note: result.note ? chatNoteRef(result.note) : undefined };
    emitChat('hasna:chat-finish', out);
    return out;
  }

  function approveChat(approvalId, approved) {
    const approval = state.chat.pendingConfirmations.find(item => item.id === approvalId);
    if (!approval) return null;
    state.chat.pendingConfirmations = state.chat.pendingConfirmations.filter(item => item.id !== approvalId);
    const call = state.chat.toolCalls.find(item => item.id === approval.toolCallId);
    if (approval.sidecar) return approveSidecarChat(approval, approved, call);
    if (!approved) {
      if (call) finishChatToolCall(call, { approved: false, approval }, 'cancelled');
      setChatStatus('ready');
      emitChat('hasna:chat-finish', { approved: false, approval });
      return { approved: false, approval };
    }
    if (approval.toolName === 'consolidate_notes') {
      const input = approval.input || {};
      const note = quickCreate(input.title || 'Consolidated Notes', input.body || '', {
        labels: input.labels || ['consolidated'],
        createdByActorType: 'agent',
        createdByName: 'Hasna Notes Chat',
        openedFrom: 'chat',
        sourceContext: approval.id,
      });
      const result = { approved: true, note: chatNoteRef(note), approval };
      if (call) finishChatToolCall(call, result, 'result');
      else emitChat('hasna:chat-tool-result', { toolCall: { id: approval.id, name: approval.toolName, state: 'result', result } });
      emitChat('hasna:chat-finish', result);
      setChatStatus('ready');
      return result;
    }
    const input = approval.input || {};
    const note = input.id ? noteById(input.id) : null;
    if (note && approval.toolName === 'update_note') {
      if (input.title != null) note.title = String(input.title);
      if (input.body != null) note.body = String(input.body);
      saveChatNote(note, 'hasna:note-update');
    } else if (note && approval.toolName === 'append_note') {
      note.body = [note.body || '', input.text || ''].filter(Boolean).join('\n\n');
      saveChatNote(note, 'hasna:note-update');
    } else if (note && approval.toolName === 'archive_note') {
      archiveNote(note.id);
    } else if (note && approval.toolName === 'trash_note') {
      trashNote(note, { confirmed: true });
      render();
    } else if (note && approval.toolName === 'restore_note') {
      restoreNote(note.id);
    }
    if (note) {
      const result = { approved: true, note: chatNoteRef(note), approval };
      if (call) finishChatToolCall(call, result, 'result');
      emitChat('hasna:chat-finish', result);
      setChatStatus('ready');
      return result;
    }
    setChatStatus('ready');
    return { approved: true, approval };
  }

  function clearChat() {
    state.chat.messages = [];
    state.chat.toolCalls = [];
    state.chat.sources = [];
    state.chat.pendingConfirmations = [];
    state.chat.error = '';
    state.chat.goal = null;
    setChatStatus('ready');
    return chatSnapshot();
  }

	  function viewSnapshot() {
	    return {
	      screen: state.screen,
	      machineFilter: state.machineFilter,
	      labelFilter: state.labelFilter,
	      statusFilter: state.statusFilter,
	      selectedId: state.selectedId,
	      visibleNoteIds: visibleNotes().map(n => n.id),
	      selectedMachine: state.machineFilter === ALL ? null : machineDetails(state.machineFilter),
	    };
	  }

  function editorCommand(commandId, options) {
    const bodyEl = $('editor-body');
    const note = noteById(state.selectedId);
    if (!bodyEl || !note) return null;
    const result = applyMarkdownCommand(bodyEl.value || '', Object.assign({}, options || {}, {
      commandId,
      selectionStart: bodyEl.selectionStart,
      selectionEnd: bodyEl.selectionEnd,
    }));
    bodyEl.value = result.markdown;
    if (typeof bodyEl.setSelectionRange === 'function') {
      bodyEl.setSelectionRange(result.selectionStart, result.selectionEnd);
    }
    note.body = result.markdown;
    note.contentFormat = 'markdown';
    note.updatedAt = new Date().toISOString();
    postNative('save', serializeNote(note));
    renderNotesList();
    renderHome();
    window.dispatchEvent(new CustomEvent('hasna:editor-command', {
      detail: { commandId, noteId: note.id, result },
    }));
    return result;
  }

  // Streaming transcript hook (contract): onTranscript({recId, text, isFinal}). Appends/
  // replaces the partial trailing line on each call, commits on isFinal — no layout jank.
  // The streaming backend may never call this in testing; the surface degrades to empty.
	  function onTranscript(payload) {
	    const p = payload || {};
	    const text = typeof p === 'string' ? p : String(p.text || '');
	    const isFinal = !!(p && p.isFinal);
	    if (isFinal) {
	      rec.finalTranscript = [rec.finalTranscript, text].filter(Boolean).join(' ').trim();
	      rec.partialTranscript = '';
	      if (rec.status === 'transcribing') setRecordingProgress('finalizing-transcript', 0.9);
	      emitTranscript('hasna:transcript-complete', rec.finalTranscript, p);
	    } else {
	      rec.partialTranscript = text;   // partial replaces the trailing partial line
	      if (rec.status === 'transcribing') setRecordingProgress('receiving-final-transcript', null);
	      emitTranscript('hasna:transcript-delta', rec.partialTranscript, p);
	    }
	    emitRecordingState();
	    renderTranscript();
	  }

  // Public surface for the native host.
  window.HasnaNotes = {
    hydrate: hydrate,
    destroy: destroy,
    recCommand: recCommand,
    onTranscript: onTranscript,
	    notes: {
	      moveToMachine: moveNoteToMachine,
	      archive: archiveNote,
		      trash: trashNoteWithConfirmation,
		      restore: restoreNote,
	      purge: purgeNoteWithConfirmation,
      info: noteInfo,
      setStatusFilter: setStatusFilter,
      cleanupExpiredTrash: cleanupExpiredTrash,
      settings: function () { return Object.assign({}, state.settings); },
      setTrashRetentionDays: function (days) {
        state.settings.trashRetentionDays = Math.max(1, Number(days || 30));
        postNative('settings', state.settings);
	        return Object.assign({}, state.settings);
	      },
	    },
	    machines: {
	      list: machineDetailsList,
	      details: machineDetails,
	      select: selectMachine,
	      requestDetails: requestMachineDetails,
	      receiveDetails: receiveMachineDetails,
	    },
    labels: {
      list: function () { return allLabels(); },
      create: createLabelLocal,
      rename: renameLabelLocal,
      delete: function (name, confirmed) { return deleteLabelLocal(name, !!confirmed); },
    },
	    view: {
	      state: viewSnapshot,
	    },
	    markdown: {
	      commands: function () { return MARKDOWN_COMMANDS.slice(); },
	      slashCommands: function () { return MARKDOWN_COMMANDS.slice(); },
	      render: renderMarkdownSafe,
	      plainText: markdownPlainText,
	      safeText: markdownSafeText,
	      applyCommand: applyMarkdownCommand,
	    },
	    editor: {
	      command: editorCommand,
	      commands: function () { return MARKDOWN_COMMANDS.slice(); },
	    },
	    chat: {
	      state: chatSnapshot,
	      tools: function () { return CHAT_TOOL_SCHEMAS.slice(); },
	      send: sendChat,
	      approve: approveChat,
	      clear: clearChat,
	    },
	    recording: {
	      state: recordingSnapshot,
      start: startRecording,
      pause: pauseRecording,
      resume: resumeRecording,
      stop: stopRecording,
      // Exposed so the transcript-commit transformation can be regression-tested
      // (it must keep spoken punctuation/newlines verbatim — never markdown-escaped).
      transcriptBody: transcriptToNoteBody,
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else { init(); }
})();
