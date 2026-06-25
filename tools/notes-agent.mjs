import {
  archiveNote,
  assignLabel,
  deleteLabelEverywhere,
  getNote,
  loadLabelList,
  listNotes,
  loadNotes,
  markdownPlainText,
  moveNoteToMachine,
  normalizeLabels,
  renameLabel,
  restoreNote,
  saveLabelList,
  saveNote,
  trashNote,
  unassignLabel,
} from './notes-lib.mjs';

export const CHAT_EVENT_NAMES = [
  'hasna:chat-state',
  'hasna:chat-message',
  'hasna:chat-delta',
  'hasna:chat-tool-call',
  'hasna:chat-tool-result',
  'hasna:chat-sources',
  'hasna:chat-confirmation',
  'hasna:chat-finish',
  'hasna:chat-error',
];

export const CHAT_TOOL_SCHEMAS = [
  toolSchema('list_notes', 'List latest notes with filters and pagination.', {
    limit: { type: 'number', default: 10 },
    offset: { type: 'number', default: 0 },
    query: { type: 'string' },
    label: { type: 'string' },
    machine: { type: 'string' },
    status: { type: 'string' },
    includeArchived: { type: 'boolean' },
    includeTrash: { type: 'boolean' },
  }, { readOnly: true }),
  toolSchema('search_notes', 'Search note titles, labels, and Markdown body text.', {
    query: { type: 'string' },
    limit: { type: 'number', default: 10 },
    includeArchived: { type: 'boolean' },
    includeTrash: { type: 'boolean' },
  }, { required: ['query'], readOnly: true }),
  toolSchema('read_note', 'Read one note by id.', { id: { type: 'string' } }, { required: ['id'], readOnly: true }),
  toolSchema('note_info', 'Read friendly note provenance and metadata by id.', { id: { type: 'string' } }, { required: ['id'], readOnly: true }),
  toolSchema('create_note', 'Create a new note with agent provenance.', {
    title: { type: 'string' },
    body: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    targetMachine: { type: 'string' },
  }, { mutates: true }),
  toolSchema('update_note', 'Replace title, body, labels, folder, or status for one note. Requires confirmation.', {
    id: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    folder: { type: 'string' },
    status: { type: 'string' },
  }, { required: ['id'], mutates: true, requiresConfirmation: true }),
  toolSchema('append_note', 'Append Markdown text to one note. Requires confirmation.', {
    id: { type: 'string' },
    text: { type: 'string' },
  }, { required: ['id', 'text'], mutates: true, requiresConfirmation: true }),
  toolSchema('label_note', 'Assign one label to one note.', {
    id: { type: 'string' },
    label: { type: 'string' },
  }, { required: ['id', 'label'], mutates: true }),
  toolSchema('unlabel_note', 'Remove one label from one note.', {
    id: { type: 'string' },
    label: { type: 'string' },
  }, { required: ['id', 'label'], mutates: true }),
  toolSchema('archive_note', 'Archive one note. Requires confirmation.', { id: { type: 'string' } }, { required: ['id'], mutates: true, requiresConfirmation: true }),
  toolSchema('trash_note', 'Move one note to Trash. Requires confirmation.', { id: { type: 'string' } }, { required: ['id'], mutates: true, requiresConfirmation: true }),
  toolSchema('restore_note', 'Restore one archived or trashed note. Requires confirmation.', { id: { type: 'string' } }, { required: ['id'], mutates: true, requiresConfirmation: true }),
  toolSchema('move_note', 'Move one note to another machine while preserving origin metadata. Requires confirmation.', {
    id: { type: 'string' },
    machine: { type: 'string' },
    machineName: { type: 'string' },
  }, { required: ['id', 'machine'], mutates: true, requiresConfirmation: true }),
  toolSchema('list_labels', 'List all known labels, including empty persisted labels.', {}, { readOnly: true }),
  toolSchema('create_label', 'Create an empty label without assigning it to a note.', {
    name: { type: 'string' },
  }, { required: ['name'], mutates: true }),
  toolSchema('update_label', 'Rename a label everywhere. Requires confirmation.', {
    oldName: { type: 'string' },
    newName: { type: 'string' },
  }, { required: ['oldName', 'newName'], mutates: true, requiresConfirmation: true }),
  toolSchema('delete_label', 'Delete a label and remove it from notes. Requires confirmation.', {
    name: { type: 'string' },
  }, { required: ['name'], mutates: true, requiresConfirmation: true }),
  toolSchema('summarize_notes', 'Summarize selected, searched, or all visible notes.', {
    ids: { type: 'array', items: { type: 'string' } },
    query: { type: 'string' },
    all: { type: 'boolean' },
    limit: { type: 'number', default: 10 },
  }, { readOnly: true }),
  toolSchema('find_related_notes', 'Find notes related to a note id or query.', {
    id: { type: 'string' },
    query: { type: 'string' },
    limit: { type: 'number', default: 10 },
  }, { readOnly: true }),
  toolSchema('consolidate_notes', 'Create or preview a larger consolidated note from several notes. Requires confirmation to write.', {
    ids: { type: 'array', items: { type: 'string' } },
    query: { type: 'string' },
    all: { type: 'boolean' },
    title: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
  }, { mutates: true, requiresConfirmation: true, broad: true }),
];

