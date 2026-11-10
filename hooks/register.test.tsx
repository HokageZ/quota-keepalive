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

test('the pane draws its controls on every surface, and a pause starts from the pane', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^5-hour limit$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^20%$/ }))?.text).toBeTruthy()
    expect(await ui.find({ key: 'refresh' })).toBeTruthy()
    expect(await ui.find({ key: 'pause-60' })).toBeTruthy()
    expect(await ui.find({ key: 'pause-reset' })).toBeTruthy()
    expect(await ui.find({ key: 'model-week' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause-120' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Paused until/ }))?.text).toBeTruthy()
  expect(await ui.find({ key: 'continue' })).toBeTruthy()

  await ui.press({ key: 'continue' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Not paused$/ }))?.text).toBeTruthy()
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
  expect((await ui.find({ type: 'Text', text: /^Paused for Weekly/ }))?.text).toBeTruthy()
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
    expect((await ui.find({ type: 'Text', text: /^automatic$/ }))?.text).toBeTruthy()
    expect(await ui.find({ key: 'sim-main' })).toBeTruthy()
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
  expect((await ui.find({ type: 'Text', text: /^Paused for 5-hour limit/ }))?.text).toBeTruthy()
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

test('a 3-hour pause plans 3 pings, 45 minutes apart', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 10, 8, 0) })
  engine(on, { five: 20, week: 30, weekResetsIn: 4 * 24 * HOUR }, clock.now)
  mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause-180' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^45m$/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^pings before reset$/ }))?.text).toBeTruthy()
  await ui.unmount()
})
