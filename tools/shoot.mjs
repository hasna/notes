// Screenshot harness for the Hasna Notes web UI.
// Renders each screen at retina scale and writes PNGs for visual review.
//
// The notes app is data-driven and (mostly) hash-free: selection, machine-filter and
// settings are driven by clicks, not URL hashes — so this harness DRIVES the UI the
// way a user would (click a note, click a machine row, click the gear) and screenshots
// the result. It uses the in-browser SAMPLE data (no native __BOOT__).
//
// Usage:
//   PLAYWRIGHT_BROWSERS_PATH=/home/hasna/.cache/ms-playwright \
//   node tools/shoot.mjs [screen ...]
//
// Screens: notes, machines, settings, native (body.native top-inset check).
// With no args it shoots them all. Output: tools/shots/<screen>.png
import playwright from '/home/hasna/.bun/install/global/node_modules/playwright/index.js'
const { chromium } = playwright
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const indexURL = 'file://' + resolve(root, 'web/index.html')
const outDir = resolve(root, 'tools/shots')
mkdirSync(outDir, { recursive: true })

const VIEWPORT = { width: 1280, height: 816 }
const SCALE = 2

const SCREENS = [
  'notes', 'machines', 'settings', 'native', 'home', 'home-noai', 'ctxmenu', 'compact',
  // UI/UX polish-pass screens:
  'sidebar', 'home-copy', 'recording', 'recording-paused', 'editor-recording',
  'settings-recording', 'transcript',
  // Notes page (full list) + Machines under Settings + inline record-in-pill:
  'noteslist', 'machines-settings', 'qn-record', 'qn-typing',
  // Dark-theme verification + sidebar overflow (thin scrollbar near the edge):
  'dark-home', 'dark-recording', 'sidebar-scroll',
]
const want = process.argv.slice(2)
const screens = want.length ? want : SCREENS

const browser = await chromium.launch()

// Inject a fake recording-active state into the running app so the timer-in-circle, the
// pause control, the persistent pill and (optionally) the transcript surface can be
// captured headlessly — the real MediaRecorder/streaming backend can't run in CI.
async function fakeRecording(page, { paused = false, transcript = null } = {}) {
  await page.evaluate((opts) => {
    // Drive the public state machine the way the host would, then force the UI.
    // The record control now lives INSIDE the quick-note pill (#qn-form).
    const wrap = document.getElementById('qn-form')
    if (wrap) { wrap.classList.add('recording'); if (opts.paused) wrap.classList.add('paused') }
    const recBtn = document.getElementById('rec-btn')
    if (recBtn) recBtn.hidden = false
    // Reach into the module via the exposed surface where possible; fall back to DOM.
    const timerIn = document.getElementById('rec-timer-in')
    if (timerIn) timerIn.textContent = '0:42'
    // Persistent pill — fixed, on every screen.
    const pill = document.getElementById('rec-pill')
    if (pill) {
      pill.hidden = false
      pill.classList.toggle('paused', !!opts.paused)
      const t = document.getElementById('rec-pill-timer'); if (t) t.textContent = '0:42'
      const pp = document.getElementById('rec-pill-pause'); if (pp) pp.title = opts.paused ? 'Resume' : 'Pause'
    }
    if (opts.transcript) {
      const surface = document.getElementById('transcript')
      const fin = document.getElementById('transcript-final')
      const par = document.getElementById('transcript-partial')
      if (surface) surface.hidden = false
      if (fin) fin.textContent = opts.transcript.final ? opts.transcript.final + ' ' : ''
      if (par) par.textContent = opts.transcript.partial || ''
    }
  }, { paused, transcript })
}

// A boot payload with many notes/machines so list overflow → scrollbar is visible and the
// "View more" affordance appears.
async function manyNotesBoot(page) {
  await page.addInitScript(() => {
    const now = Date.now()
    const iso = (ms) => new Date(ms).toISOString()
    const labels = ['welcome', 'docs', 'release', 'meeting', 'sync', 'ideas', 'todo']
    const machines = []
    for (let i = 0; i < 14; i++) machines.push({ id: 'machine' + String(i).padStart(3, '0') })
    const notes = []
    for (let i = 0; i < 22; i++) {
      notes.push({
        id: 'n-' + i,
        title: ['Release checklist', 'Meeting notes — fleet sync', 'Ideas for the roadmap',
          'Welcome to Hasna Notes', 'Quarterly planning thoughts', 'Bug triage list'][i % 6] + ' ' + (i + 1),
        body: 'Some note body content number ' + i + ' with a few words to preview.',
        labels: [labels[i % labels.length]],
        status: 'active', folder: '',
        machine: machines[i % machines.length].id,
        updatedAt: iso(now - i * 1000 * 60 * 47),
        createdAt: iso(now - i * 1000 * 60 * 60),
      })
    }
    window.__BOOT__ = { thisMachine: 'machine000', machines, notes }
    window.__AI__ = { port: 8765, available: true }
  })
}