function toolSchema(name, description, properties, flags = {}) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(flags.required?.length ? { required: flags.required } : {}),
    },
    safety: {
      readOnly: !!flags.readOnly,
      mutates: !!flags.mutates,
      requiresConfirmation: !!flags.requiresConfirmation,
      broad: !!flags.broad,
    },
  };
}

function toolMeta(name) {
  return CHAT_TOOL_SCHEMAS.find(tool => tool.name === name);
}

function requireArg(args, key) {
  const value = args?.[key];
  if (value == null || value === '') throw new Error(`${key}_required`);
  return value;
}

function cleanWords(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
}

function compactBody(note, max = 180) {
  const plain = markdownPlainText(note?.body || '');
  if (plain.length <= max) return plain;
  return plain.slice(0, max - 1).trimEnd() + '...';
}

export function noteReference(note) {
  return {
    id: note.id,
    title: note.title || 'Untitled Note',
    updatedAt: note.updatedAt || '',
    createdAt: note.createdAt || '',
    labels: note.labels || [],
    status: note.status || 'active',
    machine: note.machine || '',
  };
}

export function noteInfo(note) {
  return {
    id: note.id,
    title: note.title || 'Untitled Note',
    labels: note.labels || [],
    status: note.status || 'active',
    createdBy: note.createdByName || note.author || 'unknown',
    createdByActorType: note.createdByActorType || 'human',
    createdAt: note.createdAt || '',
    updatedAt: note.updatedAt || '',
    sourceMachine: note.sourceMachine || '',
    sourceMachineFriendlyName: note.sourceMachineFriendlyName || '',
    originMachine: note.originMachine || note.machine || '',
    originMachineFriendlyName: note.originMachineFriendlyName || '',
    currentMachine: note.machine || '',
    openedFrom: note.openedFrom || '',
    sourceContext: note.sourceContext || '',
  };
}

async function notesForArgs(args = {}, root) {
  if (Array.isArray(args.ids) && args.ids.length) {
    const notes = [];
    for (const id of args.ids) {
      const note = await getNote(id, root);
      if (note) notes.push(note);
    }
    return notes;
  }
  const page = await listNotes({
    query: args.query,
    limit: args.limit || (args.all ? 100 : 10),
    includeArchived: true,
    includeTrash: !!args.includeTrash,
  }, root);
  return page.items;
}

function summarizeNotes(notes) {
  if (!notes.length) return 'No matching notes found.';
  const lines = notes.map(note => `- ${note.title || 'Untitled Note'}: ${compactBody(note, 220) || 'No body text.'}`);
  return `Summary of ${notes.length} note${notes.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function consolidatedMarkdown(notes, title = 'Consolidated Notes') {
  const sections = notes.map(note => {
    const body = (note.body || '').trim() || '_No note body._';
    return `## ${note.title || 'Untitled Note'}\n\n${body}\n\n_Source: ${note.id}_`;
  });
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

function confirmation(toolName, args, preview) {
  return {
    requiresConfirmation: true,
    approval: {
      id: `approval-${toolName}-${Date.now()}`,
      toolName,
      input: args,
      preview,
    },
  };
}

function dryRunResult(toolName, args, preview, extra = {}) {
  return {
    ok: false,
    dryRun: true,
    toolName,
    input: args,
    preview,
    ...extra,
  };
}

function shouldPreview(toolName, args, options) {
  const meta = toolMeta(toolName);
  return !!(meta?.safety?.requiresConfirmation && !args.confirm && !options.confirmWrites);
}

async function withPreview(toolName, args, options, previewFactory, execute) {
  const preview = await previewFactory();
  if (options.dryRun || shouldPreview(toolName, args, options)) {
    return {
      ok: false,
      dryRun: true,
      ...confirmation(toolName, args, preview),
      preview,
    };
  }
  return execute();
}

