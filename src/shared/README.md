# Shared companion contracts

These modules use plain JavaScript only. They do not create timers, open windows, access storage, perform network requests, or execute character-package code. Hosts own persistence, ticking, permissions and rendering.

## Companion engine

```js
const engine = createCompanionEngine(saved, {
  now: Date.now,
  role: 'owner', // owner | visitor | admin; default owner
  timezoneOffsetMinutes: 540, // optional; default UTC. Host can provide current local offset.
});
const { state, events } = engine.dispatch({ type: 'todo.add', text: '写文章', dueAt: Date.now() + 60000 });
const update = engine.tick();
const savedAgain = engine.serialize();
```

`snapshot()` returns a detached JSON-safe state. `serialize()` also captures in-flight focus time without emitting or discarding events. Only version 1 archives with a matching `scope` restore. Invalid records are discarded or reset. A running focus/break session restores **paused**, so closed-app time gives neither rewards nor penalties. The host should also pause focus when appropriate on system suspend and persist when state changes.

All commands are synchronous and reject unknown fields/types. Rejected commands leave domain state unchanged. Results have `{state, events}` and export commands additionally provide `data`.

| Command | Fields |
|---|---|
| `profile.update` | `patch: {name?, ownerName?, persona?}` |
| `preferences.update` | `patch` from the preference whitelist |
| `preferences.import` | `data: {schema:'andromeda.preferences/v1', preferences}` |
| `preferences.export` | none; result `data` contains preferences only |
| `focus.start` | optional `taskId` of an open todo, `durationMinutes` 1–240, `breakMinutes` 1–60 |
| `focus.pause`, `focus.resume`, `focus.cancel`, `focus.finish` | none |
| `focus.break` | optional `minutes` 1–60; requires completed focus |
| `todo.add` | `text`, optional `dueAt` as UTC epoch milliseconds or null |
| `todo.update` | `id`, `patch: {text?, dueAt?}` |
| `todo.complete`, `todo.delete` | `id` |
| `todo.snooze` | `id`, `minutes` 1–10080 |
| `memory.add` | `text`, optional `source` (defaults to user) |
| `memory.update` | `id`, `text`; preserves source and creation time |
| `memory.forget` | `id` |
| `memory.clear`, `memory.export` | none; export returns scope and sourced/timestamped memories |
| `notification.ack` | merged card `id` |
| `notification.clear` | none |
| `reminders.mute` | `muted` boolean |
| `interaction` | `kind: 'greet' | 'pet' | 'play' | 'thanks'` |
| `task.event` | `eventId`, `taskId`, `status`, optional `title`, `text`; prohibited in visitor scope |

Task statuses: `working`, `waiting`, `completed`, `failed`, `cancelled`. Producers must use unique event IDs and a new task ID for independent runs. The most recent 500 external event IDs are deduplicated; unchanged task status/content also suppresses repeated feedback. This is a bounded local deduplication window, not a distributed exactly-once delivery protocol. No arbitrary URL, shell command, file or credentials are accepted.

Preferences: `motion: 'quiet'|'still'|'lively'`, `sound`, `reducedMotion`, `remindersMuted`, `routine`, `focusMinutes`, `breakMinutes`, `visualStyle: 'classic'|'studio'`, `theme: 'night'|'dawn'|'festive'`, `movement: 'off'|'roam'|'follow'|'toss'`. Defaults are classic artwork, night theme and movement off. Studio is an optional static-pose collection, not an animated replacement. Export/import excludes identity, task data and memories. Hosts should use separate storage keys per scope. Preferences are capability-neutral intent; hosts implement supported effects and report unavailable ones.

State fields: `version`, `scope`, `profile`, `preferences`, `focus`, `todos`, `mood`, `progression`, `memories`, `notifications`, `tasks`, `seenEventIds`, `routine`, `lastInteractionAt`, `lastTickAt`.

Events: `{id, kind, action, text, priority, taskId?}`. Larger priority wins. Typical semantic actions are `greet`, `happy`, `think`, `read`, `question`, `pet`, `sleep`, `notify`, `idle`. A domain event never means “show the hidden pet.” Notifications merge by kind/action; the card stores its total count and the last 20 details. A card with multiple task targets uses `items[].taskId`, not a shared card target. Muting preserves cards and suppresses reminder actions; unmuting does not replay old reminders.

