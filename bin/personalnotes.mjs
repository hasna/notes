#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  CONFIG_PATH,
  clearCloudConfig,
  createCloudClient,
  loadCloudConfig,
  saveCloudConfig,
} from '../cloud/index.mjs';

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
    const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
    opts[key] = value;
  }
  return opts;
}

function jsonOut(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function line(value) {
  process.stdout.write(String(value) + '\n');
}

function usage() {
  return `PersonalNotes CLI

Usage:
  personalnotes auth login --email you@example.com [--json]
  personalnotes auth verify --email you@example.com --code 123456 [--json]
  personalnotes auth device [--json]
  personalnotes auth device-token --device-code dc_... [--json]
  personalnotes auth device-exchange --exchange-token dt_... [--json]
  personalnotes auth device-approve --user-code XXXX-XXXX [--json]
  personalnotes auth whoami [--json]
  personalnotes auth logout
  personalnotes cloud status [--json]
  personalnotes cloud list [--limit 10] [--json]
  personalnotes cloud create --title title --body markdown [--json]
  personalnotes cloud sync [--json]
  personalnotes billing status [--json]
  personalnotes billing checkout [--json]

Local note commands are still available through this binary and the legacy hasna-notes alias.`;
}

async function print(value, opts, fallback) {
  if (opts.json) return jsonOut(value);
  line(fallback ?? JSON.stringify(value, null, 2));
}

async function handleHosted(cmd, args, opts) {
  const client = await createCloudClient({ apiUrl: opts['api-url'], apiKey: opts['api-key'], token: opts.token });
  if (cmd === 'auth') {
    const action = args[0];
    if (action === 'login') {
      const result = await client.startLogin(opts.email);
      return print(result, opts, result.devCode ? `Login code created for ${result.email}: ${result.devCode}` : `Login code sent to ${result.email}`);
    }
    if (action === 'verify') {
      const result = await client.verifyLogin({ email: opts.email, code: opts.code, name: opts.name });
      const existing = await loadCloudConfig();
      await saveCloudConfig({ ...existing, apiUrl: client.config.apiUrl, token: result.token, apiKey: result.apiKey });
      return print(result, opts, `Signed in. Config saved to ${CONFIG_PATH}`);
    }
    if (action === 'device') {
      const result = await client.startDeviceLogin();
      return print(result, opts, `Open ${result.verificationUri} and enter code ${result.userCode}`);
    }
    if (action === 'device-token') {
      const result = await client.pollDeviceLogin(opts['device-code']);
      if (result.apiKey) {
        const existing = await loadCloudConfig();
        await saveCloudConfig({ ...existing, apiUrl: client.config.apiUrl, apiKey: result.apiKey });
        return print(result, opts, `Device login complete. Config saved to ${CONFIG_PATH}`);
      }
      return print(result, opts, result.message || `Device login status: ${result.status}`);
    }
    if (action === 'device-exchange') {
      const result = await client.exchangeDeviceLogin(opts['exchange-token']);
      if (result.apiKey) {
        const existing = await loadCloudConfig();
        await saveCloudConfig({ ...existing, apiUrl: client.config.apiUrl, apiKey: result.apiKey });
        return print(result, opts, `Device login complete. Config saved to ${CONFIG_PATH}`);
      }
      return print(result, opts, result.message || 'Device exchange complete.');
    }
    if (action === 'device-approve') {
      const result = await client.approveDeviceLogin(opts['user-code']);
      if (result.apiKey) {
        const existing = await loadCloudConfig();
        await saveCloudConfig({ ...existing, apiUrl: client.config.apiUrl, apiKey: result.apiKey });
      }
      return print(result, opts, result.apiKey ? `Device approved. Config saved to ${CONFIG_PATH}` : 'Device approved. Return to the requesting device to finish login.');
    }
    if (action === 'whoami') return print(await client.whoami(), opts);
    if (action === 'logout') {
      await clearCloudConfig();
      return line(`Cleared ${CONFIG_PATH}`);
    }
  }
  if (cmd === 'cloud') {
    const action = args[0];
    if (action === 'status') return print(await client.apiInfo(), opts);
    if (action === 'list') return print(await client.listNotes({ limit: opts.limit }), opts);
    if (action === 'create') return print(await client.createNote({ title: opts.title, bodyMarkdown: opts.body || '' }), opts);
    if (action === 'sync') return print(await client.sync({ items: [] }, opts['idempotency-key'] || randomUUID()), opts);
  }
  if (cmd === 'billing') {
    const action = args[0];
    if (action === 'status') return print(await client.billingStatus(), opts);
    if (action === 'checkout') return print(await client.billingCheckout(), opts);
  }
  throw new Error('unknown_hosted_command');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || opts.help) {
    line(usage());
    return;
  }
  if (cmd === 'auth' || cmd === 'cloud' || cmd === 'billing') {
    return handleHosted(cmd, opts._, opts);
  }
  await import('../cli/hasna-notes.mjs');
}

main().catch((err) => {
  process.stderr.write(`personalnotes: ${err.message || err}\n`);
  process.exitCode = 1;
});
