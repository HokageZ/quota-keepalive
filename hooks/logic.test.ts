import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_THRESHOLDS, HOUR, MINUTE, PING_RETRY, alertsFor, cachePingDue, cacheWrittenAt, keepAliveWorth, quotaBack, familyOf, fmtDur, outlookOf, paceOf, pingDue, resetPassed, spendsWindow, nextClock } from './logic.ts'
import type { Limits } from './logic.ts'

const base = (over: Partial<Limits>): Limits => ({
  at: 0,
  fiveHour: { label: '5-hour limit', percent: 10, resetsAt: 10 * HOUR },
  weekAll: { label: 'Weekly · all models', percent: 52, resetsAt: 100 * HOUR },
  weekModel: null,
  contextPercent: 15,
  source: 'simulated',
  ...over,
})

test('heads-up at 90 on any window, said once', () => {
  const l = base({ weekAll: { label: 'Weekly · all models', percent: 91, resetsAt: 100 * HOUR } })
  const first = alertsFor(l, DEFAULT_THRESHOLDS, [])
  assert.equal(first.length, 1)
  assert.equal(first[0].level, 'heads-up')
  assert.equal(alertsFor(l, DEFAULT_THRESHOLDS, [first[0].id]).length, 0)
})

test('five-hour ladder: 90 heads-up, 96 subagents stop, 98 main stop', () => {
  const at = (p: number) => alertsFor(base({ fiveHour: { label: '5-hour limit', percent: p, resetsAt: 10 * HOUR } }), DEFAULT_THRESHOLDS, [])
  assert.equal(at(89).length, 0)
  assert.equal(at(90)[0].level, 'heads-up')
  assert.equal(at(96)[0].level, 'subagents-stop')
  assert.equal(at(98)[0].level, 'main-stop')
})

test('weekly window stops at 99, not at 98', () => {
  const at = (p: number) => alertsFor(base({ weekAll: { label: 'Weekly · all models', percent: p, resetsAt: 100 * HOUR } }), DEFAULT_THRESHOLDS, [])
  assert.equal(at(98)[0].level, 'heads-up')
  assert.equal(at(99)[0].level, 'week-stop')
})

test('a new reset gives a new id, so the same level is said again after the window resets', () => {
  const old = alertsFor(base({ fiveHour: { label: '5-hour limit', percent: 98, resetsAt: 10 * HOUR } }), DEFAULT_THRESHOLDS, [])
  const next = alertsFor(base({ fiveHour: { label: '5-hour limit', percent: 98, resetsAt: 15 * HOUR } }), DEFAULT_THRESHOLDS, [old[0].id])
  assert.equal(next.length, 1)
})

test('custom thresholds are honoured', () => {
  const t = { ...DEFAULT_THRESHOLDS, headsUp: 80 }
  assert.equal(alertsFor(base({}), t, []).length, 0)
  assert.equal(alertsFor(base({ fiveHour: { label: '5-hour limit', percent: 85, resetsAt: 10 * HOUR } }), t, [])[0].level, 'heads-up')
})

test('pace: percent per hour over the last 3 hours', () => {
  const now = 10 * HOUR
  const samples = [
    { at: now - 3 * HOUR, fiveHour: 20, weekAll: 50 },
    { at: now - 1 * HOUR, fiveHour: 40, weekAll: 51 },
    { at: now, fiveHour: 50, weekAll: 52 },
  ]
  assert.equal(paceOf(samples, 'fiveHour', now), 10)
  assert.equal(paceOf(samples.slice(0, 1), 'fiveHour', now), null)
  // a sample older than 3 hours is left out
  assert.equal(paceOf([{ at: now - 5 * HOUR, fiveHour: 0, weekAll: 0 }, { at: now, fiveHour: 5, weekAll: 0 }], 'fiveHour', now), null)
})

test('outlook: when the window runs out at this pace, and whether that is before the reset', () => {
  const now = 0
  const win = { label: 'x', percent: 50, resetsAt: 4 * HOUR }
  const soon = outlookOf(win, 25, now) // 2 h to full, reset at 4 h
  assert.equal(soon.hoursToFull, 2)
  assert.equal(soon.lastsToReset, false)
  const fine = outlookOf(win, 5, now) // 10 h to full
  assert.equal(fine.lastsToReset, true)
})

test('reset passed and ping timing', () => {
  assert.equal(resetPassed(5, 5), true)
  assert.equal(resetPassed(5, 4), false)
  assert.equal(resetPassed(null, 4), false)
  assert.equal(pingDue(0, 45 * MINUTE - 1, 45 * MINUTE), false)
  assert.equal(pingDue(0, 45 * MINUTE, 45 * MINUTE), true)
})

test('model windows: a subagent on the main model spends the model window; another model spends all-models only', () => {
  assert.equal(spendsWindow('claude-opus-5-5', 'claude-opus-5-5'), 'model')
  assert.equal(spendsWindow('claude-haiku-5-5', 'claude-opus-5-5'), 'all-only')
  assert.equal(familyOf('claude-fable-5-1'), 'fable')
})

test('clock parsing and durations', () => {
  const now = new Date(2026, 10, 10, 12, 0, 0).getTime()
  assert.equal(nextClock('15:45', now), new Date(2026, 10, 10, 15, 45, 0, 0).getTime())
  assert.equal(nextClock('09:05', now), new Date(2026, 10, 11, 9, 5, 0, 0).getTime())
  assert.equal(nextClock('25:00', now), null)
  assert.equal(fmtDur(4 * HOUR + 59 * MINUTE), '4h 59m')
})

test('keep-alive pings follow the cache age, not the pause start', () => {
  const every = 45 * MINUTE
  // The cache was written 40 minutes before the pause began: the ping is due 5 minutes in, not 45.
  const written = cacheWrittenAt(0 * MINUTE, 40 * MINUTE)
  assert.equal(written, 40 * MINUTE)
  const cachedAt = cacheWrittenAt(1, 40 * MINUTE)
  assert.equal(cachedAt, 1)
  assert.equal(cachePingDue(0, 0, 44 * MINUTE, every), false)
  assert.equal(cachePingDue(0, 0, 45 * MINUTE, every), true)
  // A ping went out 2 minutes ago and the cache has not moved yet: wait, then retry.
  assert.equal(cachePingDue(0, 50 * MINUTE, 52 * MINUTE, every), false)
  assert.equal(cachePingDue(0, 50 * MINUTE, 50 * MINUTE + PING_RETRY, every), true)
  // The ping landed: the cache is fresh again, so the next is a full interval out.
  assert.equal(cachePingDue(50 * MINUTE, 50 * MINUTE, 90 * MINUTE, every), false)
})

test('keep-alive is worth it only for pauses that end soon', () => {
  assert.equal(keepAliveWorth(3 * HOUR, 0), true)
  assert.equal(keepAliveWorth(5 * 24 * HOUR, 0), false)
  assert.equal(keepAliveWorth(null, 0), false)
})

test('a quota pause ends on the reset time or a reading back under the level', () => {
  assert.equal(quotaBack(10, 10, 99, 98), true)
  assert.equal(quotaBack(null, 10, 99, 98), false)
  assert.equal(quotaBack(null, 10, 3, 98), true)
  assert.equal(quotaBack(100, 10, null, 98), false)
})
