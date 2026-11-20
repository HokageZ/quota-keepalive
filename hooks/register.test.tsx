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
    for (const key of ['keep-off', 'keep-1', 'keep-2', 'keep-4', 'keep-reset', 'keep-always', 'tab-overview', 'tab-settings']) expect(await ui.find({ key })).toBeTruthy()
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

  const keepAlive = () => pings.filter(t => t === 'ping').length
  await clock.advance(44 * MINUTE)
  expect(keepAlive()).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(keepAlive()).toBe(1)
  // No turn wrote the cache after that ping (it did not land): tried again 5 minutes on, not 45.
  await clock.advance(5 * MINUTE)
  expect(keepAlive()).toBe(2)
  // Once the cache is past its hour with no write, it is gone: no more retries every 5 minutes.
  await clock.advance(5 * MINUTE)
  expect(keepAlive()).toBe(3)
  await clock.advance(2 * HOUR)
  expect(keepAlive()).toBe(3)
})

test('a weekly quota pause days from its reset sends no keep-alive pings', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 99.5, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3 * HOUR)
  expect(pings.filter(t => t === 'ping').length).toBe(0)

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
    // The keep-warm rule is explained on the overview, beside its controls.
    expect((await ui.find({ type: 'Text', text: /at most 50 minutes apart/ }))?.text).toBeTruthy()
    await ui.press({ key: 'tab-settings' })
    await clock.settle()
    expect(await ui.find({ key: 't-mainStop-95' })).toBeTruthy()
    expect(await ui.find({ key: 'sim-main' })).toBeTruthy()
    expect(await ui.find({ key: 'default-always' })).toBeTruthy()
    // Settings is its own page: the overview's cards are not drawn under it.
    expect(await ui.find({ key: 'keep-always' })).toBeFalsy()
    await ui.press({ key: 'tab-overview' })
    await clock.settle()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  await clock.settle()
  await ui.press({ key: 't-mainStop-95' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Main stop set to 95%/ }))?.text).toBeTruthy()
  // Test mode from a scenario chip: the main stop fires and pauses the session.
  await ui.press({ key: 'sim-main' })
  await clock.settle()
  await ui.press({ key: 'tab-overview' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /main stops 95%/ }))?.text).toBeTruthy()
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
  expect(pings.filter(t => t === 'ping').length).toBe(0)

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
  const keepAlive = () => pings.filter(t => t === 'ping').length

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
  expect(pings.filter(t => t === 'ping').length).toBe(0)
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
  const keepAlive = () => pings.filter(t => t === 'ping').length
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
    expect((await band.find({ type: 'Text', text: surface === 'desktop' ? /^Prompt cache$/ : /cache$/ }))?.text).toBeTruthy()
    // cache-countdown's own wording on each surface.
    if (surface === 'desktop') {
      expect((await band.find({ type: 'Text', text: /^45 min left$/ }))?.text).toBeTruthy()
      expect((await band.find({ type: 'Text', text: /^of 60 min$/ }))?.text).toBeTruthy()
    } else {
      expect((await band.find({ type: 'Text', text: /^45m$/ }))?.text).toBeTruthy()
    }
    // 50,000 read from the cache: 50k cached, and the 10 uncached tokens are the misses.
    expect((await band.find({ type: 'Text', text: /^cached$/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^50k$/ }))?.text).toBeTruthy()
    // What a re-cache would write if the cache lapsed: 10 input + 50,000 read + 20 output, about 50k.
    expect((await band.find({ type: 'Text', text: surface === 'desktop' ? /^to re-cache$/ : /^re-cache$/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^miss$/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^0%$/ }))?.text).toBeTruthy()
    // No warning at 20%.
    expect(await band.find({ type: 'Text', text: /heads-up/ })).toBeFalsy()
    await band.unmount()
  }

  // Quota on the band opens the panel on its overview.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'band-open' })
  await clock.settle()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 'keep-always' })).toBeTruthy()
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
    expect((await band.find({ type: 'Text', text: /^Paused until/ }))?.text).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /^3 pings · next 45m$/ }))?.text).toBeTruthy()
    // While paused the row keeps to what matters: the re-cache cost stays; "cached" and "of 60 min" go.
    expect((await band.find({ type: 'Text', text: /^(to )?re-cache$/ }))?.text).toBeTruthy()
    expect(await band.find({ type: 'Text', text: /^cached$|of 60 min/ })).toBeFalsy()
    expect(await band.find({ key: 'band-open' })).toBeTruthy()
    await band.unmount()
  }
})