// Inject a fake window.__AI__ BEFORE app.js runs so AI-gated UI (the record button)
// can be rendered in its available / unavailable states without a live sidecar.
async function freshPage(nativeMode = false, aiAvailable = null) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
  const page = await ctx.newPage()
  if (aiAvailable !== null) {
    await page.addInitScript((available) => {
      window.__AI__ = { port: 8765, available: available }
    }, aiAvailable)
  }
  await page.goto(indexURL, { waitUntil: 'networkidle' })
  if (nativeMode) {
    // Mirror the macOS WKWebView host, which adds the `native` class to <html> and
    // <body> so the window goes full-bleed and the ~30px native top-inset applies.
    await page.evaluate(() => {
      document.documentElement.classList.add('native')
      document.body.classList.add('native')
    })
  }
  await page.waitForTimeout(250)
  return { ctx, page }
}

// Force the persisted dark theme BEFORE app.js runs so initTheme() applies it on boot.
async function darkPage(aiAvailable = true) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: 'dark' })
  const page = await ctx.newPage()
  await page.addInitScript((available) => {
    try { localStorage.setItem('hasna-notes-theme', 'dark') } catch (e) {}
    window.__AI__ = { port: 8765, available: available }
  }, aiAvailable)
  await page.goto(indexURL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(250)
  return { ctx, page }
}

async function shoot(page, name) {
  const out = resolve(outDir, `${name}.png`)
  await page.screenshot({ path: out })
  console.log('shot', name, '->', out)
}

