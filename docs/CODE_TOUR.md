# A guided tour of the code

This page is for someone opening the repository for the first time and
wanting to understand how RSDP Poker Live! works: what each folder does, how
the pieces talk to each other, which files to read first, and how to run it
on your own computer.

It is a map, not the rulebook. The detailed rules each part follows live in
[ARCHITECTURE.md](ARCHITECTURE.md), how the cards are shuffled and how you
can check them lives in [FAIRNESS.md](FAIRNESS.md), and hosting, backups and
restores live in [DEPLOY.md](DEPLOY.md). This page links to those instead of
repeating them.

## The big picture

Everything runs in **one server process**. Browsers connect to it over a
WebSocket (a connection that stays open, so the server can push updates the
moment something happens). The server holds every live table and tournament
in memory, decides everything, and saves to a database so a restart picks up
where it left off.

```
  Browser (React app, apps/web)
     │   sends intents: "I bet 40", "seat me in seat 3", "here is my seed"
     │   receives: its own filtered view of the table after every change
     ▼
  Server (Node + Express + Socket.IO, apps/server)
     ├─ TableRuntime, one per table: seats, timers, between-hand steps
     │     └─ calls the poker engine (packages/engine) to play each hand
     ├─ TournamentManager: runs the tournament director (packages/tournament)
     │     and opens tables for it
     ├─ Public record (audit log): a hash chain of hands, chips and admin actions
     └─ Database (Postgres, or PGlite on a disk), through Drizzle
```

Three ideas explain most of the design:

1. **The server is in charge.** A browser never decides anything. It asks
   ("I raise to 120"), the server checks the request against the rules, and
   then sends each person a fresh picture of the table.
2. **Each person only receives what they may see.** Other players' hole
   cards, the undealt deck and the shuffle secrets stay on the server until
   the rules say they can be shown.
3. **The poker rules are pure code.** The engine and the tournament director
   take a state and an action and return a new state. They don't read the
   clock, touch the network or the database, or pick random numbers by
   themselves. That makes them easy to test exhaustively, and it means the
   same code can replay and check a hand in your browser.

## The folders

```
packages/engine      The poker rules. No I/O. Used by the server AND the browser.
packages/tournament  The tournament director: levels, seating, payouts. No I/O.
apps/server          The game server: tables, tournaments, accounts, database.
apps/web             The website: lobby, table, tournament pages, replayer.
e2e/                 A browser "smoke test" that plays real hands through the UI, and
                     e2e/playtest/, scripts that play a release through for screenshots.
scripts/             Stand-alone checkers (hands, the public record), backups, deploy helpers,
                     and scripts/release/ (issue links, versions, release notes).
.github/workflows/   Automated jobs on GitHub: tests, deploys, releases, backups, watchers.
.github/             Also the issue forms, the pull request template and labels.json.
docs/                This page, ARCHITECTURE.md, FAIRNESS.md, PRIVACY.md, TERMS.md, CREDITS.md, DEPLOY.md,
                     RUNBOOK.md (when something goes wrong), DECISIONS.md (what was decided, and why).
```