test('keep warm always: pings every 50 minutes of idle with no end, until Off', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  const pings = engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await reply($, on)
  await ui.press({ key: 'keep-always' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Keeping warm · always on$/ }))?.text).toBeTruthy()
  // No end time, so nothing to pause until, and the plan has no count of pings left.
  expect(await ui.find({ key: 'pause-work' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^until you stop$/ }))?.text).toBeTruthy()

  const count = () => pings.filter(t => t === 'ping').length
  await clock.advance(49 * MINUTE)
  expect(count()).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(count()).toBe(1)
  // Hours past any timed choice, it keeps going: each ping's reply writes the cache again.
  for (let i = 0; i < 6; i++) {
    await reply($, on)
    await clock.advance(51 * MINUTE)
  }
  expect(count()).toBe(7)
  expect((await ui.find({ type: 'Text', text: /^Keeping warm · always on$/ }))?.text).toBeTruthy()

  await ui.press({ key: 'keep-off' })
  await clock.settle()
  await reply($, on)
  await clock.advance(3 * HOUR)
  expect(count()).toBe(7)
  expect((await ui.find({ type: 'Text', text: /^Not keeping warm$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('/quota keep always turns it on from the prompt, and off again', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'quota', args: 'keep always' })).text).toBe('Keeping the cache warm until you turn it off.')
  expect((await $.command.run({ command: 'quota', args: 'show' })).text).toContain('Keep warm: always on')
  expect((await $.command.run({ command: 'quota', args: 'keep off' })).text).toBe('Not keeping the cache warm.')
})

// Model calls with the usage given, one after another.
function engineSteps(on: Parameters<Parameters<typeof test>[1]>[1], usages: { read: number; written: number; input: number }[]) {
  let i = 0
  on('turn.step', async function* (_, e) {
    const u = usages[Math.min(i++, usages.length - 1)]!
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: u.input, output_tokens: 100, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.written },
    } as never
  })
}

async function step($: Parameters<Parameters<typeof test>[1]>[0], turnId: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of stream) {
    // chunks are not needed here
  }
  return stream.result
}

test('cache usage: what is cached, hit and miss rates, rebuilds and ping tokens', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  // A cold first call writes 40k; the next reads it and writes 1k more; a ping reads 41k.
  engineSteps(on, [
    { read: 0, written: 40_000, input: 5 },
    { read: 40_000, written: 1_000, input: 5 },
    { read: 41_000, written: 0, input: 10 },
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No model calls in this chat yet/ }))?.text).toBeTruthy()
    await ui.unmount()
  }

  await step($, 't1')
  await step($, 't2')
  await $.turn.start({ text: 'ping', turnId: 'p1' })
  await step($, 'p1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Cache usage$/ }))?.text).toBeTruthy()
    // 41k read + 0 written by the last call: 41k in cache.
    expect((await ui.find({ type: 'Text', text: /^41k$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^in cache$/ }))?.text).toBeTruthy()
    // 81k read of 122,020 input tokens: 66.4% hit, 33.6% miss.
    expect((await ui.find({ type: 'Text', text: /^66\.4%$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^33\.6%$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^miss rate$/ }))?.text).toBeTruthy()
    // One rebuild (the cold first call), and the ping's 41k counted as ping tokens.
    expect((await ui.find({ type: 'Text', text: /^rebuild, last/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^ping tokens$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^3 calls$/ }))?.text).toBeTruthy()
    await ui.unmount()
  }
})

test('Settings: every chat can start with keep warm always on, saved for the next session', async ($, on) => {
  const saved: unknown[] = []
  on('store.get', () => ({ value: { thresholds: {}, defaultKeep: 'always' } }))
  on('store.set', (_, e) => {
    saved.push(e)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now, false)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A new chat with the saved default starts kept warm.
  expect((await ui.find({ type: 'Text', text: /^Keeping warm · always on$/ }))?.text).toBeTruthy()
  // Off in this chat holds: a reload (session.start again) does not turn it back on.
  await ui.press({ key: 'keep-off' })
  await clock.settle()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Not keeping warm$/ }))?.text).toBeTruthy()

  await ui.press({ key: 'tab-settings' })
  await clock.settle()
  await ui.press({ key: 'default-off' })
  await clock.settle()
  expect(JSON.stringify(saved.at(-1))).toContain('"defaultKeep":"off"')
  await ui.press({ key: 'default-always' })
  await clock.settle()
  expect(JSON.stringify(saved.at(-1))).toContain('"defaultKeep":"always"')
  await ui.press({ key: 'tab-overview' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Keeping warm · always on$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('the minimized desktop pane draws a glance with no controls', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  engineStep(on)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await reply($, on)
  await clock.advance(10 * MINUTE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect((await ui.find({ type: 'Text', text: /^50m left$/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Keep warm off · 100% hit · 5h 20%/ }))?.text).toBeTruthy()
  expect(await ui.find({ key: 'keep-always' })).toBeFalsy()
  await ui.unmount()
})