function sourceContext(options) {
  return {
    actorType: options.actorType || 'agent',
    actorName: options.actorName || process.env.HASNA_NOTES_ACTOR_NAME || 'Hasna Notes Agent',
    openedFrom: options.openedFrom || 'agent',
    sourceContext: options.sourceContext || 'hasna-notes-agent',
    sourceMachine: options.sourceMachine || process.env.HASNA_NOTES_SOURCE_MACHINE,
    sourceMachineFriendlyName: options.sourceMachineFriendlyName || process.env.HASNA_NOTES_SOURCE_MACHINE_NAME,
  };
}

function normalizeStatus(value, fallback = 'active') {
  const status = String(value || fallback).trim().toLowerCase();
  return ['inbox', 'active', 'reviewed', 'promoted', 'archived', 'trash', 'stale'].includes(status)
    ? status
    : fallback;
}

function labelCount(labels, notes) {
  return labels.map(name => ({
    name,
    count: notes.filter(note => (note.labels || []).some(label => label.toLowerCase() === name.toLowerCase())).length,
  }));
}

export async function executeNotesAgentTool(toolName, args = {}, options = {}) {
  const root = options.root;
  const name = String(toolName || '');
  const meta = toolMeta(name);
  if (!meta) throw new Error('unknown_agent_tool');

  if (name === 'list_notes' || name === 'search_notes') {
    const query = name === 'search_notes' ? requireArg(args, 'query') : args.query;
    const page = await listNotes({
      ...args,
      query,
      limit: args.limit || 10,
      includeArchived: args.includeArchived,
      includeTrash: args.includeTrash,
    }, root);
    return { ...page, sources: page.items.map(noteReference) };
  }

  if (name === 'read_note') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    return { note, sources: [noteReference(note)] };
  }

  if (name === 'note_info') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    return { info: noteInfo(note), sources: [noteReference(note)] };
  }

  if (name === 'create_note') {
    const now = new Date().toISOString();
    const title = String(args.title || '').trim() || 'Untitled Note';
    const labels = normalizeLabels(args.labels || []);
    if (options.dryRun) {
      return dryRunResult(name, args, {
        title,
        labels,
        targetMachine: args.targetMachine || '',
        bodyPreview: String(args.body || '').slice(0, 240),
        provenance: sourceContext(options),
      });
    }
    const note = await saveNote({
      title,
      body: String(args.body || ''),
      labels,
      machine: args.targetMachine,
      createdAt: now,
      updatedAt: now,
      createdByActorType: sourceContext(options).actorType,
      createdByName: sourceContext(options).actorName,
      openedFrom: sourceContext(options).openedFrom,
      sourceContext: sourceContext(options).sourceContext,
      sourceMachine: sourceContext(options).sourceMachine,
      sourceMachineFriendlyName: sourceContext(options).sourceMachineFriendlyName,
      titleLocked: !!String(args.title || '').trim(),
      titleSource: String(args.title || '').trim() ? 'manual' : 'default',
    }, root);
    if (args.labels?.length) await saveLabelList([...(await loadLabelList(root)), ...args.labels], root);
    return { note, sources: [noteReference(note)] };
  }

  if (name === 'update_note') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    return withPreview(name, args, options, async () => ({
      id: note.id,
      before: {
        title: note.title,
        bodyPreview: compactBody(note, 240),
        labels: note.labels || [],
        folder: note.folder || '',
        status: note.status || 'active',
      },
      after: {
        title: args.title ?? note.title,
        bodyPreview: String(args.body ?? note.body).slice(0, 240),
        labels: args.labels ?? note.labels ?? [],
        folder: args.folder ?? note.folder ?? '',
        status: args.status ? normalizeStatus(args.status, note.status || 'active') : note.status || 'active',
      },
    }), async () => {
      if (args.title != null) note.title = String(args.title);
      if (args.body != null) note.body = String(args.body);
      if (args.labels != null) note.labels = normalizeLabels(args.labels);
      if (args.folder != null) note.folder = String(args.folder || '');
      if (args.status != null) note.status = normalizeStatus(args.status, note.status || 'active');
      note.updatedAt = new Date().toISOString();
      await saveNote(note, root);
      return { note, sources: [noteReference(note)] };
    });
  }

  if (name === 'append_note') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    const text = String(requireArg(args, 'text'));
    return withPreview(name, args, options, async () => ({
      id: note.id,
      appendText: text,
      resultingLength: (note.body || '').length + text.length + 2,
    }), async () => {
      note.body = [note.body || '', text].filter(Boolean).join('\n\n');
      note.updatedAt = new Date().toISOString();
      await saveNote(note, root);
      return { note, sources: [noteReference(note)] };
    });
  }

  if (name === 'label_note' || name === 'unlabel_note') {
    const id = requireArg(args, 'id');
    const label = requireArg(args, 'label');
    const note = await getNote(id, root);
    if (!note) throw new Error('note_not_found');
    if (options.dryRun) {
      return dryRunResult(name, args, {
        id,
        label,
        action: name === 'label_note' ? 'assign' : 'unassign',
        beforeLabels: note.labels || [],
      }, { sources: [noteReference(note)] });
    }
    const changed = name === 'label_note'
      ? await assignLabel(id, label, root)
      : await unassignLabel(id, label, root);
    return { note: changed, sources: [noteReference(changed)] };
  }

  if (name === 'archive_note' || name === 'trash_note' || name === 'restore_note') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    return withPreview(name, args, options, async () => ({
      id: note.id,
      title: note.title,
      fromStatus: note.status,
      toStatus: name === 'archive_note' ? 'archived' : name === 'trash_note' ? 'trash' : 'active',
    }), async () => {
      const changed = name === 'archive_note'
        ? await archiveNote(note.id, root)
        : name === 'trash_note'
          ? await trashNote(note.id, {}, root)
          : await restoreNote(note.id, root);
      return { note: changed, sources: [noteReference(changed)] };
    });
  }

  if (name === 'move_note') {
    const note = await getNote(requireArg(args, 'id'), root);
    if (!note) throw new Error('note_not_found');
    const machine = String(requireArg(args, 'machine')).trim();
    return withPreview(name, args, options, async () => ({
      id: note.id,
      title: note.title,
      fromMachine: note.machine || '',
      toMachine: machine,
      machineName: args.machineName || '',
    }), async () => {
      const changed = await moveNoteToMachine(note.id, machine, { targetMachineFriendlyName: args.machineName }, root);
      return { note: changed, sources: [noteReference(changed)] };
    });
  }

  if (name === 'list_labels') {
    const labels = await loadLabelList(root);
    const notes = await loadNotes(root);
    return { labels, items: labelCount(labels, notes) };
  }

  if (name === 'create_label') {
    const label = requireArg(args, 'name');
    if (options.dryRun) {
      return dryRunResult(name, args, { name: label });
    }
    await saveLabelList([...(await loadLabelList(root)), label], root);
    const labels = await loadLabelList(root);
    return { labels, items: labelCount(labels, await loadNotes(root)) };
  }

  if (name === 'update_label') {
    const oldName = requireArg(args, 'oldName');
    const newName = requireArg(args, 'newName');
    const notes = await loadNotes(root);
    return withPreview(name, args, options, async () => ({
      oldName,
      newName,
      affectedNoteIds: notes
        .filter(note => (note.labels || []).some(label => label.toLowerCase() === String(oldName).toLowerCase()))
        .map(note => note.id),
    }), async () => {
      await renameLabel(oldName, newName, root);
      const labels = await loadLabelList(root);
      return { labels, items: labelCount(labels, await loadNotes(root)) };
    });
  }

  if (name === 'delete_label') {
    const label = requireArg(args, 'name');
    const notes = await loadNotes(root);
    return withPreview(name, args, options, async () => ({
      name: label,
      affectedNoteIds: notes
        .filter(note => (note.labels || []).some(item => item.toLowerCase() === String(label).toLowerCase()))
        .map(note => note.id),
    }), async () => {
      await deleteLabelEverywhere(label, root);
      const labels = await loadLabelList(root);
      return { labels, items: labelCount(labels, await loadNotes(root)) };
    });
  }

  if (name === 'summarize_notes') {
    const notes = await notesForArgs(args, root);
    return { summary: summarizeNotes(notes), sources: notes.map(noteReference) };
  }

  if (name === 'find_related_notes') {
    const notes = await loadNotes(root);
    let basis = String(args.query || '');
    let source = null;
    if (args.id) {
      source = notes.find(n => n.id.toLowerCase() === String(args.id).toLowerCase());
      if (!source) throw new Error('note_not_found');
      basis = `${source.title} ${markdownPlainText(source.body)} ${source.labels.join(' ')}`;
    }
    const basisWords = new Set(cleanWords(basis));
    const related = notes
      .filter(note => !source || note.id !== source.id)
      .map(note => {
        const score = cleanWords(`${note.title} ${note.body} ${note.labels.join(' ')}`).filter(word => basisWords.has(word)).length;
        return { note, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.note.updatedAt || 0) - Date.parse(a.note.updatedAt || 0))
      .slice(0, Math.max(1, Number(args.limit || 10)));
    return { related: related.map(item => ({ score: item.score, ...noteReference(item.note) })), sources: related.map(item => noteReference(item.note)) };
  }

  if (name === 'consolidate_notes') {
    const notes = await notesForArgs({ ...args, limit: args.limit || 25 }, root);
    const title = String(args.title || 'Consolidated Notes').trim();
    const body = consolidatedMarkdown(notes, title);
    return withPreview(name, args, options, async () => ({
      title,
      noteCount: notes.length,
      sources: notes.map(noteReference),
      bodyPreview: body.slice(0, 1200),
    }), async () => {
      const now = new Date().toISOString();
      const note = await saveNote({
        title,
        body,
        labels: normalizeLabels(args.labels || ['consolidated']),
        createdAt: now,
        updatedAt: now,
        createdByActorType: sourceContext(options).actorType,
        createdByName: sourceContext(options).actorName,
        openedFrom: sourceContext(options).openedFrom,
        sourceContext: sourceContext(options).sourceContext,
        sourceMachine: sourceContext(options).sourceMachine,
        sourceMachineFriendlyName: sourceContext(options).sourceMachineFriendlyName,
        titleLocked: true,
        titleSource: 'manual',
      }, root);
      return { note, sources: notes.map(noteReference) };
    });
  }

  throw new Error('unknown_agent_tool');
}

