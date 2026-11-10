# quota-keepalive

A Claude Code mod that does by itself what was done by hand in long unattended sessions: it watches the plan's usage limits, warns at thresholds, and keeps prompt caches warm while work is paused for quota.

## What it shows

A pane named **Quota** beside the chat. It reads the plan limits every 15 seconds and right after each turn (the read is local and costs nothing), so the countdowns and percents stay live without pressing Refresh:

- the 5-hour limit: percent used, time to reset, pace per hour over the last 3 hours, and when it would run out at that pace;
- the weekly limit for all models, with the same pace figures;
- the weekly limit of the main model: **not readable by a mod** (the usage card reports it, but the mod API does not expose it). Set it by hand with `/quota model <percent>`;
- the session's context use;
- the main session's cache age and its next ping, when a pause runs;
- each subagent: model, status, tokens so far, cache age, and which weekly window it spends (a subagent on the main model spends the model window; any other model spends the all-models window only).

## Look

The pane follows the cache-countdown mod: rounded cards, a ring and a bar in green, amber and red (amber from the heads-up level, red from the stop level), bold values with dim labels. Each limit's bar marks its thresholds. The terminal draws the same cards with block characters.

## Controls in the pane

The panel is the main view: every setting is a click, and nothing needs typing. `/quota` opens it.

- **Pause for** 30m, 1h, 2h, 3h, or **Until 5-hour reset**; **Continue now** while paused.
- The main model's weekly percent is picked from a list (the number on the usage card).
- **Settings** in the footer: a scale with the 5-hour and weekly levels, then chips for the heads-up, subagents stop, main stop and weekly stop percents, test-mode scenarios (Heads-up, Subagents stop, Main stop, Weekly stop, End test), and **Reset to defaults**. Saved for every session.

The typed forms still work where slash commands run, for values the chips do not offer: `/quota show`, `/quota pause until 15:45`, `/quota continue`, `/quota threshold main 95`, `/quota simulate 97 40` or `off`, `/quota model 43` or `off`.

## Thresholds

- any window at 90%: heads-up toast;
- 5-hour limit at 96%: running subagents are told to stop at a clean point and reply "paused for quota";
- 5-hour limit at 98%: the main session is told to stop starting work;
- a weekly window at 99%: the main session is told to stop and tell the person, who can enable a quota reset.

Each threshold is said once per window reset.

## Keep-alive

Automatic; there is nothing to set. When a pause starts (a stop level, or **Pause for** in the panel), the mod plans the pings from the time to the reset: the span from each cache's last write to the reset is split into the fewest equal gaps of at most 50 minutes (the 60-minute cache less a 10-minute margin). Three hours to the reset gives 3 pings, 45 minutes apart, and the cache is 45 minutes old when work resumes. A wait shorter than 50 minutes needs no ping. With no reset time known, it pings every 50 minutes.

The main session gets a short prompt and each paused subagent a message; each cache keeps its own plan. A ping that does not refresh the cache is tried again 5 minutes later. A ping does nothing but keep the cache warm.

The keep-alive stands down, and the panel says why:
- at 100% of a limit, where every request, a ping included, is refused;
- for a quota pause more than 12 hours from its reset (a weekly window): the pings would spend the quota that ran out and cost more than rebuilding the cache once.

When the window resets, or the time arrives, the main session is told to continue and paused subagents are told to resume. A quota pause also ends when a fresh reading shows the window back under the level that paused it.

## Commands (optional)

- `/quota` or `/quota show`: the readings and pause state
- `/quota pause until 15:45`: pause until that time, keep alive
- `/quota continue`: end the pause now
- `/quota threshold <heads-up|subagents|main|week> <percent>`: change a threshold for this session
- `/quota simulate <5-hour %> <week %>` or `/quota simulate off`: **test mode** with made-up numbers, marked SIMULATED in the pane
- `/quota model <percent>` or `/quota model off`: set the main model's weekly percent by hand

## Settings

Set in `pluginConfigs` under `quota-keepalive` (or in the mod's options): `headsUpPercent` (90), `subagentsStopPercent` (96), `mainStopPercent` (98), `weekStopPercent` (99).

## Limits of what a mod can do

- It cannot see whether the session has entered extra usage. Then the cache drops to five minutes; the pane says so as a reminder, and the mod cannot detect it.
- It cannot read the per-model weekly window (see above).
- It cannot schedule a wake-up on its own: a ping is a prompt sent through the engine, so the keep-alive runs only while the session process is alive.
- Thresholds and keep-alive act on the readings the session reports; they are as current as the last refresh.

## Files

- `hooks/logic.ts`: pure rules (thresholds, pace, pause timing); `hooks/logic.nodetest.ts` runs with `node --test hooks/logic.nodetest.ts`
- `hooks/register.test.tsx`: the pane on terminal and desktop, and the keep-alive timing; runs with `claude plugin test .`
- `hooks/register.tsx`: the engine hooks, pane and commands
- `hooks/view.ts`: the pane's tones, ring, bar and block helpers
- `types/index.d.ts`: the state contract

## Install

At the prompt of a terminal session:

```
/plugin install quota-keepalive --marketplace HokageZ/quota-keepalive
```

From a shell:

```
claude plugin install quota-keepalive --marketplace HokageZ/quota-keepalive
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `HokageZ/quota-keepalive`, then Add plugin.
