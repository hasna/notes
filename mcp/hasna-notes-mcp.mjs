#!/usr/bin/env node
import {
  MARKDOWN_COMMANDS,
  applyMarkdownCommand,
  archiveNote,
  assignLabel,
  contentFingerprint,
  deleteLabelEverywhere,
  deleteNote,
  generateTitle,
  getMachineDetails,
  getNote,
  listMachineDetails,
  listNotes,
  loadLabelList,
  loadNotes,
  loadSettings,
  markdownPlainText,
  moveNoteToMachine,
  normalizeLabels,
  purgeExpiredTrash,
  renameLabel,
  restoreNote,
  saveLabelList,
  saveNote,
  saveSettings,
  renderMarkdownSafe,
  trashNote,
  unassignLabel,
} from '../tools/notes-lib.mjs';
import {
  CHAT_TOOL_SCHEMAS,
  executeNotesAgentTool,
  runNotesAgent,
  runNotesGoal,
} from '../tools/notes-agent.mjs';

const tools = [
  {
    name: 'notes_list',
    description: 'List latest Hasna Notes with optional pagination and filters.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10 },
        offset: { type: 'number', default: 0 },
        label: { type: 'string' },
        machine: { type: 'string' },
        status: { type: 'string' },
        includeTrash: { type: 'boolean' },
        includeArchived: { type: 'boolean' },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'notes_get',
    description: 'Read one Hasna Note by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'notes_create',
    description: 'Create a Hasna Note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        actorType: { type: 'string', enum: ['human', 'agent', 'system'] },
        actorName: { type: 'string' },
        targetMachine: { type: 'string' },
        sourceMachine: { type: 'string' },
        sourceMachineFriendlyName: { type: 'string' },
        openedFrom: { type: 'string' },
        sourceContext: { type: 'string' },
      },
    },
  },
  {
    name: 'notes_delete',
    description: 'Move a note to Trash by default; permanently delete when permanent is true or the note is already in Trash.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        permanent: { type: 'boolean' },
        retentionDays: { type: 'number' },
        trashMachine: { type: 'string' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notes_move_to_machine',
    description: 'Move a note to another owning machine while preserving origin metadata.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, machine: { type: 'string' }, machineName: { type: 'string' } },
      required: ['id', 'machine'],
    },
  },
  {
    name: 'notes_archive',
    description: 'Archive a note.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'notes_trash',
    description: 'Move a note to per-machine Trash.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        retentionDays: { type: 'number' },
        trashMachine: { type: 'string' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notes_restore',
    description: 'Restore a note from Archive or Trash to active notes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'notes_purge',
    description: 'Permanently delete a note.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, confirm: { type: 'boolean' }, dryRun: { type: 'boolean' } },
      required: ['id'],
    },
  },
  {
    name: 'trash_cleanup',
    description: 'Purge expired Trash items according to retention metadata.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' }, dryRun: { type: 'boolean' } } },
  },
  {
    name: 'settings_get',
    description: 'Read Hasna Notes settings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'settings_set_trash_retention',
    description: 'Set Trash retention in days.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' } }, required: ['days'] },
  },
  {
    name: 'machines_list',
    description: 'List machine details for the notes app, combining open-machines manifest fields with notes-derived fallback data.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'machines_details',
    description: 'Fetch details for one machine by id or slug.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'markdown_commands',
    description: 'List stable Markdown editor/slash command IDs and labels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'markdown_render',
    description: 'Render Markdown to sanitized safe HTML using the Hasna Notes restricted subset.',
    inputSchema: { type: 'object', properties: { markdown: { type: 'string' }, id: { type: 'string' } } },
  },
  {
    name: 'markdown_plain_text',
    description: 'Extract readable plain text from Markdown for search/title generation.',
    inputSchema: { type: 'object', properties: { markdown: { type: 'string' }, id: { type: 'string' } } },
  },
  {
    name: 'markdown_apply_command',
    description: 'Apply a Markdown editor command to a text selection.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        commandId: { type: 'string' },
        selectionStart: { type: 'number' },
        selectionEnd: { type: 'number' },
        url: { type: 'string' },
        href: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['markdown', 'commandId'],
    },
  },
  {
    name: 'labels_list',
    description: 'List all labels known to Hasna Notes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'labels_create',
    description: 'Create a label without assigning it to a note.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'labels_rename',
    description: 'Rename a label everywhere.',
    inputSchema: {
      type: 'object',
      properties: { oldName: { type: 'string' }, newName: { type: 'string' } },
      required: ['oldName', 'newName'],
    },
  },
  {
    name: 'labels_delete',
    description: 'Delete a label and remove it from notes.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'labels_assign',
    description: 'Assign a label to a note.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id', 'label'],
    },
  },
  {
    name: 'labels_unassign',
    description: 'Unassign a label from a note.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id', 'label'],
    },
  },
  {
    name: 'title_generate',
    description: 'Generate a concise 3-4 word note title, optionally applying it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        apply: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        sidecar: { type: 'string' },
        sidecarToken: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_tools',
    description: 'List Hasna Notes chat/agent tool schemas, safety flags, and confirmation requirements.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_run',
    description: 'Run the Hasna Notes tool-capable agent headlessly over notes. Broad/destructive writes preview unless confirm is true.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        actorName: { type: 'string' },
        openedFrom: { type: 'string' },
        sourceContext: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'agent_goal',
    description: 'Run a simple Hasna Notes goal loop until done, user input/approval is needed, blocked, or maxSteps is reached.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        actorName: { type: 'string' },
        openedFrom: { type: 'string' },
        sourceContext: { type: 'string' },
        maxSteps: { type: 'number' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'agent_tool_call',
    description: 'Execute one Hasna Notes agent tool directly. Confirmation-gated tools return a preview unless confirm is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        input: { type: 'object' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        actorName: { type: 'string' },
        openedFrom: { type: 'string' },
        sourceContext: { type: 'string' },
      },
      required: ['name'],
    },
  },
];

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages().catch((err) => {
    send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message || String(err) } });
  });
});

