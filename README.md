# quota-keepalive

A Claude Code mod that does by itself what was done by hand in long unattended sessions: it watches the plan's usage limits, warns at thresholds, and keeps prompt caches warm while work is paused for quota.

## What it shows

A pane named **Quota** beside the chat, refreshed once a minute, with the readings refreshed every 10 minutes and after each subagent ends:

- the 5-hour limit: percent used, time to reset, pace per hour over the last 3 hours, and when it would run out at that pace;
- the weekly limit for all models, with the same pace figures;
- the weekly limit of the main model: **not readable by a mod** (the usage card reports it, but the mod API does not expose it). Set it by hand with `/quota model <percent>`;
- the session's context use;
- the main session's cache age and its next ping, when a pause runs;
- each subagent: model, status, tokens so far, cache age, and which weekly window it spends (a subagent on the main model spends the model window; any other model spends the all-models window only).

## Thresholds

- any window at 90%: heads-up toast;
- 5-hour limit at 96%: running subagents are told to stop at a clean point and reply "paused for quota";
- 5-hour limit at 98%: the main session is told to stop starting work;
- a weekly window at 99%: the main session is told to stop and tell the person, who can enable a quota reset.

Each threshold is said once per window reset.

## Keep-alive

While paused (for quota, or until a clock time), the mod pings the main session with a short prompt every 45 minutes (configurable, kept under 55) and each paused subagent with a message. A ping does nothing but keep the cache warm. When the window resets, or the time arrives, the main session is told to continue and paused subagents are told to resume.

A ping is a real request, so it spends a little quota, and a ping to the main session appears as a visible row in the transcript.

## Commands

- `/quota` or `/quota show`: the readings and pause state
- `/quota pause until 15:45`: pause until that time, keep alive
- `/quota continue`: end the pause now
- `/quota threshold <heads-up|subagents|main|week> <percent>`: change a threshold for this session
- `/quota simulate <5-hour %> <week %>` or `/quota simulate off`: **test mode** with made-up numbers, marked SIMULATED in the pane
- `/quota model <percent>` or `/quota model off`: set the main model's weekly percent by hand

## Settings

Set in `pluginConfigs` under `quota-keepalive` (or in the mod's options): `headsUpPercent` (90), `subagentsStopPercent` (96), `mainStopPercent` (98), `weekStopPercent` (99), `pingMinutes` (45), `refreshMinutes` (10).

## Limits of what a mod can do

- It cannot see whether the session has entered extra usage. Then the cache drops to five minutes; the pane says so as a reminder, and the mod cannot detect it.
- It cannot read the per-model weekly window (see above).
- It cannot schedule a wake-up on its own: a ping is a prompt sent through the engine, so the keep-alive runs only while the session process is alive.
- Thresholds and keep-alive act on the readings the session reports; they are as current as the last refresh.

## Files

- `hooks/logic.ts`: pure rules (thresholds, pace, pause timing); `hooks/logic.test.ts` runs with `node --test hooks/logic.test.ts`
- `hooks/register.tsx`: the engine hooks, pane and commands
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