function extractQuery(prompt) {
  const p = String(prompt || '').trim();
  const quoted = /["“]([^"”]+)["”]/.exec(p);
  if (quoted) return quoted[1];
  const about = /\b(?:about|for|on|related to)\s+(.+)$/i.exec(p);
  if (about) return about[1].replace(/[?.!]+$/, '').trim();
  return p.replace(/\b(summarize|summary|search|find|notes?|please|show|list|consolidate|organize|combine|all|into|new|larger)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

function firstUUID(prompt) {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.exec(String(prompt || ''))?.[0] || '';
}

function noteIdForPrompt(prompt, options = {}) {
  return firstUUID(prompt) || options.noteId || options.selectedNoteId || options.id || '';
}

function stripPromptValue(value) {
  return String(value || '')
    .replace(/[?.!]+$/, '')
    .replace(/\b(?:please|note|this|id|as|with|to|from)\b/gi, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLabel(prompt) {
  const text = String(prompt || '');
  const quoted = /\b(?:label|tag|unlabel|untag|remove\s+(?:label|tag))\b[^"“”]*["“]([^"”]+)["”]/i.exec(text);
  if (quoted) return quoted[1].trim();
  const m = /\b(?:label|tag|unlabel|untag|remove\s+(?:label|tag))\b\s+(.+)$/i.exec(text);
  if (!m) return '';
  return stripPromptValue(m[1]);
}

function extractUpdate(prompt, options = {}) {
  const text = String(prompt || '');
  const title = options.title ?? /(?:^|\b)title\s*[:=]\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  const body = options.body ?? /(?:^|\b)(?:body|text|content)\s*[:=]\s*([\s\S]+)$/i.exec(text)?.[1]?.trim();
  if (title != null || body != null) return { title, body };
  const id = firstUUID(text);
  const after = id ? text.slice(text.indexOf(id) + id.length).trim() : '';
  const cleaned = after.replace(/^(?:to|with|as|note|body|text|content)\b[:\s-]*/i, '').trim();
  return cleaned ? { body: cleaned } : {};
}

function emit(options, type, detail) {
  if (typeof options.onEvent === 'function') options.onEvent({ type, detail });
}

async function runTool(toolName, args, options, toolCalls) {
  const toolCall = { id: `tool-${toolCalls.length + 1}`, name: toolName, input: args, state: 'call' };
  toolCalls.push(toolCall);
  emit(options, 'tool-call', toolCall);
  const result = await executeNotesAgentTool(toolName, args, options);
  toolCall.state = result.requiresConfirmation ? 'approval-requested' : 'result';
  toolCall.result = result;
  emit(options, 'tool-result', toolCall);
  if (result.requiresConfirmation) emit(options, 'confirmation', result.approval);
  return result;
}

export function parseGoalCommand(prompt) {
  const text = String(prompt || '').trim();
  const match = /^\/goal(?:\s+begin)?\s+([\s\S]+)$/i.exec(text);
  return match ? match[1].trim() : '';
}

function goalNeedsInput(result) {
  return !!(result?.pendingConfirmations?.length || result?.status === 'awaiting_confirmation');
}

function goalTerminalFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(needs? (user )?input|need you to|please provide|which note|what label|what machine|which machine)\b/.test(t)) {
    return 'needs_input';
  }
  if (/\b(blocked|cannot continue|not possible|unable to proceed)\b/.test(t)) return 'blocked';
  return '';
}

function goalFollowupPrompt(objective, stepNumber, previous) {
  const prior = previous?.text ? `\nPrevious result:\n${previous.text.slice(0, 1200)}` : '';
  return [
    `Continue this Hasna Notes goal until it is achieved, needs user input, or is clearly blocked.`,
    `Goal: ${objective}`,
    `Step ${stepNumber}: inspect or use the safest next note/label operation. Do not repeat a completed step.${prior}`,
  ].join('\n');
}

export async function runNotesGoal(objective, options = {}) {
  const cleanObjective = String(objective || '').trim();
  if (!cleanObjective) throw new Error('goal_required');
  const maxSteps = Math.min(12, Math.max(1, Number(options.maxSteps || 6)));
  const goal = {
    id: `goal-${Date.now()}`,
    objective: cleanObjective,
    status: 'running',
    maxSteps,
    steps: [],
    blocker: '',
    needsInput: '',
  };
  emit(options, 'goal-state', goal);

  let previous = null;
  for (let index = 0; index < maxSteps; index += 1) {
    const stepNumber = index + 1;
    const prompt = index === 0 ? cleanObjective : goalFollowupPrompt(cleanObjective, stepNumber, previous);
    emit(options, 'goal-step', { goalId: goal.id, stepNumber, status: 'running', prompt });
    const result = await runNotesAgent(prompt, { ...options, _skipGoalParsing: true });
    const terminal = goalTerminalFromText(result.text);
    const step = {
      stepNumber,
      status: goalNeedsInput(result) ? 'needs_input' : terminal || 'complete',
      text: result.text,
      toolCalls: result.toolCalls || [],
      sources: result.sources || [],
      pendingConfirmations: result.pendingConfirmations || [],
    };
    goal.steps.push(step);
    previous = result;
    emit(options, 'goal-step', { goalId: goal.id, ...step });

    if (goalNeedsInput(result)) {
      goal.status = 'needs_input';
      goal.needsInput = 'A tool call requires approval before the goal can continue.';
      goal.pendingConfirmations = result.pendingConfirmations || [];
      emit(options, 'goal-state', goal);
      return {
        ...result,
        id: goal.id,
        mode: 'goal',
        status: 'needs_input',
        goal,
        text: `${result.text}\n\nGoal paused for approval before continuing.`,
      };
    }
    if (terminal === 'needs_input') {
      goal.status = 'needs_input';
      goal.needsInput = result.text;
      emit(options, 'goal-state', goal);
      return { ...result, id: goal.id, mode: 'goal', status: 'needs_input', goal };
    }
    if (terminal === 'blocked') {
      goal.status = 'blocked';
      goal.blocker = result.text;
      emit(options, 'goal-state', goal);
      return { ...result, id: goal.id, mode: 'goal', status: 'blocked', goal };
    }

    const mutatingSuccess = (result.toolCalls || []).some(call => (
      call.state === 'result' &&
      call.result &&
      !call.result.requiresConfirmation &&
      !call.result.dryRun &&
      ['create_note', 'update_note', 'append_note', 'label_note', 'unlabel_note', 'archive_note', 'trash_note', 'restore_note', 'move_note', 'create_label', 'update_label', 'delete_label', 'consolidate_notes'].includes(call.name)
    ));
    const readOnlyComplete = index > 0 || /\b(summarize|summary|search|find|list|read|show|info|metadata|provenance|related|similar)\b/i.test(cleanObjective);
    if (mutatingSuccess || readOnlyComplete) {
      goal.status = 'done';
      emit(options, 'goal-state', goal);
      return { ...result, id: goal.id, mode: 'goal', status: 'done', goal };
    }
  }

  goal.status = 'blocked';
  goal.blocker = `Stopped after ${maxSteps} goal steps without a clear completion signal.`;
  emit(options, 'goal-state', goal);
  return {
    id: goal.id,
    mode: 'goal',
    status: 'blocked',
    provider: 'local-tools',
    text: goal.blocker,
    toolCalls: previous?.toolCalls || [],
    sources: previous?.sources || [],
    pendingConfirmations: previous?.pendingConfirmations || [],
    goal,
  };
}

export async function runNotesAgent(prompt, options = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt_required');
  const goalObjective = options._skipGoalParsing ? '' : parseGoalCommand(text);
  if (goalObjective) return runNotesGoal(goalObjective, options);

  const toolCalls = [];
  emit(options, 'state', { status: 'submitted' });
  emit(options, 'state', { status: 'streaming' });

  let result;
  let answer = '';
  const query = extractQuery(text);
  const id = noteIdForPrompt(text, options);
  const wantsConfirm = !!(options.confirmWrites || options.yes);
  const lower = text.toLowerCase();

  if (/\b(list|show)\b.*\blabels?\b/.test(lower) || /^labels?$/i.test(text)) {
    result = await runTool('list_labels', {}, options, toolCalls);
    answer = result.items.length
      ? 'Labels:\n' + result.items.map(item => `- ${item.name} (${item.count})`).join('\n')
      : 'No labels yet.';
  } else if (/\b(create|add|new)\b.*\blabel\b/.test(lower)) {
    const label = extractLabel(text) || options.label || /(?:label)\s+["“]?([^"”]+)["”]?$/i.exec(text)?.[1]?.trim();
    if (!label) throw new Error('label_required');
    result = await runTool('create_label', { name: label }, options, toolCalls);
    answer = result.dryRun ? `Create-label preview ready for "${label}".` : `Created label "${label}".`;
  } else if (/\b(rename|update)\b.*\blabel\b/.test(lower)) {
    const oldName = options.oldName || /(?:rename|update)\s+label\s+["“]?([^"”]+?)["”]?\s+(?:to|as)\s+["“]?([^"”]+)["”]?$/i.exec(text)?.[1]?.trim();
    const newName = options.newName || /(?:rename|update)\s+label\s+["“]?([^"”]+?)["”]?\s+(?:to|as)\s+["“]?([^"”]+)["”]?$/i.exec(text)?.[2]?.trim();
    if (!oldName || !newName) throw new Error('label_rename_args_required');
    result = await runTool('update_label', { oldName, newName, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Rename-label preview ready for "${oldName}".` : `Renamed label "${oldName}" to "${newName}".`;
  } else if (/\b(delete|remove)\b.*\blabel\b/.test(lower) && !id) {
    const label = extractLabel(text) || options.label;
    if (!label) throw new Error('label_required');
    result = await runTool('delete_label', { name: label, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Delete-label preview ready for "${label}".` : `Deleted label "${label}".`;
  } else if (/\b(consolidate|organize|roll up|combine)\b/.test(lower)) {
    result = await runTool('consolidate_notes', {
      query: query || undefined,
      all: !query,
      title: options.title || 'Consolidated Notes',
      labels: ['consolidated'],
      confirm: wantsConfirm,
    }, { ...options, confirmWrites: wantsConfirm, dryRun: options.dryRun ?? !wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation
      ? `I prepared a consolidation preview from ${result.preview.noteCount} note(s). Approve it to create "${result.preview.title}".`
      : `Created consolidated note "${result.note.title}" from ${result.sources.length} note(s).`;
  } else if (/\b(summarize|summary|recap)\b/.test(lower)) {
    result = await runTool('summarize_notes', { query: query || undefined, all: !query, limit: options.limit || 10 }, options, toolCalls);
    answer = result.summary;
  } else if (/\b(related|similar)\b/.test(lower)) {
    result = await runTool('find_related_notes', id ? { id, limit: options.limit || 10 } : { query, limit: options.limit || 10 }, options, toolCalls);
    answer = result.related.length
      ? 'Related notes:\n' + result.related.map(n => `- ${n.title} (${n.id})`).join('\n')
      : 'No related notes found.';
  } else if (/\b(info|metadata|provenance|details)\b/.test(lower) && id) {
    result = await runTool('note_info', { id }, options, toolCalls);
    const info = result.info;
    answer = [
      `${info.title} (${info.id})`,
      `Created by ${info.createdBy} (${info.createdByActorType})`,
      info.createdAt ? `Created ${info.createdAt}` : '',
      info.currentMachine ? `Machine ${info.currentMachine}` : '',
      info.openedFrom ? `Opened from ${info.openedFrom}` : '',
    ].filter(Boolean).join('\n');
  } else if (/\b(read|open|show|get)\b/.test(lower) && id) {
    result = await runTool('read_note', { id }, options, toolCalls);
    answer = `# ${result.note.title || 'Untitled Note'}\n\n${result.note.body || ''}`;
  } else if (/\b(update|edit|replace)\b/.test(lower) && id) {
    const patch = extractUpdate(text, options);
    if (patch.title == null && patch.body == null) throw new Error('update_content_required');
    result = await runTool('update_note', { id, ...patch, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Update preview ready for ${id}.` : `Updated "${result.note.title}".`;
  } else if (/\b(unlabel|untag|remove\s+(?:label|tag))\b/.test(lower) && id) {
    const label = extractLabel(text) || options.label;
    if (!label) throw new Error('label_required');
    result = await runTool('unlabel_note', { id, label }, options, toolCalls);
    answer = result.dryRun ? `Unlabel preview ready for ${id}.` : `Removed label "${label}" from "${result.note.title}".`;
  } else if (/\b(label|tag)\b/.test(lower) && id) {
    const label = extractLabel(text) || options.label;
    if (!label) throw new Error('label_required');
    result = await runTool('label_note', { id, label }, options, toolCalls);
    answer = result.dryRun ? `Label preview ready for ${id}.` : `Added label "${label}" to "${result.note.title}".`;
  } else if (/\bcreate\b.*\bnote\b/.test(lower)) {
    const title = options.title || (/title[:=]\s*([^\n]+)/i.exec(text)?.[1] || 'Agent Note');
    const body = options.body || text.replace(/create\s+(a\s+)?note/i, '').trim() || title;
    result = await runTool('create_note', { title, body, labels: options.labels || [] }, options, toolCalls);
    answer = result.dryRun ? `Create-note preview ready for "${result.preview.title}".` : `Created note "${result.note.title}".`;
  } else if (/\bappend\b/.test(lower) && id) {
    const appendText = options.text || text.replace(/^.*?\bappend\b/i, '').replace(id, '').trim();
    result = await runTool('append_note', { id, text: appendText, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Append preview ready for ${id}.` : `Appended text to "${result.note.title}".`;
  } else if (/\barchive\b/.test(lower) && id) {
    result = await runTool('archive_note', { id, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Archive preview ready for ${id}.` : `Archived "${result.note.title}".`;
  } else if (/\b(trash|delete)\b/.test(lower) && id) {
    result = await runTool('trash_note', { id, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Trash preview ready for ${id}.` : `Moved "${result.note.title}" to Trash.`;
  } else if (/\brestore\b/.test(lower) && id) {
    result = await runTool('restore_note', { id, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Restore preview ready for ${id}.` : `Restored "${result.note.title}".`;
  } else if (/\bmove\b/.test(lower) && id) {
    const machine = options.machine || options.targetMachine || /\b(?:to|machine)\s+([A-Za-z0-9._-]+)\b/i.exec(text)?.[1]?.trim();
    if (!machine) throw new Error('machine_required');
    result = await runTool('move_note', { id, machine, machineName: options.machineName, confirm: wantsConfirm }, { ...options, confirmWrites: wantsConfirm }, toolCalls);
    answer = result.requiresConfirmation ? `Move preview ready for ${id}.` : `Moved "${result.note.title}" to ${machine}.`;
  } else {
    result = await runTool(query ? 'search_notes' : 'list_notes', query ? { query, limit: options.limit || 10 } : { limit: options.limit || 10 }, options, toolCalls);
    answer = result.items.length
      ? 'Found notes:\n' + result.items.map(note => `- ${note.title || 'Untitled Note'} (${note.id})`).join('\n')
      : 'No matching notes found.';
  }

  let sources = [];
  if (Array.isArray(result.sources)) sources = result.sources;
  else if (Array.isArray(result.items) && result.items.every(item => item && item.id)) sources = result.items.map(noteReference);
  else if (result.note) sources = [noteReference(result.note)];
  emit(options, 'delta', { text: answer });
  emit(options, 'sources', { sources });
  const response = {
    id: `chat-${Date.now()}`,
    status: result.requiresConfirmation ? 'awaiting_confirmation' : 'complete',
    provider: 'local-tools',
    text: answer,
    toolCalls,
    sources,
    pendingConfirmations: result.requiresConfirmation ? [result.approval] : [],
  };
  emit(options, 'finish', response);
  emit(options, 'state', { status: response.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'ready' });
  return response;
}