async function readMessages() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    let msg;
    try { msg = JSON.parse(body); }
    catch (err) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message || 'parse_error' } });
      continue;
    }
    await handle(msg);
  }
}

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function requireArg(args, key) {
  const value = args?.[key];
  if (value == null || value === '') throw new Error(`${key}_required`);
  return value;
}

function destructivePreview(toolName, args, preview) {
  return {
    ok: false,
    dryRun: true,
    requiresConfirmation: true,
    approval: {
      id: `approval-${toolName}-${Date.now()}`,
      toolName,
      input: args,
      preview,
    },
    preview,
  };
}

async function expiredTrashNotes() {
  const now = Date.now();
  return (await loadNotes()).filter(note => (
    note.status === 'trash' &&
    note.trashExpiresAt &&
    Date.parse(note.trashExpiresAt) <= now
  ));
}

async function markdownFromArgs(args) {
  if (args.markdown != null) return String(args.markdown);
  const note = await getNote(requireArg(args, 'id'));
  if (!note) throw new Error('note_not_found');
  return note.body || '';
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'notifications/initialized') return;
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hasna-notes', version: '1.0.0' },
        },
      });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, result: textResult({ error: err.message || String(err) }, true) });
  }
}

async function callTool(name, args) {
  if (name === 'notes_list') return textResult(await listNotes(args));
  if (name === 'notes_get') {
    const note = await getNote(requireArg(args, 'id'));
    if (!note) throw new Error('note_not_found');
    return textResult(note);
  }
  if (name === 'notes_create') {
    const now = new Date().toISOString();
    const title = String(args.title || '').trim();
    const note = await saveNote({
      title: title || 'Untitled Note',
      body: String(args.body || ''),
      labels: normalizeLabels(args.labels || []),
      machine: args.targetMachine,
      createdByActorType: args.actorType || 'agent',
      createdByName: args.actorName || process.env.HASNA_NOTES_ACTOR_NAME || 'agent',
      sourceMachine: args.sourceMachine,
      sourceMachineFriendlyName: args.sourceMachineFriendlyName,
      originMachine: args.originMachine || args.targetMachine,
      openedFrom: args.openedFrom || '',
      sourceContext: args.sourceContext || '',
      titleLocked: !!title,
      titleSource: title ? 'manual' : 'default',
      createdAt: now,
      updatedAt: now,
    });
    if (args.labels?.length) await saveLabelList([...(await loadLabelList()), ...args.labels]);
    return textResult(note);
  }
  if (name === 'notes_delete') {
    const note = await getNote(requireArg(args, 'id'));
    if (!note) throw new Error('note_not_found');
    if (args.permanent || note.status === 'trash') {
      const preview = { id: note.id, title: note.title, status: note.status, permanent: true };
      if (args.dryRun || !args.confirm) return textResult(destructivePreview('notes_delete', args, preview));
      await deleteNote(note.id);
    } else {
      const preview = { id: note.id, title: note.title, fromStatus: note.status, toStatus: 'trash', permanent: false };
      if (args.dryRun || !args.confirm) return textResult(destructivePreview('notes_delete', args, preview));
      return textResult(await trashNote(note.id, { retentionDays: args.retentionDays, trashMachine: args.trashMachine }));
    }
    return textResult({ ok: true });
  }
  if (name === 'notes_move_to_machine') {
    return textResult(await moveNoteToMachine(requireArg(args, 'id'), requireArg(args, 'machine'), {
      targetMachineFriendlyName: args.machineName,
    }));
  }
  if (name === 'notes_archive') return textResult(await archiveNote(requireArg(args, 'id')));
  if (name === 'notes_trash') {
    const note = await getNote(requireArg(args, 'id'));
    if (!note) throw new Error('note_not_found');
    if (note.status === 'trash') return textResult(note);
    const preview = { id: note.id, title: note.title, fromStatus: note.status, toStatus: 'trash', permanent: false };
    if (args.dryRun || !args.confirm) return textResult(destructivePreview('notes_trash', args, preview));
    return textResult(await trashNote(note.id, {
      retentionDays: args.retentionDays,
      trashMachine: args.trashMachine,
    }));
  }
  if (name === 'notes_restore') return textResult(await restoreNote(requireArg(args, 'id')));
  if (name === 'notes_purge') {
    const note = await getNote(requireArg(args, 'id'));
    if (!note) throw new Error('note_not_found');
    const preview = { id: note.id, title: note.title, status: note.status, permanent: true };
    if (args.dryRun || !args.confirm) return textResult(destructivePreview('notes_purge', args, preview));
    await deleteNote(note.id);
    return textResult({ ok: true, permanent: true });
  }
  if (name === 'trash_cleanup') {
    const expired = await expiredTrashNotes();
    if (expired.length && (args.dryRun || !args.confirm)) {
      return textResult(destructivePreview('trash_cleanup', args, {
        permanent: true,
        count: expired.length,
        ids: expired.map(note => note.id),
        titles: expired.map(note => note.title || 'Untitled Note'),
      }));
    }
    return textResult(await purgeExpiredTrash());
  }
  if (name === 'settings_get') return textResult(await loadSettings());
  if (name === 'settings_set_trash_retention') return textResult(await saveSettings({ trashRetentionDays: requireArg(args, 'days') }));
  if (name === 'machines_list') return textResult(await listMachineDetails());
  if (name === 'machines_details') return textResult(await getMachineDetails(requireArg(args, 'id')));
  if (name === 'markdown_commands') return textResult({ commands: MARKDOWN_COMMANDS });
  if (name === 'markdown_render') {
    const markdown = await markdownFromArgs(args);
    return textResult({ html: renderMarkdownSafe(markdown) });
  }
  if (name === 'markdown_plain_text') {
    const markdown = await markdownFromArgs(args);
    return textResult({ text: markdownPlainText(markdown) });
  }
  if (name === 'markdown_apply_command') {
    return textResult(applyMarkdownCommand(String(args.markdown || ''), args));
  }
  if (name === 'labels_list') return textResult({ labels: await loadLabelList() });
  if (name === 'labels_create') {
    await saveLabelList([...(await loadLabelList()), requireArg(args, 'name')]);
    return textResult({ labels: await loadLabelList() });
  }
  if (name === 'labels_rename') {
    await renameLabel(requireArg(args, 'oldName'), requireArg(args, 'newName'));
    return textResult({ labels: await loadLabelList() });
  }
  if (name === 'labels_delete') {
    await deleteLabelEverywhere(requireArg(args, 'name'));
    return textResult({ labels: await loadLabelList() });
  }
  if (name === 'labels_assign') return textResult(await assignLabel(requireArg(args, 'id'), requireArg(args, 'label')));
  if (name === 'labels_unassign') return textResult(await unassignLabel(requireArg(args, 'id'), requireArg(args, 'label')));
  if (name === 'title_generate') {
    const note = args.id ? await getNote(args.id) : null;
    if (args.id && !note) throw new Error('note_not_found');
    const text = String(args.text ?? note?.body ?? '');
    const result = await generateTitle(text, { sidecar: args.sidecar, sidecarToken: args.sidecarToken });
    const fingerprint = contentFingerprint(markdownPlainText(text));
    if (args.apply) {
      if (!note) throw new Error('id_required_for_apply');
      if (note.titleLocked && !args.force) throw new Error('title_locked');
      note.title = result.title;
      note.titleLocked = false;
      note.titleSource = 'generated';
      note.titleContentFingerprint = fingerprint;
      note.updatedAt = new Date().toISOString();
      await saveNote(note);
    }
    return textResult({ ...result, fingerprint, applied: !!args.apply });
  }
  if (name === 'agent_tools') return textResult({ tools: CHAT_TOOL_SCHEMAS });
  if (name === 'agent_run') {
    const events = [];
    const result = await runNotesAgent(requireArg(args, 'prompt'), {
      confirmWrites: !!args.confirm,
      yes: !!args.confirm,
      dryRun: !!args.dryRun,
      actorName: args.actorName || process.env.HASNA_NOTES_ACTOR_NAME || 'MCP Agent',
      actorType: 'agent',
      openedFrom: args.openedFrom || 'mcp-agent',
      sourceContext: args.sourceContext || String(args.prompt).slice(0, 200),
      limit: args.limit,
      onEvent: event => events.push(event),
    });
    return textResult({ ...result, events });
  }
  if (name === 'agent_goal') {
    const events = [];
    const result = await runNotesGoal(requireArg(args, 'objective'), {
      confirmWrites: !!args.confirm,
      yes: !!args.confirm,
      dryRun: !!args.dryRun,
      actorName: args.actorName || process.env.HASNA_NOTES_ACTOR_NAME || 'MCP Agent',
      actorType: 'agent',
      openedFrom: args.openedFrom || 'mcp-agent-goal',
      sourceContext: args.sourceContext || String(args.objective).slice(0, 200),
      maxSteps: args.maxSteps,
      onEvent: event => events.push(event),
    });
    return textResult({ ...result, events });
  }
  if (name === 'agent_tool_call') {
    const result = await executeNotesAgentTool(requireArg(args, 'name'), args.input || {}, {
      confirmWrites: !!args.confirm,
      dryRun: !!args.dryRun,
      actorName: args.actorName || process.env.HASNA_NOTES_ACTOR_NAME || 'MCP Agent',
      actorType: 'agent',
      openedFrom: args.openedFrom || 'mcp-agent',
      sourceContext: args.sourceContext || args.name,
    });
    return textResult(result);
  }
  throw new Error('unknown_tool');
}
