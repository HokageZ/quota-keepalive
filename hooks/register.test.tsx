import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const MINUTE = 60_000

const PANE = {
  plugin: 'quota-keepalive',
  component: 'Pane',
  requestId: 'quota',
  props: {
    title: 'Quota',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The engine beneath the mod: plan readings, prompts it submits, agents, commands.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], readings: { five: number; week: number; weekResetsIn: number }, now: () => number, withStore = true) {
  const pings: string[] = []
  const start = now()
  on('ui.toast', () => ({ value: undefined }))
  if (withStore) mock.store(on)
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: 10 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: readings.five, resetsAt: new Date(start + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: readings.week, resetsAt: new Date(start + readings.weekResetsIn).toISOString() },
      ],
    },
  }))
  on('prompt.submit', (_, e) => {
    pings.push(e.text)
    return { text: e.text }
  })
  return pings
}

test('the pane draws its controls on every surface; keep warm, then pause work until then', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^5-hour limit$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^20%$/ }))?.text).toBeTruthy()
    expect(await ui.find({ key: 'refresh' })).toBeTruthy()
    for (const key of ['keep-off', 'keep-1', 'keep-2', 'keep-4', 'keep-reset']) expect(await ui.find({ key })).toBeTruthy()
    // Nothing to pause until a keep-warm end is picked.
    expect(await ui.find({ key: 'pause-work' })).toBeFalsy()
    expect(await ui.find({ key: 'model-week' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'keep-2' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Keeping warm until/ }))?.text).toBeTruthy()
  await ui.press({ key: 'pause-work' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Work paused until/ }))?.text).toBeTruthy()
  expect(await ui.find({ key: 'continue' })).toBeTruthy()

  await ui.press({ key: 'continue' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Not keeping warm$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('a pause pings the main session on the cache clock and retries a ping that did not land', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const at = new Date(clock.now() + 3 * HOUR)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  await $.command.run({ command: 'quota', args: `pause until ${hhmm}` })

  const keepAlive = () => pings.filter(t => t.startsWith('Keep-alive ping')).length
  await clock.advance(44 * MINUTE)
  expect(keepAlive()).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(keepAlive()).toBe(1)
  // No turn wrote the cache after that ping (it did not land): tried again 5 minutes on, not 45.
  await clock.advance(5 * MINUTE)
  expect(keepAlive()).toBe(2)
})

test('a weekly quota pause days from its reset sends no keep-alive pings', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 99.5, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3 * HOUR)
  expect(pings.filter(t => t.startsWith('Keep-alive ping')).length).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Work paused by the Weekly/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('settings live in the panel and are saved for the next session', async ($, on) => {
  const saved: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    saved.push(e)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now, false)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 't-mainStop-95' })).toBeFalsy()
    await ui.press({ key: 'settings' })
    await clock.settle()
    expect(await ui.find({ key: 't-mainStop-95' })).toBeTruthy()
    expect(await ui.find({ key: 'sim-main' })).toBeTruthy()
    // The keep-warm rule is explained once, on the page, not in Settings.
    expect((await ui.find({ type: 'Text', text: /at most 50 minutes apart/ }))?.text).toBeTruthy()
    await ui.press({ key: 'settings' })
    await clock.settle()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  await clock.settle()
  await ui.press({ key: 't-mainStop-95' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Main stop set to 95%/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /main stops 95%/ }))?.text).toBeTruthy()
  // Test mode from a scenario chip: the main stop fires and pauses the session.
  await ui.press({ key: 'sim-main' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Work paused by the 5-hour limit/ }))?.text).toBeTruthy()
  // The model's weekly percent is picked, not typed.
  await ui.select({ key: 'model-week', value: '42' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.text).toBeTruthy()
  expect(JSON.stringify(saved.at(-1))).toContain('"mainStop":95')
  await ui.unmount()
})

