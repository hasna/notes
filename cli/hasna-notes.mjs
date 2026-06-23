#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  MARKDOWN_COMMANDS,
  applyMarkdownCommand,
  archiveNote,
  assignLabel,
  contentFingerprint,
  dataRoot,
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
  runNotesAgent,
} from '../tools/notes-agent.mjs';

const DEFAULT_LIMIT = 10;

function usage() {
  return `Hasna Notes CLI

Usage:
  hasna-notes list [--json] [--limit 10] [--offset 0] [--label name] [--machine id] [--query text]
  hasna-notes get <id> [--json]
  hasna-notes create [--title text] [--body text | --body-file path] [--label name ...] [--actor-type agent] [--actor-name name] [--target-machine id] [--opened-from text] [--json]
  hasna-notes delete <id> [--permanent] [--yes]
  hasna-notes archive <id>
  hasna-notes trash <id> [--retention-days 30]
  hasna-notes restore <id>
  hasna-notes purge <id> [--yes]
  hasna-notes cleanup-trash
  hasna-notes move <id> <machine>
  hasna-notes machines list [--json]
  hasna-notes machines details <machine> [--json]
  hasna-notes markdown commands [--json]
  hasna-notes markdown render <id> [--json]
  hasna-notes markdown plain-text <id> [--json]
  hasna-notes markdown apply-command <command-id> --text markdown [--selection-start n] [--selection-end n] [--url href] [--json]
  hasna-notes agent "prompt" [--json] [--yes] [--dry-run] [--actor-name name]
  hasna-notes agent tools [--json]
  hasna-notes settings get [--json]
  hasna-notes settings set-trash-retention <days> [--json]
  hasna-notes labels list [--json]
  hasna-notes labels create <name>
  hasna-notes labels rename <old> <new>
  hasna-notes labels delete <name>
  hasna-notes labels assign <note-id> <name>
  hasna-notes labels unassign <note-id> <name>
  hasna-notes title <id> [--apply] [--force] [--sidecar http://127.0.0.1:8765] [--json]

Data root defaults to ${dataRoot()} and can be overridden with HASNA_NOTES_ROOT.`;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq > 0 ? eq : undefined);
    const takesValue = !['json', 'apply', 'force', 'permanent', 'include-trash', 'include-archived', 'help', 'yes', 'dry-run'].includes(key);
    const value = eq > 0 ? arg.slice(eq + 1) : (takesValue ? argv[++i] : true);
    if (key === 'label') opts.label = [...(opts.label || []), value];
    else opts[key] = value;
  }
  return opts;
}

