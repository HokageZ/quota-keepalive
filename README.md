# quota-keepalive

A Claude Code mod that does by itself what was done by hand in long unattended sessions: it watches the plan's usage limits, warns at thresholds, and keeps prompt caches warm while work is paused for quota.

## What it shows

A pane named **Quota** beside the chat, opened in every chat by itself, with two tabs: **Overview** and **Settings**. It reads the plan limits every 15 seconds and right after each turn (the read is local and costs nothing), so the countdowns and percents stay live without pressing Refresh.

Overview, top to bottom:

- **Prompt cache**: a ring with the time left of its 60 minutes, what keep warm is doing, the ping plan (next ping, pings left, the gap), and the keep warm chips: Off, 1h, 2h, 4h, Until reset, **Always**;
- **Cache usage**: tokens in the cache now, the session's **hit rate** and **miss rate**, tokens read from the cache, written to it and sent uncached, output, cache rebuilds (a call that wrote more than it read: the cache had lapsed), pings sent and what they cost, and the subagents' own hit rate;
- **Plan limits**, in one card: the 5-hour limit and the weekly limit for all models (percent used, time to reset, pace per hour over the last 3 hours, and whether it lasts to the reset), the main model's weekly limit (**not readable by a mod**: pick the number the usage card shows), and the context use;
- **Subagents**, when there are any: model, status, tokens so far, cache age, and which weekly window it spends (a subagent on the main model spends the model window; any other model spends the all-models window only).

What a press did shows at the top of the pane. Minimized on the desktop, the pane draws a one-glance summary: time left, keep warm, hit rate and the 5-hour percent.

## Look

The pane follows the cache-countdown mod: rounded cards, a ring and a bar in green, amber and red (amber from the heads-up level, red from the stop level), bold values with dim labels. Each limit's bar marks its thresholds. The terminal draws the same cards with block characters.

## Band above the prompt

A one-line band above the prompt box, in the cache-countdown style:
- the prompt cache: a ring, time left of its 60 minutes (or Expired, with how many tokens the next message would re-cache);
- the tokens cached now, how many tokens a **re-cache** would write if the cache lapsed (the whole context, shown in every state), and the session's cache **miss rate** (amber under 80% hits, red under 50%);
- the live warning from your thresholds (heads-up, subagents stop, stop), in amber or red;
- while work is paused or kept warm: until when and the ping plan (`Warm ∞ · ping · next 12m`, `Paused until 23:53 · 3 pings · next 12m`);
- **Quota**, which opens the panel.

It stacks with any other band; this one replaces the cache-countdown mod's, so turn that mod off.

## Controls in the pane

The panel is the main view: every control is a click, and nothing needs typing. `/quota` opens it.

- The prompt cache card: **Keep warm** Off, 1h, 2h, 4h, **Until reset** or **Always**, then **Pause work until …** for a timed choice (or **Continue now** while paused).
- The main model's weekly percent is picked from a list (the number on the usage card).
- The **Settings** tab: **Every chat** (whether a new chat starts with keep warm Off or Always), a scale with the 5-hour and weekly levels, chips for the heads-up, subagents stop, main stop and weekly stop percents, test-mode scenarios, and **Reset to defaults**. Saved for every session.

The typed forms still work where slash commands run: `/quota show`, `/quota keep always` (or `off`, `1h`, `2h`, `4h`, `reset`), `/quota pause until 15:45`, `/quota continue`, `/quota threshold main 95`, `/quota simulate 97 40` or `off`, `/quota model 43` or `off`.

## Thresholds

- any window at 90%: heads-up toast;
- 5-hour limit at 96%: running subagents are told to stop at a clean point and reply "paused for quota";
- 5-hour limit at 98%: the main session is told to stop starting work;
- a weekly window at 99%: the main session is told to stop and tell the person, who can enable a quota reset.

Each threshold is said once per window reset.

## Keep warm

One system, one rule. Pick how long to keep the prompt cache warm (1h, 2h, 4h, until the 5-hour reset, or **Always**). From the cache's last write to that end, the mod pings at the fewest equal gaps of at most 50 minutes (the 60-minute cache less a 10-minute margin), so the cache is still warm at the end. Two hours gives 2 pings, 40 minutes apart; three hours to the reset gives 3, 45 minutes apart. Your own replies write the cache too, so it only pings while you're away. A timed choice ends by itself at its end time.

**Always** has no end: a ping after every 50 minutes of idle, until you press **Off**. It stays on through a quota pause and its end. To have every new chat start this way, set **Every chat** to Always in Settings; a chat where you pressed Off stays off.

A ping is the one word `ping`; the model answers in a word, so a ping costs a cache read of the conversation and a few output tokens.

**A cold cache is never rewarmed.** Keep warm only keeps a warm cache warm. Once the cache has lapsed (a ping that did not land, a machine asleep) or before any reply has written it, no ping goes out: rewarming would pay for the whole context again for a chat you may not come back to. Your own next message warms it, and keep warm carries on from there. The panel and the band say when it is waiting on you (`cold: not rewarmed until you send`).

**Pause work until then** also stops Claude and its subagents, and tells them to continue at the end; **Continue now** ends it early. When a limit reaches its stop level, the mod does both by itself: work paused, kept warm until the reset. Paused subagents are kept warm on the same rule.

It does not ping while a turn runs (the turn keeps the cache warm), at 100% of a limit (every request is refused), or for a limit's pause more than 12 hours from its reset (a weekly window): there the pings would cost more than rebuilding the cache once. The panel says which. A ping that does not refresh the cache is tried again 5 minutes later while the cache is still warm; past its hour it is cold, and the rule above applies. Each ping spends a little quota and shows as a row in the transcript.

A quota pause also ends when a fresh reading shows the window back under the level that paused it.

## Commands (optional)

- `/quota` opens the panel; `/quota show` prints the readings, cache usage and keep warm state
- `/quota keep <off|1h|2h|4h|reset|always>`: keep the cache warm (always: until you turn it off)
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
- Cache usage counts the calls this session made since the mod loaded; a hot reload keeps them, a new session starts at zero.
- It cannot schedule a wake-up on its own: a ping is a prompt sent through the engine, so the keep-alive runs only while the session process is alive.
- Thresholds and keep-alive act on the readings the session reports; they are as current as the last refresh.

## Files

- `hooks/logic.ts`: pure rules (thresholds, pace, pause timing); `hooks/logic.nodetest.ts` runs with `node --test hooks/logic.nodetest.ts`
- `hooks/register.test.tsx`: the pane on terminal and desktop, and the keep-alive timing; runs with `claude plugin test .`
- `hooks/register.tsx`: the engine hooks, pane and commands
- `hooks/view.ts`: the pane's tones, ring, bar and block helpers
- `types/index.d.ts`: the state contract

## Install

Installed at the user scope (the default the installer offers first), the mod loads in every chat: each new session gets the pane, the band and keep warm.

At the prompt of a terminal session:

```
/plugin install quota-keepalive --marketplace HokageZ/quota-keepalive
```

From a shell:

```
claude plugin install quota-keepalive --marketplace HokageZ/quota-keepalive
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `HokageZ/quota-keepalive`, then Add plugin.