test('the panel follows new readings by itself within 15 seconds, no Refresh pressed', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const readings = { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }
  engine(on, readings, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^20%$/ }))?.text).toBeTruthy()
  readings.five = 35
  await clock.advance(15_000)
  expect((await ui.find({ type: 'Text', text: /^35%$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('at 100% of a limit the keep-alive stands down: no pings, and the panel says why', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 100, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(2 * HOUR)
  expect(pings.filter(t => t.startsWith('Keep-alive ping')).length).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /limit is at 100%/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('keep warm until a reset 3 hours off plans 3 pings, 45 minutes apart', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'keep-reset' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^45m$/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^3$/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^pings left$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

// A reply that read the cache, as the engine would stream it: the mod records the cache write.
async function reply($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of stream) {
    // chunks are not needed here
  }
  return stream.result
}

function engineStep(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
    } as never
  })
}

test('keep warm 2h while idle: pings 40 minutes apart, then it ends by itself', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // A reply writes the cache, then the person picks 2 hours and steps away.
  await reply($, on)
  await ui.press({ key: 'keep-2' })
  await clock.settle()
  const keepAlive = () => pings.filter(t => t.startsWith('Keep-alive ping')).length

  // 2 hours in gaps of at most 50 minutes: 3 equal gaps of 40 minutes.
  await clock.advance(39 * MINUTE)
  expect(keepAlive()).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(keepAlive()).toBe(1)
  await reply($, on) // the ping's reply writes the cache
  await clock.advance(41 * MINUTE)
  expect(keepAlive()).toBe(2)
  await reply($, on)
  // The rest of the 2 hours is under 50 minutes: no more pings, and it ends at the 2-hour mark.
  await clock.advance(40 * MINUTE)
  expect(keepAlive()).toBe(2)
  expect((await ui.find({ type: 'Text', text: /^Not keeping warm$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('your own replies count: one that writes the cache moves the next ping back', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await reply($, on)
  await ui.press({ key: 'keep-1' })
  await clock.settle()
  // 1 hour alone would take a ping at 30 minutes; a reply at 25 minutes leaves 35, under 50.
  await clock.advance(25 * MINUTE)
  await reply($, on)
  await clock.advance(34 * MINUTE)
  expect(pings.filter(t => t.startsWith('Keep-alive ping')).length).toBe(0)
  await ui.unmount()
})

test('the bridge: a stop level pauses work by itself and keeps the cache warm to the reset, then work continues', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  // 98.5% of the 5-hour limit, which resets in 3 hours: past the 98% main stop.
  const readings = { five: 98.5, week: 30, weekResetsIn: 4 * 24 * HOUR }
  const pings = engine(on, readings, clock.now)
  engineStep(on)
  const rows = mock.session(on)
  await reply($, on) // the last reply wrote the cache
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Work paused by the 5-hour limit/ }))?.text).toBeTruthy()
  expect(JSON.stringify(rows.appended())).toContain('stop starting new work')

  // 3 hours to the reset: pings at 45, 90 and 135 minutes.
  const keepAlive = () => pings.filter(t => t.startsWith('Keep-alive ping')).length
  await clock.advance(44 * MINUTE)
  expect(keepAlive()).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(keepAlive()).toBe(1)
  await reply($, on)
  await clock.advance(45 * MINUTE)
  expect(keepAlive()).toBe(2)
  await reply($, on)

  // The window reads low again (a reset): on the next pass the pause ends and the main session
  // is told to continue. The third ping at 135 minutes is the logic tests' to check.
  readings.five = 2
  await clock.advance(15_000)
  expect(pings.some(t => t.startsWith('The quota window reset.'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^Not keeping warm$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

const BAND = {
  plugin: 'quota-keepalive',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 120 },
} as const

test('the band above the prompt: cache time left and what to re-cache; Settings opens the panel', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await reply($, on)
  await clock.advance(15 * MINUTE)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /^Prompt cache$/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^45m left$/ }))?.text).toBeTruthy()
    // 10 input + 50,000 read + 20 output: the next message re-caches about 50k tokens.
    expect((await band.find({ type: 'Text', text: /^50k$/ }))?.text).toBeTruthy()
    // No hit rate or misses here, and no warning at 20%.
    expect(await band.find({ type: 'Text', text: /hit|miss|heads-up/ })).toBeFalsy()
    await band.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'band-settings' })
  await clock.settle()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 't-mainStop-95' })).toBeTruthy()
  await pane.unmount()
})

test('the band shows our warning at the heads-up level', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 91, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await reply($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^5-hour 91%: heads-up$/ }))?.text).toBeTruthy()
  await band.unmount()
})

test('at the stop the band shows the pause and the pings that keep the cache to the reset', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 98.5, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await reply($, on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /^Work paused until/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^3 pings 45m apart · next 45m$/ }))?.text).toBeTruthy()
    await band.unmount()
  }
})
