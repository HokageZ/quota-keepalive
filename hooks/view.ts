// Pure drawing helpers for the Quota pane, in the cache-countdown mod's style:
// a ring and a bar in fixed hues on desktop, block characters in the terminal.

export type Tone = 'success' | 'warning' | 'error'

// Fixed hues for the SVG, which draws as an image and cannot read the theme;
// each reads on a light and a dark background (the same as cache-countdown).
export const HUE: Record<Tone, string> = { success: '#3fb950', warning: '#d29922', error: '#f85149' }

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

// Green under the heads-up level, amber up to the stop level, red from it.
export function toneOf(percent: number, warnAt: number, stopAt: number): Tone {
  if (percent >= stopAt) return 'error'
  if (percent >= warnAt) return 'warning'
  return 'success'
}

// A cache's tone by the share of its lifetime left: amber under a fifth, red when gone.
export function cacheTone(share: number): Tone {
  if (share <= 0) return 'error'
  return share < 0.2 ? 'warning' : 'success'
}

// An 18 px ring filled to `share`; empty, a dot in the middle.
export function ringSvg(share: number, tone: Tone): string {
  const s = clamp01(share)
  const r = 7
  const c = 2 * Math.PI * r
  const arc = (c * s).toFixed(2)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">' +
    `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${s > 0 ? 'rgba(128,128,128,0.28)' : HUE[tone]}" stroke-opacity="${s > 0 ? 1 : 0.45}" stroke-width="2.5"/>` +
    (s > 0
      ? `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${HUE[tone]}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${arc} ${c.toFixed(2)}" transform="rotate(-90 9 9)"/>`
      : `<circle cx="9" cy="9" r="2.5" fill="${HUE[tone]}"/>`) +
    '</svg>'
  )
}

export const BAR_WIDTH = 320
export const BAR_HEIGHT = 10

// A rounded usage bar filled to `percent`, with a thin mark at each threshold.
export function barSvg(percent: number, tone: Tone, marks: readonly number[]): string {
  const w = BAR_WIDTH
  const h = BAR_HEIGHT
  const y = 2
  const bh = 6
  const fill = Math.round(w * clamp01(percent / 100))
  const ticks = marks
    .filter(m => m > 0 && m < 100)
    .map(m => {
      const x = Math.round((w * m) / 100)
      return `<rect x="${x - 1}" y="0" width="2" height="${h}" rx="1" fill="rgba(128,128,128,0.55)"/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<rect x="0" y="${y}" width="${w}" height="${bh}" rx="3" fill="rgba(128,128,128,0.22)"/>` +
    (fill > 0 ? `<rect x="0" y="${y}" width="${Math.max(fill, 6)}" height="${bh}" rx="3" fill="${HUE[tone]}"/>` : '') +
    ticks +
    '</svg>'
  )
}

// The terminal's bar: filled and empty cells, at least one filled once anything is used.
export function blocks(share: number, cells: number): { filled: string; empty: string } {
  const s = clamp01(share)
  const n = s > 0 ? Math.max(1, Math.round(s * cells)) : 0
  return { filled: '█'.repeat(n), empty: '░'.repeat(Math.max(0, cells - n)) }
}

// Percent with no needless decimals: 13, 99.5.
export function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

// The settings scale: two lanes, as the levels work. The 5-hour lane holds the alert,
// subagents and main stops; the weekly lane the alert and weekly stop. A lane starts a little
// below the lowest level so close levels (96, 98) still sit apart; each dot carries its number.
export function scaleSvg(t: { headsUp: number; subagentsStop: number; mainStop: number; weekStop: number }): string {
  const w = BAR_WIDTH
  const left = 54
  const right = w - 12
  const lo = Math.max(0, Math.min(80, Math.floor((t.headsUp - 5) / 5) * 5))
  const x = (v: number) => Math.round(left + ((Math.max(lo, Math.min(100, v)) - lo) / (100 - lo)) * (right - left))
  const lane = (y: number, name: string, pins: { v: number; hue: string }[]) => {
    const dots = pins
      .map(
        pin =>
          `<circle cx="${x(pin.v)}" cy="${y}" r="5" fill="${pin.hue}" stroke="#1e1e1e" stroke-width="2"/>` +
          `<text x="${x(pin.v)}" y="${y - 9}" font-size="10" fill="${pin.hue}" text-anchor="middle" font-family="sans-serif" font-weight="600">${pin.v}</text>`,
      )
      .join('')
    return (
      `<text x="0" y="${y + 3.5}" font-size="10" fill="rgba(128,128,128,0.95)" font-family="sans-serif">${name}</text>` +
      `<rect x="${left}" y="${y - 2}" width="${right - left}" height="4" rx="2" fill="url(#g)" opacity="0.8"/>` +
      dots
    )
  }
  const ends =
    `<text x="${left}" y="74" font-size="9" fill="rgba(128,128,128,0.8)" text-anchor="start" font-family="sans-serif">${lo}%</text>` +
    `<text x="${right}" y="74" font-size="9" fill="rgba(128,128,128,0.8)" text-anchor="end" font-family="sans-serif">100%</text>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="78" viewBox="0 0 ${w} 78">` +
    '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0">' +
    `<stop offset="0" stop-color="${HUE.success}"/><stop offset="0.55" stop-color="${HUE.warning}"/><stop offset="1" stop-color="${HUE.error}"/>` +
    '</linearGradient></defs>' +
    lane(24, '5-hour', [
      { v: t.headsUp, hue: HUE.warning },
      { v: t.subagentsStop, hue: HUE.error },
      { v: t.mainStop, hue: HUE.error },
    ]) +
    lane(56, 'Weekly', [
      { v: t.headsUp, hue: HUE.warning },
      { v: t.weekStop, hue: HUE.error },
    ]) +
    ends +
    '</svg>'
  )
}