At the top level, [CONTRIBUTING.md](../CONTRIBUTING.md) says how work is
tracked in GitHub issues and released, and [CHANGELOG.md](../CHANGELOG.md)
lists every release (made from the site's own release notes).

It is one npm "workspace": a single `npm install` at the top sets up all four
parts, and they import each other by name (`@rsdp/engine`,
`@rsdp/tournament`). Everything is TypeScript.

### packages/engine: the poker rules

This is the heart of the game, and the part worth reading most carefully.

| Where | What it does |
| --- | --- |
| [`src/cards.ts`](../packages/engine/src/cards.ts) | Cards are two-letter strings (`As` = ace of spades, `Td` = ten of diamonds). |
| [`src/fairness.ts`](../packages/engine/src/fairness.ts) | The shuffle. Combines the server's secret with the players' seeds (`handSeedOf`), turns that into a deck (`deckFromSeed`), and has `verifyHand`, which re-deals a finished hand to check it. Explained in [FAIRNESS.md](FAIRNESS.md). |
| [`src/core/types.ts`](../packages/engine/src/core/types.ts), [`api.ts`](../packages/engine/src/core/api.ts) | The shapes everything else agrees on: a hand's input, its state, its events, the legal actions. Start here. |
| [`src/core/hand.ts`](../packages/engine/src/core/hand.ts) | The hand itself: `startHand`, `act`, `draw`, `voteRunItTwice`, `show`, `timeout`. Every step adds events (`state.events`) that describe what happened. |
| [`src/core/betting.ts`](../packages/engine/src/core/betting.ts), [`pots.ts`](../packages/engine/src/core/pots.ts), [`settle.ts`](../packages/engine/src/core/settle.ts), [`forced.ts`](../packages/engine/src/core/forced.ts) | Legal bets and raises for no limit, pot limit and fixed limit; side pots; who wins what; blinds, antes, straddles. |
| [`src/core/visibility.ts`](../packages/engine/src/core/visibility.ts) | `visibleEvents`: the filter that removes anything a given viewer may not see. Every hand event sent to a browser during play goes through it. Only once a hand is revealed (see FAIRNESS.md) is its full record sent unfiltered, so it can be checked. |
| [`src/variants/`](../packages/engine/src/variants) | Each game (Hold'em, Omaha, Stud, Razz, Stud Hi-Lo, 2-7 Triple Draw, Badugi…) as a spec, plus hand evaluators for high, low and Badugi hands. |
| [`src/modifiers/`](../packages/engine/src/modifiers) | Optional extras that plug into a hand without changing the core: bomb pots, double board, the 7-2 bounty, the Nit game, rake. |
| [`src/settings/`](../packages/engine/src/settings) | The table settings schema, shared by the server (which enforces it) and the settings dialog (which edits it). |
| [`src/wire.ts`](../packages/engine/src/wire.ts) | The list of every message the browser and server send each other, with their types. A good index of what the app can do. |
| [`src/audit.ts`](../packages/engine/src/audit.ts) | The rules of the public record's hash chain. |

### packages/tournament: the tournament director

A tournament is a long-running state machine: registration, a start time,
blind levels and breaks, balancing and breaking tables, rebuys and add-ons,
knockouts, payouts. [`src/director.ts`](../packages/tournament/src/director.ts)
does all of it as `apply(state, command, now)` and `tick(state, now)`, each
returning a new state and a list of events. It never plays cards: the server
plays the hands and reports the results back. `nextWakeAt` tells the server
when the director next needs to be woken (the next level, a scheduled start).

Other files hold blind structures (`structure.ts`), payout tables
(`payouts.ts`), seating (`seating.ts`), repeating events (`recurrence.ts`)
and seasons (`season.ts`).

### apps/server: the game server

| Where | What it does |
| --- | --- |
| [`src/index.ts`](../apps/server/src/index.ts) | Start-up: open the database, open the public record, build the app, resume saved tables and tournaments, and save everything on shutdown. Short, and a good first read. |
| [`src/app.ts`](../apps/server/src/app.ts) | Wires everything together: the HTTP routes (`/api/...`) and every socket message handler (`on('hand:act', …)`, `on('table:create', …)` and so on). Also `broadcast`, which sends each watcher their own view after a change. |
| [`src/runtime/table.ts`](../apps/server/src/runtime/table.ts) | `TableRuntime`: one per table. Seat requests and approvals, host controls, timers, the time bank, bots, and the steps between hands (apply queued settings, handle busts, plan blinds, shuffle, deal). The largest file, so read it by method name rather than top to bottom. |
| [`src/runtime/view.ts`](../apps/server/src/runtime/view.ts) | `tableView`: builds what one particular person sees. This is where hidden information is filtered out. |
| [`src/tournament/manager.ts`](../apps/server/src/tournament/manager.ts) | Runs the director on a real clock, opens and closes tables for it, and saves and resumes tournaments. |
| [`src/scheduler/scheduler.ts`](../apps/server/src/scheduler/scheduler.ts) | Timers that must survive a restart (a tournament's start time, for example) are kept as rows in a `jobs` table. |
| [`src/bots/`](../apps/server/src/bots) | Practice bots (`strategy.ts`) and coach tips (`coach.ts`). Bots only see what their own seat could see. |
| [`src/identity/`](../apps/server/src/identity), [`accounts.ts`](../apps/server/src/accounts.ts), [`google.ts`](../apps/server/src/google.ts) | Who you are: a random secret your browser keeps (the server stores only its hash), optional accounts with passwords, and Sign in with Google. |
| [`src/audit.ts`](../apps/server/src/audit.ts) | Writes the public record as hands finish and chips move. |
| [`src/db/`](../apps/server/src/db) | The database tables (`schema.ts`) and the code that reads and writes them. Migrations are the numbered SQL files in [`apps/server/drizzle/`](../apps/server/drizzle) and run automatically at start-up; `npm run db:generate` makes the next one, and the rules for them are in [ARCHITECTURE.md](ARCHITECTURE.md#database-migrations-appsserverdrizzle). |
| [`src/restore.ts`](../apps/server/src/restore.ts), [`db/backup.ts`](../apps/server/src/db/backup.ts) | Backups out, restores in. See [DEPLOY.md](DEPLOY.md#backups). |

### apps/web: the website

A React app built with Vite. [`src/App.tsx`](../apps/web/src/App.tsx) maps
each address (`/t/<id>` for a table, `/tn/<id>` for a tournament, `/rules`,
`/fairness`, …) to a page. [`src/socket.ts`](../apps/web/src/socket.ts)
opens the connection and keeps your browser's secret.

- [`src/TablePage.tsx`](../apps/web/src/TablePage.tsx) listens for
  `table:state` and draws the table with the components in
  [`src/components/`](../apps/web/src/components): `Table.tsx` (the felt and
  seats), `ActionBar.tsx` (your buttons), `SidePanel.tsx` (log, ledger, hands, stats), `table/Chat.tsx`,
  `Replayer.tsx` and `FairCheck.tsx`.
- [`components/ErrorBoundary.tsx`](../apps/web/src/components/ErrorBoundary.tsx)
  shows "Something broke" and a Reload button when a page crashes, instead
  of a blank screen (the table's side panel and chat have their own, so the
  table stays). [`src/reportError.ts`](../apps/web/src/reportError.ts)
  sends what broke to `POST /api/client-error`
  ([`clientErrors.ts`](../apps/server/src/clientErrors.ts)), which writes
  one line to the server log: the kind of page (`/t/:id`), never its link.
- [`components/FeedbackDialog.tsx`](../apps/web/src/components/FeedbackDialog.tsx)
  is Send feedback in the table menu. It goes over the socket
  (`feedback:send`) to [`feedback.ts`](../apps/server/src/feedback.ts),
  which saves it with the table and hand number in the `feedback` table.
  It is private: only the admin reads it, on `/roadmap/admin` or from
  `GET /api/feedback`.
- [`src/fair.ts`](../apps/web/src/fair.ts) is your browser's half of fair
  dealing: it sends your seed for the next hand and watches that it was used.
  [`src/audit.ts`](../apps/web/src/audit.ts) checks the public record when
  you visit (at most every 10 minutes).
- [`src/tournament/`](../apps/web/src/tournament) holds the tournament lobby
  and creation pages; [`src/rules/`](../apps/web/src/rules) the How to play
  guides; [`src/account/`](../apps/web/src/account) sign-in, profile,
  leaderboard and hand search.
- The `/fairness` page is [docs/FAIRNESS.md](FAIRNESS.md) itself, and
  `/privacy` is [docs/PRIVACY.md](PRIVACY.md) and `/terms` is
  [docs/TERMS.md](TERMS.md), so the site and the repository
  can't say different things. `/credits` is [docs/CREDITS.md](CREDITS.md)
  plus a list of every open-source package the site ships, which
  [`licenses.mjs`](../apps/web/licenses.mjs) makes from what's installed at
  build time, along with `/third-party-licenses.txt` (each package's
  license in full).

## Follow one bet from click to screen

Reading this path once is the fastest way to see how the parts fit.

1. You press **Raise** in
   [`ActionBar.tsx`](../apps/web/src/components/ActionBar.tsx). It sends the
   socket message `hand:act` with `{ type: 'raise', to: 120 }` (raise to 120 chips in total this round),
   plus the turn it was pressed on: the hand's number and how many events it had.
2. In [`app.ts`](../apps/server/src/app.ts), `on('hand:act', …)` cleans up
   the input and calls `act` on your table's `TableRuntime`. If anything
   throws (that turn has already passed, not your turn, too small a raise),
   the error goes back to your browser only.
3. [`TableRuntime.act`](../apps/server/src/runtime/table.ts) finds your seat
   and calls the engine's `act` in
   [`core/hand.ts`](../packages/engine/src/core/hand.ts), which checks the
   raise against the legal actions and records events. If the betting round
   is over, the engine also deals the next street (or the showdown) right
   there.
4. Back in the runtime, it closes the hand if it is over (`finishHand`), then
   does whatever else is now due (a bot's move, the next deal), arms the
   timers, and calls `onChange`.
5. `onChange` in `app.ts` updates the public record, schedules a save of the
   table, and calls `broadcast`. For **each** person watching, `tableView`
   builds their own view, with `visibleEvents` filtering out cards they may
   not see, and sends it as `table:state`.
6. Every browser redraws. When the hand ends, `onHandFinished` saves the
   hand to the `hands` table and adds its fingerprint to the public record.

A new hand starts from `dealHand` in the runtime. The server published a
fingerprint of this hand's secret one hand earlier; it now combines that
secret with the seeds the seated browsers sent, builds the deck with
`deckFromSeed`, and calls the engine's `startHand`. FAIRNESS.md explains why
it happens in that order.

## Where to start reading

- **"Is the shuffle fair?"** Read "The shuffle, in short" near the top of
  [FAIRNESS.md](FAIRNESS.md), then
  [`packages/engine/src/fairness.ts`](../packages/engine/src/fairness.ts)
  (under 300 lines), then
  [`scripts/verify-hand.mjs`](../scripts/verify-hand.mjs), which checks a
  hand without using any of the app's code. FAIRNESS.md also lists, plainly,
  the ways the person running the server could still cheat, and what the
  public checks can and can't catch.
- **"How do the poker rules work?"** `core/types.ts`, then `core/hand.ts`,
  then the tests in [`packages/engine/test/core`](../packages/engine/test/core).
- **"How does a table run?"** `apps/server/src/index.ts`, then the socket
  handlers in `app.ts`, then `TableRuntime` (`dealHand`, `act`,
  `finishHand`).
- **"How do tournaments work?"** `packages/tournament/src/types.ts`, then
  `director.ts`, then `apps/server/src/tournament/manager.ts`.
- **"How does the site look and behave?"** `apps/web/src/App.tsx`, then
  `TablePage.tsx` and `components/Table.tsx`.

The tests are often the clearest description of intended behaviour. Each
package has a `test/` folder (the website keeps its tests next to the code as
`*.test.ts`). Website tests run without a page unless the file starts with
`// @vitest-environment jsdom`: then it can render a screen with Testing
Library, as `components/ActionBar.test.tsx` does for the betting bar.

## Running it on your own computer

You need [Node.js](https://nodejs.org) 22 (20 or later works for the
stand-alone checkers) and git.

```bash
git clone https://github.com/jcolter11374/rsdp-poker-live
cd rsdp-poker-live
npm install
npm run dev
```

Open http://localhost:5173. The game server runs on port 3001 and the
website on 5173 (it reloads as you edit). Without any setup, data goes to an
embedded database in `apps/server/.data/`; delete that folder to start fresh.
To play against yourself, open a second browser or a private window, since
each browser is a different player. Practice bots work locally too.

Other commands, all from the top folder:

```bash
npm test             # every unit test in all four parts
npm run typecheck    # TypeScript checks without building
npm run build        # build the website for production
npm start            # serve the built website and the game server together on :3001
npm run smoke        # browser test; see below
```

The smoke test drives a real browser, so install one first with
`npx playwright install chromium`. It needs the built website served by the
game server: run `npm run build && npm start` in one terminal, then
`BASE_URL=http://localhost:3001 npm run smoke` in another. The play-test
scripts for a release run the same way; see
[e2e/playtest/README.md](../e2e/playtest/README.md).

To run some of the tests, go into a package and name a file or folder, for
example `cd packages/engine && npx vitest run test/core` or
`cd apps/server && npx vitest run test/runtime.test.ts`. The Postgres tests
are skipped unless `TEST_DATABASE_URL` points at a throwaway database (the
upgrade test in `migrations.test.ts` also makes and drops a scratch database
next to it).

The same production image the live site runs can be built with Docker; see
[DEPLOY.md](DEPLOY.md#local-check-of-the-production-image).

## From a commit to the live site

| Step | Where |
| --- | --- |
| Every piece of work starts as a GitHub issue. Work happens on branches whose pull requests name their issue ("Closes #123") and are merged into `develop`; releases then go from `develop` to `main`. A fix that can't wait goes straight into `main` the same way. | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Every pull request, and every push to `main` or `develop`, runs the checks: typecheck, all tests (including fuzz tests that deal up to 3,000 random hands across every game through the engine and random games through whole tables), a production build, the browser smoke test against the Docker image, and a backup restore drill. | [`ci.yml`](../.github/workflows/ci.yml) |
| Every pull request is also checked for a linked issue, and a release into `main` for exactly one new changelog entry with a version. When a pull request is merged into `develop`, the issues it closes are labelled `status: on develop`. | [`pr-checks.yml`](../.github/workflows/pr-checks.yml), [`issue-status.yml`](../.github/workflows/issue-status.yml), [`scripts/release/`](../scripts/release) |
| A pull request into `main` (a release) also rehearses the upgrade: `main`'s image makes data, the new image starts on it and must give the same leaderboard and public record and read back every saved table and tournament, and `main`'s image must do the same on the upgraded data (a rollback). | [`upgrade.yml`](../.github/workflows/upgrade.yml), [`scripts/upgrade/`](../scripts/upgrade) |
| When those pass on `main`, GitHub builds the image, signs a record of which commit it came from, and tells Fly.io to run exactly that image. | [`deploy.yml`](../.github/workflows/deploy.yml) |
| After each deploy, the commit is tagged with the release's version (`v2026.11.01`), a GitHub release is published with its notes, and the issues it put live are closed. | [`release.yml`](../.github/workflows/release.yml), [Releases](https://github.com/jcolter11374/rsdp-poker-live/releases) |
| After every successful deploy, and on a schedule set to every hour (GitHub starts it hours late, so every few hours in practice), a GitHub job checks which image the live site really runs, and copies the public record to the `transparency` branch. Anything wrong opens a public issue. | [`transparency.yml`](../.github/workflows/transparency.yml), [`scripts/transparency/`](../scripts/transparency) |
| Once a day (scheduled for 09:41 UTC; GitHub starts it hours late), a GitHub job takes an encrypted backup and test-restores it. | [`backup.yml`](../.github/workflows/backup.yml), [DEPLOY.md](DEPLOY.md#backups) |
| Once a day (scheduled for 06:23 UTC; GitHub starts it hours late), a GitHub job runs the fuzz tests on `main` far deeper than CI does (400 random cash tables, 400 random tournaments played four ways each, 30,000 random hands), on GitHub's machine. A failure opens an issue naming the failing seeds; the next run that passes closes it. | [`fuzz-nightly.yml`](../.github/workflows/fuzz-nightly.yml) |
| A GitHub job scheduled every 5 minutes checks the site and its database are up. GitHub starts it hours late, so it is a slow backstop; a quick alert needs an outside monitor (see [DEPLOY.md](DEPLOY.md#site-down-alert)). | [`uptime.yml`](../.github/workflows/uptime.yml) |

The live site is a single small machine on Fly.io. It must stay a single
copy, because the live tables exist in that one process's memory; see
[DEPLOY.md](DEPLOY.md).

## How this was built, honestly

John directs the project and makes the product decisions. Most of the code
was written by an AI coding assistant (Claude, through Claude Code), working
in several parallel threads on separate parts. That is why
[ARCHITECTURE.md](ARCHITECTURE.md) talks about "workstreams" (W0 to W4) that
own different folders, and why many commits are co-authored by Claude.

Changes are checked by the automated tests and CI above, and by a separate
review pass that we run ourselves with another AI session. Those reviews are
not independent and nobody outside the project has audited the code. If you
are checking fairness, rely on what you can verify yourself: the code is
public, `scripts/verify-hand.mjs` and `scripts/verify-audit.mjs` use none of
the app's code, and FAIRNESS.md says what those checks prove and what they
don't.

## A few words you'll see in the code

| Word | Meaning |
| --- | --- |
| **runtime** | The server object that runs one table (`TableRuntime`). |
| **view** | What one person is sent about a table, with hidden things removed. |
| **event** | One thing that happened in a hand (a card dealt, a bet, a pot won). The hand is its list of events. |
| **director** | The tournament logic in `packages/tournament`. |
| **commit / commitment** | A fingerprint of a secret, published before the secret is used, so it can't be swapped later. |
| **server seed, client seed, hand seed** | The server's secret for a hand, each browser's contribution, and the two combined into the deck. |
| **public record / audit log** | The append-only hash chain of hands, chip movements and admin actions. |
| **snapshot** | A table's whole state saved as JSON, so a restart resumes it. |
| **PGlite** | Postgres compiled to run inside the Node process, used when no separate database is set up. |
| **host / co-host / staff** | The table's creator, and people they gave some host powers. |