for (const s of screens) {
  if (s === 'notes') {
    const { ctx, page } = await freshPage()
    // Click the second note so selection is visibly highlighted in a non-default slot.
    const rows = page.locator('.note-row')
    if (await rows.count() > 1) await rows.nth(1).click()
    await page.waitForTimeout(150)
    await shoot(page, 'notes')
    await ctx.close()
  } else if (s === 'machines') {
    const { ctx, page } = await freshPage()
    // Click a specific machine row (machine001) to filter the notes list.
    const m = page.locator('.machine-row[data-machine="machine001"]')
    if (await m.count()) await m.click()
    await page.waitForTimeout(150)
    await shoot(page, 'machines')
    await ctx.close()
  } else if (s === 'settings') {
    const { ctx, page } = await freshPage()
    await page.locator('#open-settings').click()
    await page.waitForTimeout(150)
    await shoot(page, 'settings')
    await ctx.close()
  } else if (s === 'noteslist') {
    // The dedicated full Notes page, reached from the sidebar "View more" / Home "All notes".
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
    const page = await ctx.newPage()
    await manyNotesBoot(page)
    await page.goto(indexURL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(200)
    await page.locator('#home-all-notes').click()
    await page.waitForTimeout(200)
    await shoot(page, 'noteslist')
    await ctx.close()
  } else if (s === 'machines-settings') {
    // The fuller Machines list living under Settings → Machines.
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
    const page = await ctx.newPage()
    await manyNotesBoot(page)
    await page.goto(indexURL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(200)
    await page.locator('#open-settings').click()
    await page.locator('.set-item[data-tab="machines"]').click()
    await page.waitForTimeout(200)
    await shoot(page, 'machines-settings')
    await ctx.close()
  } else if (s === 'qn-record') {
    // Quick-note pill idle: the embedded purple "Record" control.
    const { ctx, page } = await freshPage(false, true)
    await page.waitForTimeout(150)
    await shoot(page, 'qn-record')
    await ctx.close()
  } else if (s === 'qn-typing') {
    // Quick-note pill with text typed → the control switches to Add (submit).
    const { ctx, page } = await freshPage(false, true)
    await page.locator('#qn-input').fill('Pick up groceries after work')
    await page.waitForTimeout(150)
    await shoot(page, 'qn-typing')
    await ctx.close()
  } else if (s === 'dark-home') {
    const { ctx, page } = await darkPage(true)
    await shoot(page, 'dark-home')
    await ctx.close()
  } else if (s === 'dark-recording') {
    const { ctx, page } = await darkPage(true)
    await fakeRecording(page, { paused: false })
    await page.waitForTimeout(150)
    await shoot(page, 'dark-recording')
    await ctx.close()
  } else if (s === 'sidebar-scroll') {
    // Many notes/machines so the sidebar nav overflows → the thin scrollbar shows near
    // the sidebar's right edge. Force a scroll so the bar is rendered.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: SCALE })
    const page = await ctx.newPage()
    await manyNotesBoot(page)
    await page.goto(indexURL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(200)
    await page.evaluate(() => { const n = document.querySelector('.sidebar-nav'); if (n) n.scrollTop = 80 })
    await page.waitForTimeout(150)
    await shoot(page, 'sidebar-scroll')
    await ctx.close()
  } else if (s === 'native') {
    const { ctx, page } = await freshPage(true)
    await page.waitForTimeout(150)
    await shoot(page, 'native')
    await ctx.close()
  } else if (s === 'home') {
    // Home is the default landing screen; fake AI available so the record button is live-styled.
    const { ctx, page } = await freshPage(false, true)
    await page.waitForTimeout(150)
    await shoot(page, 'home')
    await ctx.close()
  } else if (s === 'home-noai') {
    // Home with AI unavailable → record button disabled + "needs an OpenAI key" label.
    const { ctx, page } = await freshPage(false, false)
    await page.waitForTimeout(150)
    await shoot(page, 'home-noai')
    await ctx.close()
  } else if (s === 'ctxmenu') {
    // Open the right-click context menu on a note row.
    const { ctx, page } = await freshPage(false, true)
    // Switch to the notes screen first by clicking a note, then right-click a row.
    const rows = page.locator('.note-row')
    if (await rows.count()) {
      const row = rows.nth(1)
      const box = await row.boundingBox()
      await row.click({ button: 'right' })
      await page.waitForTimeout(150)
    }
    await shoot(page, 'ctxmenu')
    await ctx.close()
  } else if (s === 'compact') {
    // Compact / quick-note layout. In a browser the native window won't resize, but the
    // web layout switches to the compact shell — render it at a small viewport to match.
    const ctx = await browser.newContext({ viewport: { width: 380, height: 220 }, deviceScaleFactor: SCALE })
    const page = await ctx.newPage()
    await page.addInitScript(() => { window.__AI__ = { port: 8765, available: true } })
    await page.goto(indexURL, { waitUntil: 'networkidle' })
    // Native mode → full-bleed window (matches the resized native quick-note window).
    await page.evaluate(() => {
      document.documentElement.classList.add('native')
      document.body.classList.add('native')
    })
    await page.waitForTimeout(150)
    await page.locator('#win-min').click()
    await page.waitForTimeout(200)
    await shoot(page, 'compact')
    await ctx.close()
  } else if (s === 'sidebar') {
    // Many notes + machines: Labels section near top, note rows with subtle age, machines
    // ≤10 + View more, settings icon size, thin/light scrollbar near the right edge.
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
    const page = await ctx.newPage()
    await manyNotesBoot(page)
    await page.goto(indexURL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(250)
    await shoot(page, 'sidebar')
    await ctx.close()
  } else if (s === 'home-copy') {
    // Home recent cards with a forced :hover so the copy button is captured.
    const { ctx, page } = await freshPage(false, true)
    const card = page.locator('.home-card').first()
    if (await card.count()) await card.hover()
    await page.waitForTimeout(150)
    await shoot(page, 'home-copy')
    await ctx.close()
  } else if (s === 'recording') {
    // Recording-active: timer inside the circle, pause control, persistent pill (home).
    const { ctx, page } = await freshPage(false, true)
    await fakeRecording(page, { paused: false })
    await page.waitForTimeout(150)
    await shoot(page, 'recording')
    await ctx.close()
  } else if (s === 'recording-paused') {
    const { ctx, page } = await freshPage(false, true)
    await fakeRecording(page, { paused: true })
    await page.waitForTimeout(150)
    await shoot(page, 'recording-paused')
    await ctx.close()
  } else if (s === 'editor-recording') {
    // Persistent recording pill must show on the editor (a non-home screen) too.
    const { ctx, page } = await freshPage(false, true)
    const rows = page.locator('.note-row')
    if (await rows.count()) await rows.nth(0).click()
    await fakeRecording(page, { paused: false })
    await page.waitForTimeout(150)
    await shoot(page, 'editor-recording')
    await ctx.close()
  } else if (s === 'settings-recording') {
    // Persistent recording pill must show on Settings too.
    const { ctx, page } = await freshPage(false, true)
    await page.locator('#open-settings').click()
    await fakeRecording(page, { paused: false })
    await page.waitForTimeout(150)
    await shoot(page, 'settings-recording')
    await ctx.close()
  } else if (s === 'transcript') {
    // Transcript surface: committed final + muted trailing partial, no layout jank.
    const { ctx, page } = await freshPage(false, true)
    await fakeRecording(page, {
      paused: false,
      transcript: {
        final: 'This is the committed transcript so far. It keeps the recent text in view.',
        partial: 'and this trailing partial line is still being recognized',
      },
    })
    await page.waitForTimeout(150)
    await shoot(page, 'transcript')
    await ctx.close()
  } else {
    console.log('unknown screen:', s)
  }
}

await browser.close()
