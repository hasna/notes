import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_PATH, DEFAULT_API_URL } from '../cloud/index.mjs';

async function readTree(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.build', 'dist'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await readTree(path, files);
    else if (/\.(mjs|js|json|md|swift|ts|yml|yaml)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('package boundary', () => {
  test('uses the PersonalNotes public package identity', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('@hasna/personalnotes');
    expect(pkg.bin.personalnotes).toBe('bin/personalnotes.mjs');
    expect(pkg.bin['personalnotes-mcp']).toBe('bin/personalnotes-mcp.mjs');
    expect(pkg.exports['./cloud']).toBe('./cloud/index.mjs');
  });

  test('cloud client defaults to hosted API and user config path', () => {
    expect(DEFAULT_API_URL).toBe('https://personalnotes.ai');
    expect(CONFIG_PATH).toContain('.config/personalnotes/config.json');
  });

  test('public package does not include platform-only secrets or deployment code', async () => {
    const root = new URL('..', import.meta.url).pathname;
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const files = [];
    for (const entry of [...pkg.files, 'package.json']) {
      await readTree(join(root, entry), files).catch(async () => {
        files.push(join(root, entry));
      });
    }
    const combined = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(combined).not.toContain('@hasnatools/');
    expect(combined).not.toContain('platform-personalnotes');
    expect(combined).not.toContain('STRIPE_SECRET_KEY');
    expect(combined).not.toContain('STRIPE_WEBHOOK_SECRET');
    expect(combined).not.toContain('~/.secrets/hasna');
  });
});