function jsonOut(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function lineOut(value) {
  process.stdout.write(String(value) + '\n');
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function noteSummary(note) {
  const labels = note.labels.length ? ` [${note.labels.join(', ')}]` : '';
  return `${note.updatedAt}  ${note.id}  ${(note.title || 'Untitled Note')}${labels}`;
}

function permanentDeletePreview(note, command) {
  return {
    ok: false,
    dryRun: true,
    requiresConfirmation: true,
    command,
    preview: {
      id: note.id,
      title: note.title || 'Untitled Note',
      status: note.status || 'active',
      permanent: true,
    },
    hint: 'Re-run with --yes to permanently delete.',
  };
}

function machineSummary(machine) {
  const status = machine.status || (machine.online === true ? 'online' : 'unknown');
  const activity = machine.recentActivityAt || machine.updatedAt || 'no-activity';
  return `${activity}  ${machine.id}  ${machine.displayName || machine.friendlyName || machine.id}  ${status}  ${machine.noteCount || 0} active note(s)`;
}

async function bodyFromOpts(opts) {
  if (opts['body-file']) return readFile(String(opts['body-file']), 'utf8');
  return String(opts.body || '');
}

async function commandList(opts) {
  const page = await listNotes({
    limit: opts.limit || DEFAULT_LIMIT,
    offset: opts.offset || 0,
    label: Array.isArray(opts.label) ? opts.label[0] : opts.label,
    machine: opts.machine,
    status: opts.status,
    includeTrash: opts['include-trash'],
    includeArchived: opts['include-archived'],
    query: opts.query,
  });
  if (opts.json) return jsonOut(page);
  for (const note of page.items) lineOut(noteSummary(note));
  if (page.hasMore) lineOut(`View more: --offset ${page.nextOffset} --limit ${page.limit}`);
}

async function commandGet(id, opts) {
  const note = await getNote(requireArg(id, 'id'));
  if (!note) throw new Error('note_not_found');
  if (opts.json) return jsonOut(note);
  lineOut(`# ${note.title || 'Untitled Note'}`);
  lineOut(`id: ${note.id}`);
  lineOut(`labels: ${note.labels.join(', ') || '(none)'}`);
  lineOut(`updatedAt: ${note.updatedAt}`);
  lineOut('');
  lineOut(note.body || '');
}

async function commandCreate(opts) {
  const now = new Date().toISOString();
  const title = String(opts.title || '').trim();
  const note = await saveNote({
    title: title || 'Untitled Note',
    body: await bodyFromOpts(opts),
    labels: normalizeLabels(opts.label || []),
    status: 'active',
    machine: opts['target-machine'] || opts.machine,
    createdByActorType: opts['actor-type'] || process.env.HASNA_NOTES_ACTOR_TYPE || 'agent',
    createdByName: opts['actor-name'] || process.env.HASNA_NOTES_ACTOR_NAME || process.env.USER || 'agent',
    sourceMachine: opts['source-machine'] || process.env.HASNA_NOTES_SOURCE_MACHINE,
    sourceMachineFriendlyName: opts['source-machine-friendly-name'] || process.env.HASNA_NOTES_SOURCE_MACHINE_NAME,
    originMachine: opts['origin-machine'] || opts['target-machine'] || opts.machine,
    originMachineFriendlyName: opts['origin-machine-friendly-name'] || opts['source-machine-friendly-name'],
    openedFrom: opts['opened-from'] || '',
    sourceContext: opts['source-context'] || '',
    titleLocked: !!title,
    titleSource: title ? 'manual' : 'default',
    titleContentFingerprint: '',
    createdAt: now,
    updatedAt: now,
  });
  if (opts.label?.length) await saveLabelList([...(await loadLabelList()), ...opts.label]);
  if (opts.json) return jsonOut(note);
  lineOut(noteSummary(note));
}

async function commandDelete(id, opts) {
  const note = await getNote(requireArg(id, 'id'));
  if (!note) throw new Error('note_not_found');
  if (opts.permanent || note.status === 'trash') {
    if (!opts.yes) {
      const preview = permanentDeletePreview(note, 'delete');
      if (opts.json) return jsonOut(preview);
      lineOut(`Permanent delete requires confirmation for "${preview.preview.title}". Re-run with --yes to delete permanently.`);
      return;
    }
    await deleteNote(note.id);
    if (opts.json) return jsonOut({ ok: true, permanent: true });
    lineOut('Permanently deleted');
    return;
  }
  const trashed = await trashNote(note.id, { retentionDays: opts['retention-days'] });
  if (opts.json) return jsonOut(trashed);
  lineOut('Moved to Trash');
}

async function commandArchive(id, opts) {
  const note = await archiveNote(requireArg(id, 'id'));
  if (opts.json) return jsonOut(note);
  lineOut(noteSummary(note));
}

async function commandTrash(id, opts) {
  const note = await trashNote(requireArg(id, 'id'), { retentionDays: opts['retention-days'], trashMachine: opts.machine });
  if (opts.json) return jsonOut(note);
  lineOut(noteSummary(note));
}

async function commandRestore(id, opts) {
  const note = await restoreNote(requireArg(id, 'id'));
  if (opts.json) return jsonOut(note);
  lineOut(noteSummary(note));
}

async function commandPurge(id, opts) {
  const note = await getNote(requireArg(id, 'id'));
  if (!note) throw new Error('note_not_found');
  if (!opts.yes) {
    const preview = permanentDeletePreview(note, 'purge');
    if (opts.json) return jsonOut(preview);
    lineOut(`Purge requires confirmation for "${preview.preview.title}". Re-run with --yes to delete permanently.`);
    return;
  }
  await deleteNote(note.id);
  if (opts.json) return jsonOut({ ok: true, permanent: true });
  lineOut('Purged');
}

async function commandCleanupTrash(opts) {
  const result = await purgeExpiredTrash();
  if (opts.json) return jsonOut(result);
  lineOut(`Purged ${result.count} expired note(s)`);
}

async function commandMove(id, machine, opts) {
  const note = await moveNoteToMachine(requireArg(id, 'id'), requireArg(machine, 'machine'), {
    targetMachineFriendlyName: opts['machine-name'],
  });
  if (opts.json) return jsonOut(note);
  lineOut(noteSummary(note));
}

async function commandMachines(action, args, opts) {
  if (action === 'list') {
    const page = await listMachineDetails({ manifestPath: opts.manifest });
    if (opts.json) return jsonOut(page);
    for (const machine of page.items) lineOut(machineSummary(machine));
    return;
  }
  if (action === 'details' || action === 'detail' || action === 'get') {
    const detail = await getMachineDetails(requireArg(args[0], 'machine'), { manifestPath: opts.manifest });
    if (opts.json) return jsonOut(detail);
    lineOut(`${detail.displayName || detail.id} (${detail.id})`);
    lineOut(`status: ${detail.status || 'unknown'}`);
    lineOut(`online: ${detail.online == null ? 'unknown' : String(detail.online)}`);
    lineOut(`platform: ${detail.platform || 'unknown'}`);
    lineOut(`notes: ${detail.noteCount || 0} active / ${detail.totalNoteCount || 0} total`);
    lineOut(`recentActivityAt: ${detail.recentActivityAt || '(none)'}`);
    return;
  }
  throw new Error('unknown_machines_command');
}

async function markdownInput(idOrText, opts) {
  if (opts.text != null) return String(opts.text);
  if (opts['body-file'] || opts['text-file']) return readFile(String(opts['body-file'] || opts['text-file']), 'utf8');
  const note = await getNote(requireArg(idOrText, 'id'));
  if (!note) throw new Error('note_not_found');
  return note.body || '';
}

async function commandMarkdown(action, args, opts) {
  if (action === 'commands' || action === 'slash-commands') {
    const out = { commands: MARKDOWN_COMMANDS };
    if (opts.json) return jsonOut(out);
    for (const command of MARKDOWN_COMMANDS) lineOut(`${command.id}\t${command.label}`);
    return;
  }
  if (action === 'render') {
    const markdown = await markdownInput(args[0], opts);
    const html = renderMarkdownSafe(markdown);
    if (opts.json) return jsonOut({ html });
    lineOut(html);
    return;
  }
  if (action === 'plain-text' || action === 'plain') {
    const text = markdownPlainText(await markdownInput(args[0], opts));
    if (opts.json) return jsonOut({ text });
    lineOut(text);
    return;
  }
  if (action === 'apply-command') {
    const result = applyMarkdownCommand(String(opts.text || ''), {
      commandId: requireArg(args[0], 'command'),
      selectionStart: opts['selection-start'],
      selectionEnd: opts['selection-end'],
      url: opts.url,
      href: opts.href,
      language: opts.language,
    });
    if (opts.json) return jsonOut(result);
    lineOut(result.markdown);
    return;
  }
  throw new Error('unknown_markdown_command');
}

async function commandSettings(action, args, opts) {
  if (action === 'get') {
    const settings = await loadSettings();
    if (opts.json) return jsonOut(settings);
    lineOut(`trashRetentionDays: ${settings.trashRetentionDays}`);
    return;
  }
  if (action === 'set-trash-retention') {
    const days = Number(requireArg(args[0], 'days'));
    const settings = await saveSettings({ trashRetentionDays: days });
    if (opts.json) return jsonOut(settings);
    lineOut(`trashRetentionDays: ${settings.trashRetentionDays}`);
    return;
  }
  throw new Error('unknown_settings_command');
}

async function commandLabels(action, args, opts) {
  if (action === 'list') {
    const labels = await loadLabelList();
    if (opts.json) return jsonOut({ labels });
    labels.forEach(lineOut);
    return;
  }
  if (action === 'create') {
    const name = requireArg(args[0], 'label');
    await saveLabelList([...(await loadLabelList()), name]);
    if (opts.json) return jsonOut({ ok: true, labels: await loadLabelList() });
    lineOut('Created');
    return;
  }
  if (action === 'rename') {
    await renameLabel(requireArg(args[0], 'old_label'), requireArg(args[1], 'new_label'));
    if (opts.json) return jsonOut({ ok: true, labels: await loadLabelList() });
    lineOut('Renamed');
    return;
  }
  if (action === 'delete') {
    await deleteLabelEverywhere(requireArg(args[0], 'label'));
    if (opts.json) return jsonOut({ ok: true, labels: await loadLabelList() });
    lineOut('Deleted');
    return;
  }
  if (action === 'assign') {
    const note = await assignLabel(requireArg(args[0], 'id'), requireArg(args[1], 'label'));
    if (opts.json) return jsonOut(note);
    lineOut(noteSummary(note));
    return;
  }
  if (action === 'unassign') {
    const note = await unassignLabel(requireArg(args[0], 'id'), requireArg(args[1], 'label'));
    if (opts.json) return jsonOut(note);
    lineOut(noteSummary(note));
    return;
  }
  throw new Error('unknown_labels_command');
}

async function commandTitle(id, opts) {
  const note = await getNote(requireArg(id, 'id'));
  if (!note) throw new Error('note_not_found');
  const text = note.body || '';
  const result = await generateTitle(text, { sidecar: opts.sidecar });
  const fingerprint = contentFingerprint(markdownPlainText(text));
  if (opts.apply) {
    if (note.titleLocked && !opts.force) throw new Error('title_locked');
    note.title = result.title;
    note.titleLocked = false;
    note.titleSource = 'generated';
    note.titleContentFingerprint = fingerprint;
    note.updatedAt = new Date().toISOString();
    await saveNote(note);
  }
  const out = { title: result.title, provider: result.provider, fingerprint, applied: !!opts.apply };
  if (opts.json) return jsonOut(out);
  lineOut(result.title);
}

async function commandAgent(args, opts) {
  if (args[0] === 'tools') {
    const out = { tools: CHAT_TOOL_SCHEMAS };
    if (opts.json) return jsonOut(out);
    for (const tool of CHAT_TOOL_SCHEMAS) {
      const flags = [
        tool.safety.readOnly ? 'read' : '',
        tool.safety.mutates ? 'write' : '',
        tool.safety.requiresConfirmation ? 'confirm' : '',
      ].filter(Boolean).join(',');
      lineOut(`${tool.name}\t${flags}\t${tool.description}`);
    }
    return;
  }
  const prompt = requireArg(args.join(' ').trim(), 'prompt');
  const events = [];
  const result = await runNotesAgent(prompt, {
    yes: !!opts.yes,
    confirmWrites: !!opts.yes,
    dryRun: !!opts['dry-run'],
    actorName: opts['actor-name'] || process.env.HASNA_NOTES_ACTOR_NAME || 'Hasna Notes CLI Agent',
    actorType: opts['actor-type'] || 'agent',
    openedFrom: opts['opened-from'] || 'cli-agent',
    sourceContext: opts['source-context'] || prompt.slice(0, 200),
    title: opts.title,
    body: opts.body,
    text: opts.text,
    limit: opts.limit,
    labels: opts.label || [],
    onEvent: event => events.push(event),
  });
  if (opts.json) return jsonOut({ ...result, events });
  lineOut(result.text);
  if (result.sources?.length) {
    lineOut('');
    lineOut('Sources:');
    for (const source of result.sources) lineOut(`- ${source.title} (${source.id})`);
  }
  if (result.pendingConfirmations?.length) {
    lineOut('');
    lineOut('Confirmation required. Re-run with --yes to apply the previewed write.');
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!cmd || cmd === 'help' || opts.help) {
    lineOut(usage());
    return;
  }
  if (cmd === 'list') return commandList(opts);
  if (cmd === 'get') return commandGet(opts._[0], opts);
  if (cmd === 'create') return commandCreate(opts);
  if (cmd === 'delete') return commandDelete(opts._[0], opts);
  if (cmd === 'archive') return commandArchive(opts._[0], opts);
  if (cmd === 'trash') return commandTrash(opts._[0], opts);
  if (cmd === 'restore') return commandRestore(opts._[0], opts);
  if (cmd === 'purge') return commandPurge(opts._[0], opts);
  if (cmd === 'cleanup-trash') return commandCleanupTrash(opts);
  if (cmd === 'move') return commandMove(opts._[0], opts._[1], opts);
  if (cmd === 'machines') return commandMachines(opts._[0], opts._.slice(1), opts);
  if (cmd === 'markdown') return commandMarkdown(opts._[0], opts._.slice(1), opts);
  if (cmd === 'settings') return commandSettings(opts._[0], opts._.slice(1), opts);
  if (cmd === 'labels') return commandLabels(opts._[0], opts._.slice(1), opts);
  if (cmd === 'title') return commandTitle(opts._[0], opts);
  if (cmd === 'agent' || cmd === 'chat') return commandAgent(opts._, opts);
  throw new Error('unknown_command');
}

main().catch((err) => {
  process.stderr.write(`hasna-notes: ${err.message || err}\n`);
  process.exitCode = 1;
});
