# @rsdp/tournament

The tournament director: pure TypeScript, no I/O, no timers, no dependency on the engine. State is plain JSON (`STATE_VERSION`) that the server snapshots.

## Integration (see docs/ARCHITECTURE.md)

- `createTournament({ id, hostId, settings, now, seed })` builds the state. `defaultSettings()` fills sensible defaults; `validateSettings()` lists problems. `createTournament` and `updateSettings` drop unknown keys and strip control characters and lone surrogates from names (jsonb refuses NUL and lone surrogates); chip amounts are capped at `MAX_CHIPS`, the engine's limit, and registrations, re-entries, rebuys and add-ons are refused once the field would hold more than `MAX_CHIPS_IN_PLAY` chips.
- `apply(state, command, now)` and `tick(state, now)` return `{ state, events }`. Invalid commands throw `DirectorError` and change nothing. The server checks that `by` may act as host.
- `nextWakeAt(state)` is the next time `tick` must run: seating 60 s before a scheduled start, the start itself, the end of the grace period, level and break ends, rebuy-offer expiries, the end of a lone survivor's wait for a re-entry, the Sit & Go delay. Re-read it after every apply or tick.
- Before each hand: `tableGate(state, tableId, now)` (`deal` or `hold`: not started, paused, break, rebuy offer open at that table, fewer than 2 players, hand-for-hand wait), then `levelFor(state, tableId)` for `gameId`, blinds, ante, `anteType`, bring-in and limit bets.
- Report `handStarted { tableId, handNumber }` when dealing and `handResult { tableId, handNumber, startStacks, endStacks, knockedOutBy?, button? }` when the hand ends. `button` lets balancing move the player due the big blind.
- Apply `tablesCreated`, `tableOpened`, `seatPlayer`, `moveSeat`, `tableBroken`, `stackAdded` and `eliminated` between hands. Players are only moved off tables that are between hands; the destination deals them in at its next hand, unless they land on the button, the small blind or between them (see "Joining mid-game").
- `scheduleNext { startAt }` (recurring series, sent when an occurrence starts) and `spawnNext` (Sit & Go auto-spawn) ask the server to create a copy with the same settings.

## Rules chosen

- **Joining mid-game.** A player seated at a table that has already dealt (late registration, re-entry, a table move) plays at once with no blind to post, except on the button, the small blind or a seat between them: there they sit out one hand until the button passes (#311). Not when that would leave only two players dealt in, and never heads up. The planner does this (`planForcedBets`, `mode: 'tournament'`), from `isNew` set by the runtime's `placePlayer`.
- **Auto-start.** A scheduled event seats everyone `seatLeadSeconds` (60) before `startAt` and deals at `startAt` with no host action. With fewer than 2 entrants it keeps registration open for `graceMinutes` (15) and starts the moment a second player registers; otherwise it cancels. Moving `startAt` ends the grace period; the new start time gets its own.
- **Finishing order.** Players busting in the same hand at the same table are ranked by their stack at the start of the hand; equal stacks tie and share the place. During hand-for-hand, busts in the same round at different tables tie (by rank at their own table). Tied places split the prizes of the places they cover. A busted player whose rebuy offer is declined or expires goes out with the hand that busted them: they join that hand's group (so starting stacks still order them), or are placed where that hand falls among the others.
- **Late registration, re-entry.** Close at the end of the chosen level (a break after that level counts as closed). A lone survivor is not declared the winner while either could still bring in an opponent; with re-entry open to the end (no closing level, or closing at the last level, which never ends) it waits 60 s after the last player went out, and for as long as a re-entry waits for the host. A re-entry replaces the busted entry, which then takes no place.
- **Rebuys and add-ons.** Rebuys on bust during levels marked `rebuy` (and the break right after one); only that table waits for the offer (default 15 s). Add-ons during breaks marked `addOn`. Host approval for each is a toggle, off by default.
- **Balancing.** Break the shortest table once everyone fits in one fewer table; otherwise move one player from the fullest to the shortest table when they differ by 2 or more. Hand-for-hand on the bubble when payouts are set.
- **Quit / remove.** Takes effect when the current hand ends; the player takes the lowest remaining place and their chips leave play.
- **End early.** While paused with no hand running, `end` ranks the remaining players by chips (equal stacks share the place).

## Modules

`structure.ts` (levels, breaks, presets, generator, clock), `payouts.ts` (pool, structures, presets, ICM, chip chop), `recurrence.ts` + `tz.ts` (time-zone-aware schedules, RRULE export), `seating.ts` (draws and balancing), `director.ts`.
