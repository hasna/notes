import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_API_URL = 'https://personalnotes.ai';
export const CONFIG_PATH = process.env.PERSONALNOTES_CONFIG || join(homedir(), '.config', 'personalnotes', 'config.json');

export class PersonalNotesCloudError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'PersonalNotesCloudError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function loadCloudConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveCloudConfig(config, path = CONFIG_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

export async function clearCloudConfig(path = CONFIG_PATH) {
  return saveCloudConfig({}, path);
}

export async function resolveCloudConfig(overrides = {}) {
  const file = await loadCloudConfig(overrides.configPath || CONFIG_PATH);
  return {
    apiUrl: overrides.apiUrl || process.env.PERSONALNOTES_API_URL || file.apiUrl || DEFAULT_API_URL,
    apiKey: overrides.apiKey || process.env.PERSONALNOTES_API_KEY || file.apiKey,
    token: overrides.token || process.env.PERSONALNOTES_TOKEN || file.token,
    configPath: overrides.configPath || CONFIG_PATH,
  };
}

function headers(config, extra = {}) {
  const token = config.apiKey || config.token;
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export class PersonalNotesCloudClient {
  constructor(config = {}) {
    this.config = {
      apiUrl: (config.apiUrl || DEFAULT_API_URL).replace(/\/$/, ''),
      apiKey: config.apiKey,
      token: config.token,
    };
  }

  async request(method, path, { body, headers: headerOverrides } = {}) {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: headers(this.config, headerOverrides),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = json?.error || {};
      throw new PersonalNotesCloudError(err.message || `PersonalNotes API ${method} ${path} failed`, {
        status: res.status,
        code: err.code,
        details: err.details,
      });
    }
    return json;
  }

  health() {
    return this.request('GET', '/health');
  }

  apiInfo() {
    return this.request('GET', '/api/v1');
  }

  startLogin(email) {
    return this.request('POST', '/api/v1/auth/login', { body: { email } });
  }

  verifyLogin({ email, code, name }) {
    return this.request('POST', '/api/v1/auth/verify', { body: { email, code, name } });
  }

  startDeviceLogin() {
    return this.request('POST', '/api/v1/auth/device/start', { body: {} });
  }

  pollDeviceLogin(deviceCode) {
    return this.request('POST', '/api/v1/auth/device/token', { body: { deviceCode } });
  }

  exchangeDeviceLogin(exchangeToken) {
    return this.request('POST', '/api/v1/auth/device/exchange', { body: { exchangeToken } });
  }

  approveDeviceLogin(userCode) {
    return this.request('POST', '/api/v1/auth/device/approve', { body: { userCode } });
  }

  whoami() {
    return this.request('GET', '/api/v1/auth/whoami');
  }

  listNotes(params = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.includeDeleted) qs.set('include_deleted', '1');
    const suffix = qs.size ? `?${qs}` : '';
    return this.request('GET', `/api/v1/notes${suffix}`);
  }

  getNote(id) {
    return this.request('GET', `/api/v1/notes/${encodeURIComponent(id)}`);
  }

  createNote(input) {
    return this.request('POST', '/api/v1/notes', { body: input });
  }

  updateNote(id, input) {
    return this.request('PATCH', `/api/v1/notes/${encodeURIComponent(id)}`, { body: input });
  }

  deleteNote(id) {
    return this.request('DELETE', `/api/v1/notes/${encodeURIComponent(id)}`);
  }

  sync(input, idempotencyKey = `sync-${Date.now()}-${randomUUID()}`) {
    return this.request('POST', '/api/v1/sync', {
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  exportNotes() {
    return this.request('POST', '/api/v1/export', { body: {} });
  }

  billingStatus() {
    return this.request('GET', '/api/v1/billing/status');
  }

  billingCheckout() {
    return this.request('POST', '/api/v1/billing/checkout', { body: {} });
  }
}

export async function createCloudClient(overrides = {}) {
  return new PersonalNotesCloudClient(await resolveCloudConfig(overrides));
}