Focus rewards completed whole minutes (2 XP per minute, capped at 120 per session). Completing a todo gives 10 XP once. Interactions give at most 1 XP per minute. Cancelling, closing or missing days never removes XP. Mood approaches neutral over time. External task events do not award XP. These rules are intentional light progression, not tamper-proof achievements.

## Behavior scheduler

`createBehaviorScheduler({now, maxQueue=32, cooldowns={}})` returns `enqueue(event)`, `tick()`, `setContext(patch)`, `complete(id)`, `clear({kind}?)`, and `snapshot()`.

Context accepts only `hidden`, `paused`, `dragging`, `reducedMotion` booleans. Hidden/paused/dragging suspends the active action and keeps queued actions without waking the host. Higher priority events preempt a resumable action; after the interrupt it continues with remaining time. A newer event for the same task and event-family replaces obsolete feedback. Per-action cooldowns prevent repeated gestures; reduced motion returns a static pose for at most 900 ms.

Snapshot: `{active, queue, paused, context}`. Active includes the event plus `remainingMs`, `static`, `suspended`. Incoming scheduler events may additionally specify `durationMs` (1–60000) and `resumable` (default true). The host observes changes to active ID and plays the matching pose; `complete(id)` allows real animation completion to advance the queue.

## Character packages

`characterPackFromAtlas(manifest, metadata?)` wraps the current `andromeda.sprite-atlas/v1` data as a validated `andromeda.character/v1` package. It does not edit or enlarge the existing images. `validateCharacterPack(pack)` validates bounded geometry, frame durations, source/rights metadata, semantic action mappings, normalized ground/body/face/dialogue anchors, quality tiers and local PNG/WebP paths. Unknown fields, traversal/external URLs and script fields are rejected. Actual file hashes and decoded dimensions still need host-side checks.

`resolveAction(pack, semantic, {reducedMotion})` returns `{semantic, animation, fallback, static, row, column, frameCount, durationsMs, anchor}`. `fallback:true` explicitly identifies a substitute: the existing atlas does not suddenly acquire sleep, petting or pointing animations. If no suitable animation exists, resolution returns the neutral pose. `resolveSemanticAction(pack, semantic)` returns only the animation name or null.

Default anchors are documented approximations for the existing artwork, not an art-production verification. New high-resolution views, mouth shapes, rigging, audio and animation assets are separate deliverables.

## Verification

The desktop-only pure geometry module `../motion.cjs` exports `createMotionState(bounds, {mode='off', velocityX=0, velocityY=0, direction=1})`, `setMotionMode(state, mode)`, `syncMotionBounds(state, bounds)`, `throwMotion(state, {velocityX, velocityY})`, and `stepMotion(state, options)`. Options include `deltaMs`, `workArea`, optional `pointer`, and `hidden/paused/dragging/fullscreen/reducedMotion` booleans. Results are `{state, bounds, moved, action, supported, reason}`; the host applies positions only when appropriate and retains the returned fractional state between ticks. Modes are off, roam, follow, toss. Velocity is DIP/second. Toss activates only on an explicit throw; pointer tracking is limited to the supplied work area. Long clock gaps stop movement; hidden or dragged hosts are never moved. Monitor changes and OS minimum sizes remain host responsibilities. This does not implement window-surface sitting, global keyboard hooks or cross-screen roaming.

Run `node --test tests/companion*.test.mjs`. Tests cover identity separation, strict transactional validation, persistence corruption, focus timing and closed-app recovery, reward deduplication, due/snooze/mute, notification merging, external event deduplication, sourced memory CRUD, mood/routine, preemption/resumption, cooldowns, hidden-host behavior and character-package fallback/safety. These are domain tests, not native Windows or browser interaction acceptance.

Run `node --test tests/motion.test.cjs` for the bounded motion strategy, including negative/fractional coordinates, elapsed-time behavior, throw settling and suppression.
