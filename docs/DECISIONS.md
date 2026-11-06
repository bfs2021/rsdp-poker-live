# Decisions

The lasting decisions behind RSDP Poker Live!: what was decided, by whom, when, why, and where it shows in the code. Read this before changing something that looks odd. It may be on purpose.

How this file works:

- **Who decided** says whether it was John's call or Claude's. Claude sessions make routine engineering and product calls themselves and report them. Those are marked "Claude", and John can overturn any of them.
- Quotes of John are his own words, checked against his messages. Everything else is a summary.
- Entries are never rewritten. When a decision changes, add a new entry that says which one it replaces, and mark the old one **Replaced by D*n***. The one exception is an **Open question** line: once John answers, replace it with his answer and the date, and link where he said it.
- Private details stay out of this public file: friends' names, the group's spreadsheet, budgets.

| # | Decision | Decided | By |
| --- | --- | --- | --- |
| [D01](#d01-scope-full-parity-every-paid-feature-free) | Scope: full parity, every paid feature free | 2026-10-25 | John |
| [D02](#d02-the-groups-games-and-house-rules) | The group's games and house rules | 2026-10-25 | John |
| [D03](#d03-priorities-cash-games-first) | Priorities: cash games first | 2026-10-25 | John |
| [D04](#d04-who-decides-what) | Who decides what | 2026-10-25, 2026-11-01 | John |
| [D05](#d05-branches-merges-and-releases) | Branches, merges and releases | 2026-10-25, 2026-10-26 | John, with Claude's conditions |
| [D06](#d06-whats-new-and-the-changelog) | What's new and the changelog | 2026-10-26 | John |
| [D07](#d07-never-test-against-the-live-site) | Never test against the live site | 2026-10-25 | John |
| [D08](#d08-hosting-one-always-on-machine-on-flyio) | Hosting: one always-on machine on Fly.io | 2026-10-25 | Claude; cost rule John |
| [D09](#d09-stack-and-storage) | Stack and storage | 2026-10-25 | Claude, accepted by John |
| [D10](#d10-provably-fair-dealing-and-when-hands-are-revealed) | Provably fair dealing, and when hands are revealed | 2026-10-25, 2026-11-01 | John; design Claude |
| [D11](#d11-making-it-harder-for-john-to-cheat) | Making it harder for John to cheat | 2026-10-26 | John picked; design Claude |
| [D12](#d12-honest-trust-wording) | Honest trust wording | 2026-10-26, 2026-10-29 | John |
| [D13](#d13-daily-encrypted-backups) | Daily encrypted backups | 2026-10-26 | John approved; design Claude |
| [D14](#d14-no-live-huds-safeguards-for-spectators) | No live HUDs; safeguards for spectators | 2026-10-26 | John; details Claude |
| [D15](#d15-cash-tables-in-dollars-and-cents) | Cash tables in dollars and cents | 2026-10-27 | John |
| [D16](#d16-the-groups-tournament-defaults) | The group's tournament defaults | 2026-10-30 to 2026-11-01 | John |
| [D17](#d17-tournament-rules-chosen-by-claude) | Tournament rules chosen by Claude | 2026-10-25 | Claude |
| [D18](#d18-cash-table-simplifications-on-purpose) | Cash-table simplifications, on purpose | 2026-10-25, 2026-10-26 | Claude; nudge John |
| [D19](#d19-accounts-privacy-and-keeping-records) | Accounts, privacy and keeping records | 2026-10-25 to 2026-10-27 | John and Claude |
| [D20](#d20-group-results-proposed-not-built) | Group results (proposed, not built) | 2026-10-30 | John; plan Claude |
| [D21](#d21-look-and-feel) | Look and feel | 2026-10-25 to 2026-10-29 | John |
| [D22](#d22-how-work-is-tracked-and-checked) | How work is tracked and checked | 2026-11-01 | John asked; details Claude |
| [D23](#d23-the-code-is-under-the-mit-license) | The code is under the MIT license | 2026-11-01 | John |
| [D24](#d24-claude-sessions-may-read-the-live-site) | Claude sessions may read the live site | 2026-11-05 | John |
| [D25](#d25-full-and-light-changes) | Full and light changes | 2026-11-05 | John; the lists Claude |
| [D26](#d26-a-game-night-recap-for-john-read-by-claude) | A game-night recap for John, read by Claude | 2026-11-05 | John asked; design Claude |
| [D27](#d27-the-operator-can-read-table-chat) | The operator can read table chat | 2026-11-05 | John; design Claude |
| [D28](#d28-one-comparison-page-may-name-pokernow) | One comparison page may name PokerNow | 2026-11-06 | John |

---

## D01. Scope: full parity, every paid feature free

- **Decided:** 2026-10-25, by John.
- **Decision:** "Clone" means full feature parity with PokerNow, not a small first version, with John's own additions later. Every feature PokerNow charges for (bomb pots, 7-2, double board, game rotation, Sit & Gos, the replayer and so on) is free for everyone: no payments and no tiers. The code, art, sounds and wording are all original. The site's own pages don't name PokerNow (a test checks the About page), except one comparison page (D28). Two older release notes do (the all-in runout line in the changelog and "Blinds the RSDP way" in What's new); they are live, so they stay. New pages and notes shouldn't name it.
- **Why:** getting the paid features to the whole group for free is one of John's main reasons for the project.
- **Where:** README (free for everyone; original app), [ARCHITECTURE.md](ARCHITECTURE.md) ("No PokerNow code, art, sounds or wording"), `apps/web/src/about/about.test.ts` (About page only).
- **Don't** scope a feature down without asking John.

## D02. The group's games and house rules

- **Decided:** 2026-10-25, by John.
- **Decision:**
  - Beyond PokerNow's games: Seven Card Stud, Razz, Stud Hi-Lo, 2-7 Triple Draw and Badugi, with rules help in the game.
  - Scheduled tournaments start by themselves, with no click from the creator.
  - Run it twice is for cash games only.
  - The host's approval of rebuys is a setting the host can turn off. It is on by default at cash tables and off in tournaments.
  - Buy-in amounts aren't enforced; the group agrees them among themselves.
  - Where PokerNow differs from how the group plays, the group's way is the default and PokerNow's is an option.
- **Why:** the group plays these games and is teaching them to friends. Starting tournaments by hand was John's biggest annoyance with PokerNow.
- **Where:** README (games), `packages/tournament/README.md` (auto-start, rebuy approval), `packages/engine/src/settings/schema.ts` (run it twice off in tournaments; buy-ins not enforced by default).

## D03. Priorities: cash games first

- **Decided:** 2026-10-25, by John.
- **Decision:** cash games must be rock solid first, because that's where friends will try the site and build trust. There's no rush for tournaments. Clubs and AI game analysis are off the roadmap for now. Audio and video chat stay, at the very end.
- **Where:** `apps/web/src/roadmap/roadmap.json`.

## D04. Who decides what

- **Decided:** 2026-10-25, and 2026-11-01 for the record-keeping rule, by John.
- **Decision:** Claude leads the day-to-day work. It makes engineering and routine product calls, starts work as needed, and posts short updates. It brings John only real product decisions: what the product is, or what it costs. On 2026-11-01 John asked for standard professional practice in tracking and documenting the work. GitHub is the record, and an AI session's memory is only a cache.
- **Why:** John doesn't want to micromanage. Four wrong status reports on 31 Oct and 1 Nov came from facts kept only in an AI session's memory.
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md), [CLAUDE.md](../CLAUDE.md), D22.

## D05. Branches, merges and releases

- **Decided:** by John, in two steps:
  - **2026-10-25, 21:12 UTC, on a choice card.** He picked "Yes, merge to develop": merge each fix into `develop` once CI is green and a review passes, and report afterwards. Merging into `main` still needed his OK then. (Minutes later he also wrote: "I'll leave all of this up to your discretion. Don't confuse my enthusiasm for impatience.")
  - **2026-10-26, 05:13 UTC.** "Feel free to push things as they are done without asking me." From then on, finished work may go live without asking him each time.
- **Decision:** feature branch → `develop` → `main`, and a merge into `main` deploys. A review pass means one we run ourselves, recorded on the pull request (D22).
- **Claude's own conditions** on the standing OK, not John's words: test each release on a copy first, prefer quiet times, and tell John after each release. Asking first about anything that costs money or changes the product is John's own rule (D04, D08). **Partly replaced by D25** (2026-11-05): a release of only light changes skips the copy test and the wait for a quiet time.
- **Settled 2026-11-05 by [D25](#d25-full-and-light-changes) ([#236](https://github.com/jcolter11374/rsdp-poker-live/issues/236)):** John approved Claude's two-path proposal, which keeps quiet times for releases with any full change and lets releases of only light changes go out whenever they're ready. (The question was whether John's "go ahead and push updates now. Don't worry about active tables" of 2026-10-26, 23:00 UTC, applied to every release or only to that one. He didn't say; the new rule replaces it.)
- **Where:** [DEPLOY.md](DEPLOY.md#releasing), [CODE_TOUR.md](CODE_TOUR.md).

## D06. What's new and the changelog

- **Decided:** 2026-10-26, by John.
- **Decision:** John: "Also minor bug fixes don't need to go into the what's new tracker. We could maybe have a changelog on the site for that." So What's new lists features players will notice, and /changelog lists every release with its small fixes. Releases bundle finished work when it's ready, with no fixed schedule (Claude's call).
- **Where:** `apps/web/src/roadmap/whatsnew.json`, `changelog.json`, `ChangelogPage.tsx`. Release versions and tags: D22.

## D07. Never test against the live site

- **Decided:** 2026-10-25, by John, after test data reached the live site (the "Smoke Cup", PR #35).
- **Decision:** never run bots, test tables or test games against the live site; test on a copy. Only read-only checks touch the live site, from GitHub Actions. **Replaced in part by [D24](#d24-claude-sessions-may-read-the-live-site)** (sessions may now also read it directly). Removing something from the live site needs John's OK. Practice bots are only ever seated by hand by a player or host: seats are never filled with bots automatically, and tournaments refuse bots.
- **Where:** `e2e/smoke.mjs` (refuses the live address), `deploy.yml` (read-only checks), `apps/server/src/runtime/table.ts` (no bots in tournaments), [RUNBOOK.md](RUNBOOK.md#incident-log).

## D08. Hosting: one always-on machine on Fly.io

- **Decided:** 2026-10-25. Claude set it up; the cost rule is John's.
- **Decision:** one always-on Fly.io machine (1 GB of memory) with a 1 GB data volume, never two copies. Fly bills John's account by usage. Anything that raises the cost needs John's OK first.
- **Why:** all live game state runs in one process, and a scheduled tournament must start even when nobody has the site open. Why Fly rather than another host wasn't recorded.
- **Where:** `fly.toml`, [DEPLOY.md](DEPLOY.md#flyio-production).

## D09. Stack and storage

- **Decided:** 2026-10-25. Claude proposed it and John accepted. The database upkeep (2026-10-26) is Claude's.
- **Decision:**
  - TypeScript throughout: pure engine and tournament packages; an Express and Socket.IO server that's in charge and holds tables in memory; a React website.
  - Storage through Drizzle: Postgres when `DATABASE_URL` is set, otherwise embedded PGlite, which is what the live site runs.
  - PGlite has no automatic clean-up, so the server vacuums it at start-up and every 5 minutes. Don't remove that.
  - Idle cash tables are unloaded from memory after 45 minutes.
- **Why:** pure packages are easy to test and can replay hands in the browser. Without the clean-up, the 1 GB volume fills after roughly 600 to 700 hands (about 1.5 MB a hand). Why the live site uses PGlite rather than a managed Postgres wasn't recorded.
- **Where:** [ARCHITECTURE.md](ARCHITECTURE.md), `apps/server/src/db/client.ts`.

## D10. Provably fair dealing, and when hands are revealed

- **Decided:** 2026-10-25 by John (the requirement and the reveal rule). The design is Claude's. The reveal rule was changed by John on 2026-11-01.
- **Decision:** a fair, random deal anyone can check afterwards (rsdp-fair-v1). The server commits to a secret seed a hand ahead, seated players' browsers add their own seeds, and anyone can re-deal a revealed hand. Folded cards stay private while a game is on. A hand's seeds are revealed once the game has stayed stopped for 30 minutes, or 12 hours after the hand, whichever comes first. The 30 minutes were added by John on 2026-11-01; before that, stopping the game revealed at once.
- **Why:** the deal must survive anyone's checking. The 30 minutes stop a quick Stop-then-Start from showing folded cards mid-session.
- **Where:** [FAIRNESS.md](FAIRNESS.md), `apps/server/src/runtime/table.ts` ("John's call, 2026-11-01"), PR #170.
- **Don't** weaken the browser checks, or reveal sooner, without asking John.

## D11. Making it harder for John to cheat

- **Decided:** 2026-10-26. John picked "the recommended package" from options Claude wrote up (PR #97). It cost nothing.
- **Decision:**
  - GitHub builds and signs every image, and Fly runs that exact image.
  - A hash-chained public record of hands, ledgers and admin actions is copied to the `transparency` branch.
  - A watcher checks the live machine and opens a public issue when something is wrong.
  - Players can see all this on the /transparency page.
  - Not chosen: card-protocol cryptography ("mental poker", judged impractical), a paid audit, and a friend as co-admin.
- **Operating rules (Claude's):**
  - Never deploy from a laptop.
  - Add any new secret to the watcher's list, or any new setting to `fly.toml`, before it's set.
- **Where:** [FAIRNESS.md](FAIRNESS.md#checking-john), `scripts/transparency/`, [DEPLOY.md](DEPLOY.md#adding-a-setting-or-secret).

## D12. Honest trust wording

- **Decided:** 2026-10-26 and 2026-10-29, by John.
- **Decision:** be completely honest with players about trust. /fairness lists every way John could cheat. Our own review passes are never called "independent". They're "a separate review we ran ourselves, not an outside auditor". No overselling. The AI-made explainer video stays off /fairness (it oversold). A "you're trusting John" box leads /fairness, and /terms says free, non-commercial and as-is (John read and approved both, PR #141).
- **Where:** [FAIRNESS.md](FAIRNESS.md), [TERMS.md](TERMS.md), README.
- Any page, release note or doc must keep to this.

## D13. Daily encrypted backups

- **Decided:** 2026-10-26. John approved, at no cost, and made the key pair himself. The design is Claude's.
- **Decision:**
  - GitHub Actions takes a backup once a day (the "Nightly backup" workflow, which GitHub usually starts between about 15:30 and 16:30 UTC; see [DEPLOY.md](DEPLOY.md)), test-restores it on a real server, and locks it to John's public key.
  - Only John holds the private key, and no AI session ever handles it.
  - Backups are kept 90 days.
  - A failure, or the site going down, opens an issue.
- **Where:** [DEPLOY.md](DEPLOY.md#backups), `.github/workflows/backup.yml`, `uptime.yml`.

## D14. No live HUDs; safeguards for spectators

- **Decided:** 2026-10-26, by John. The exemptions and safeguard details are Claude's.
- **Decision:**
  - No tracking tools at running tables: while the game runs, hand downloads are locked for anyone seated (in a tournament, anyone still in the event) and for onlookers who never played at the table, so a second device can't fetch them for a seated player. Reviewing hands afterwards is fine.
  - The in-table Stats tab stays. John's call; don't ask again.
  - A host can let spectators see every card, but only between hands and only for later hands. Players must agree before they sit, and everyone sees a warning.
  - Exempt from the lock: practice tables where only bots have played against you, the host and co-hosts while they aren't seated, and players who have left the table.
- **Where:** [FAIRNESS.md](FAIRNESS.md#huds-and-tracking-software), `apps/server/src/runtime/table.ts`, PRs #90, #168.

## D15. Cash tables in dollars and cents

- **Decided:** 2026-10-27, by John: "I think for cash we just don't have chips as an option. We treat it just like a casino and have chips for all the denomations of money."
- **Decision:** every cash table made since PR #132 (2026-10-27) counts in dollars and cents (one engine chip is one cent), with casino chips for each denomination. Older tables keep counting in chips. The home page starts new tables at .25/.50. Tournaments stay in plain chips. A table's unit never changes after it's created.
- **Where:** `packages/engine/src/settings/money.ts`, `apps/web/src/Home.tsx` (the .25/.50 start), PR #132.

## D16. The group's tournament defaults

- **Decided:** 2026-10-30 to 2026-11-01, by John.
- **Decision:**
  - New tournaments default to the group's own setup: No-Limit Hold'em, 63,000 chips, 28 levels of 8 minutes, no antes or breaks, and late registration through level 5 (the group's own PokerNow structure, PR #163).
  - The group's payout table is the default (PR #158), and the prize pool is on by default with a $20 buy-in (PR #161).
  - Table rules: 10 seconds to act, a 20-second time bank that refills every 30 hands, and no rabbit hunting (PR #165). Straddles are never allowed in tournaments.
  - Hosts can change the table rules until the first table opens (PR #172).
- **Where:** `packages/tournament/src/structure.ts` (RSDP levels and table rules), `saved.ts` (the RSDP starter), `payouts.ts` (the RSDP payout table), and `apps/web/src/tournament/TournamentCreate.tsx`, which makes them the new-tournament default. The package's own `defaultSettings()` in `director.ts` is still the generic 10,000-chip setup; the form starts from it and applies the RSDP starter.

## D17. Tournament rules chosen by Claude

- **Decided:** 2026-10-25, by Claude. All reversible.
- **Decision:**
  - Auto-start seats players 60 seconds early, and waits up to 15 minutes when there are fewer than 2 entrants.
  - Players busted in the same hand finish in order of their starting stacks, with ties during hand-for-hand.
  - A busted player who doesn't take a rebuy offer is placed with the hand that busted them, not when the offer ends (PR #170).
  - A player who joins a table mid-game is dealt in at once without posting, except on the button, the small blind or between them, where they wait one hand for the button to pass (the usual card-room rule; issue #311). Added 2026-11-05; John chose to keep this standard rule.
  - Bounties are shown per entry. A progressive knockout puts part of each bounty on the winner's head.
  - Invite codes are single-use, or one shared code. Invite-only events stay off the home page.
  - Season points: entrants minus place, plus one.
  - Browser alerts are opt-in. Guests can host and register with a display name.
  - One co-host model covers cash and tournaments.
- **Where:** `packages/tournament/README.md` ("Rules chosen"), `packages/tournament/src/listing.ts`.

## D18. Cash-table simplifications, on purpose

- **Decided:** 2026-10-25 and 2026-10-26, by Claude. The betting nudge is John's.
- **Decision:** these are simpler than PokerNow on purpose. Don't "fix" them without asking John.
  - The Nit game's loser pays from their stack at the end of the round, with no money held aside. A shortfall goes on their buy-in.
  - Hidden rake is cosmetic; the log still shows it.
  - Losing hands are mucked by default, with a show-all option.
  - Defaults: waitlist off (when it's on, a freed seat is held 60 seconds for the next person), offline players' seats never released, profanity filter off, rabbit hunting on in cash games. The host can shuffle seats only between hands.
  - Unusual game and betting pairings get a gentle nudge but are never blocked (John, 2026-10-26).
- **Why:** simpler code with outcomes the group accepts.
- **Where:** `apps/web/src/rules/extras.ts` (the Nit rule as players are told it).

## D19. Accounts, privacy and keeping records

- **Decided:** 2026-10-25 to 2026-10-27. John chose Google sign-in, how records are kept, the analytics and the privacy policy. Claude chose guest play without accounts and the password reset without email.
- **Decision:**
  - Accounts are optional; guests can play and host.
  - Sign in with Google uses only the basic profile, no email address.
  - Password reset works without email, through a one-time code from the admin.
  - Hands and ledgers are kept for good. Anyone can hide a table from their own profile. A host can delete only a table where no real game happened.
  - Practice games are kept apart from real ones.
  - No ads, no analytics services, no trackers and no third-party scripts. IP addresses are held in memory only and never saved. Rate-limit entries are forgotten within about an hour; the address a tournament was made from is kept while that tournament is open (PR #168). A restart forgets them all. [PRIVACY.md](PRIVACY.md) has the exact wording.
  - Any new stored data, cookie or outside service needs a [PRIVACY.md](PRIVACY.md) update.
- **Where:** [ARCHITECTURE.md](ARCHITECTURE.md), [PRIVACY.md](PRIVACY.md).

## D20. Group results (proposed, not built)

- **Proposed:** 2026-10-30. John set the goal; the plan is Claude's.
- **Proposal:** the group's own results spreadsheet stays the official record for now. Later, the site may help keep it up to date, with results visible only to signed-in members of the group. The details are still open. Two parts have shipped: the default payout table (D16, PR #158), and the prize pool on by default with a $20 buy-in, so buy-ins and prizes are saved with each tournament's results (PR #161).

## D21. Look and feel

- **Decided:** 2026-10-25 to 2026-10-29, by John, choosing from mock-ups.
- **Decision:**
  - A clean, flat felt look, with original art.
  - Cards tucked into the nameplate.
  - Lit felt, motion, big moments and the group's crest, with the spin toned down.
  - Original sounds, and the turn clock as a smooth line.
  - John sees before-and-after pictures before a change to the table's look goes live.

## D22. How work is tracked and checked

- **Decided:** 2026-11-01. John asked for standard practice (D04); the details below are Claude's and reversible.
- **Decision:**
  - Every piece of work is a GitHub issue, and every pull request names its issue.
  - Each release gets a date-based version, a git tag and GitHub release notes (PR #175).
  - Each review pass is posted as a comment on its pull request: what was checked, the findings, how each was resolved, and the commit reviewed.
  - Library updates arrive as monthly Dependabot pull requests into `develop`. A weekly check keeps an issue open while high or critical security advisories exist.
- **Not done, on purpose:**
  - A paid staging server (it would roughly double the bill; releases are tested on a copy instead, see [DEPLOY.md](DEPLOY.md#before-a-release-testing-on-a-copy)).
  - Required approvals on pull requests. Every PR comes from John's one account, and GitHub doesn't let an author approve their own PR.
  - Strict commit formats, and an outside error-tracking service (it would send players' data to another company).
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md), [CLAUDE.md](../CLAUDE.md), `.github/dependabot.yml`.

## D23. The code is under the MIT license

- **Decided:** 2026-11-01, by John, choosing MIT over AGPL-3.0 or keeping all rights reserved (issue #202).
- **Decision:** the code is open source under the MIT license. Anyone may use, copy, change and run their own copy, as long as the copyright notice and license go with it. Before this the repository had no license, so people could read the code but had no clear permission to copy it, though the fairness page encourages keeping a copy.
- **Where:** [LICENSE](../LICENSE), the `license` field in every package.json, README, [CREDITS.md](CREDITS.md).

## D24. Claude sessions may read the live site

- **Decided:** 2026-11-05, by John, saying yes to letting Claude's sessions read the live site (issue #298). Replaces the "from GitHub Actions" part of D07; the rest of D07 stands.
- **Decision:** Claude's cloud environment allows one extra host, `rsdp-poker-live.fly.dev`, so a session can read the live site directly to check a release or read feedback. Only reads: GET requests to public pages and read-only endpoints such as `/api/version` and `/api/health`. Still never bots, test tables, test tournaments, sign-ups or anything else that writes (D07). Fly itself (`fly.io`, `flyctl`, deploys, secrets) is not on the list and still goes only through `main`'s workflows.
- **Why:** routing every read through a workflow made release checks and reading feedback slow.
- **Where:** the cloud environment's network settings (John's Claude account, not this repo), [CLAUDE.md](../CLAUDE.md), [RUNBOOK.md](RUNBOOK.md).

## D25. Full and light changes

- **Decided:** 2026-11-05, 16:10 UTC, by John, on Claude's proposal; the details are Claude's. Claude set out what each shortcut would risk: skipping the review pass lets more bugs reach players, skipping the play-test means problems show up in a real game instead, and releasing at any time means a game can pause for a few seconds while the server restarts. The checks on GitHub can't be skipped. Claude recommended keeping the full process for anything that touches the game itself, and for low-risk fixes like wording, layout or download buttons, "a lighter review plus releasing as soon as it's ready". John: "If you think it is reasonable yes. If you think it is reckless no". Claude judged it reasonable: the checks on GitHub still run on every change, and every change that could affect a game keeps every step.
- **Decision:** a change takes one of two paths.
  - **Full**, for anything that touches the game or players' data: dealing, chips and pots, timers, tournaments, hidden cards, privacy, fairness and the public record, sign-in, stored data, how the site runs, and the safety checks themselves. CI, a separate review pass, a play-test on a copy, and a release at a quiet time.
  - **Light**, for changes that can't affect a game, who is allowed to see what, or what's stored: displayed wording, layout, download buttons that offer only what people can already download, docs. CI and a shorter review pass, and live as soon as it's ready.
  - When unsure, full. A release takes the path of its riskiest change.
- **Claude's calls**, not John's words: the exact lists and what a light review checks (in CONTRIBUTING.md), and dropping the copy test for light-only releases. The copy test was Claude's own condition in D05, and the proposal had already told John that skipping it means problems turn up in a real game.
- **Still applies:** D21 (John sees before-and-after pictures of a change to the table's look before it goes live) and D14 (the no-HUD lock on downloads).
- **Replaces** part of D05's conditions (the copy test and quiet times, for light changes), and settles D05's open question (#236).
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md#full-or-light-how-much-checking-a-change-needs), [DEPLOY.md](DEPLOY.md#releasing), [CLAUDE.md](../CLAUDE.md), the [pull request template](../.github/pull_request_template.md).

## D26. A game-night recap for John, read by Claude

**Replaced in part by [D27](#d27-the-operator-can-read-table-chat)** (the operator may now read table chat; the recap still reads none).

- **Decided:** 2026-11-05. John asked for a short recap after each game night (errors, player feedback, anything odd) so he never has to go looking (issue #297). The design is Claude's and reversible.
- **Decision:**
  - The server keeps its own error lines (and browser error reports) for 30 days in its database, and a line at each clean shutdown, so a restart without one reads as a crash. Fly's log forgets within days.
  - `GET /api/admin/recap` returns errors, restarts, activity counts, tournaments (late or never started) and what players sent with Send feedback, without names or tables (John chose to include the words, 2026-11-05) for a window of time. No chat: whether the operator may read table chat is John's call (issue #300). It takes a separate read-only key (`REPORT_KEY`), so the scheduled recap never holds the key that can delete tables or download the database.
  - A scheduled Claude task reads it the morning after a night with games and writes John a summary in his private Claude project, split into "could affect a real game" and "minor". Quiet nights send nothing.
- **Not done, on purpose:**
  - An outside error-tracking service (D22 still stands). The recap sends Anthropic far less: no chat, names, addresses, cards or chips. [PRIVACY.md](PRIVACY.md) says so.
  - Posting recaps to GitHub: the repository is public.
  - Recording each read in the public record: like the admin page's lookups, reading changes nothing.
- **Where:** `apps/server/src/recap.ts`, [DEPLOY.md](DEPLOY.md#game-night-recap).

## D27. The operator can read table chat

- **Decided:** 2026-11-05, by John: "I think the operator should be able to read table chat" (issue #300). The design is Claude's.
- **Decision:**
  - `GET /api/admin/chat/:id` returns the chat of one cash table, or of every table a tournament opened, by the table's or tournament's id. It works while the table is open and after it has closed. It sends only the words, the names players saw and the times: no player ids, no table log.
  - The admin page has a "Read a table's chat" form for it, with a download as text.
  - Only the admin key opens it. The read-only `REPORT_KEY` does not, so the scheduled recap can't read chat with the key it holds today.
  - Every read goes in the public record as an admin action (`read-table-chat` or `read-tournament-chat`), with only a fingerprint of the table or tournament (the same one its hands use, so people with its link can tell it was theirs), before the chat is sent, the way a backup is recorded. [/transparency](https://rsdp-poker-live.fly.dev/transparency) shows each one as "Chat read".
  - [/fairness](FAIRNESS.md#how-the-developer-could-cheat-you), [/privacy](PRIVACY.md) and /transparency say so.
- **What isn't recorded:** chat seen any other way: reading the database or a backup, a shell on the server, or being at the table. The pages say so.
- **Why recorded:** John could already read chat in the database (PRIVACY.md said so). The admin page makes it easy, so each use is public, unlike the admin page's other lookups, which change nothing and aren't recorded (D26's reasoning for the recap).
- **Not done, on purpose:** a GitHub workflow that downloads chat: the repository is public, and a workflow's files can be downloaded by others. Whether the game-night recap (D26) should use chat is a separate call for that work; if it does, its key, what it reads and the public record entry need their own decision.
- **Replaces** D26's "No chat: whether the operator may read table chat is John's call (issue #300)" as far as the operator goes; the recap itself still reads no chat until a change says otherwise.
- **Where:** `apps/server/src/app.ts` (`/api/admin/chat/:id`), `apps/web/src/roadmap/AdminPage.tsx`, [FAIRNESS.md](FAIRNESS.md), [PRIVACY.md](PRIVACY.md), `apps/web/src/fairness/TransparencyPage.tsx`.

## D28. One comparison page may name PokerNow

- **Decided:** 2026-11-06, by John, on a decision card ("Only on the comparison page"), after he asked to publish the feature comparison (issue #339).
- **Decision:** one public page may name PokerNow: a dated, factual feature comparison of this site, PokerNow free and PokerNow Plus. Every other page, guide and release note still doesn't name it.
  - The comparison stays honest, like /fairness: it keeps the rows where PokerNow is ahead (voice and video, phone alerts, track record) and marks things we dropped on purpose.
  - It says when it was checked and links PokerNow's own plans page as the source, since their features change.
  - It states facts, with no digs at PokerNow, and uses none of its art, logos or wording.
- **Why:** the no-name rule came from a session building the About page (2026-10-26), as caution about looking like a knock-off; John was never asked and no reason was recorded. A fair comparison helps friends see what they get here.
- **Replaces** D01's "the site's own pages don't name PokerNow" for that one page only.
- **Where:** issue #339 (the page, not built yet); `apps/web/src/about/about.test.ts` keeps the About page name-free.

## D29. In a mix with stud, only the stud games ante

- **Decided:** 2026-11-06, while adding HORSE and 8-Game (issue #335). John asked for the mixes; this detail is Claude's and reversible.
- **Decision:** a cash table has one set of stakes for every game in its rotation. When the rotation includes a stud game (Seven Card Stud, Razz, Stud Hi-Lo), the ante setting is the stud ante: hold'em, Omaha and draw hands in that rotation post no ante (of either kind). A rotation with no stud game keeps its antes in every game, as before. The Limit games bet the Limit small and big bets, which a new HORSE or 8-Game table sets to the big blind and twice it.
- **Why:** that is how HORSE and 8-Game are played in card rooms and online. Without it, a hold'em orbit in HORSE would ante as well as post blinds.
- **Not done, on purpose:** separate stakes for each game in a rotation (for example different blinds for 8-Game's No-Limit and Pot-Limit rounds). One set of stakes keeps the Stakes tab simple; the Mixed games guide says so.
- **Tournaments too** (added 2026-11-06, issue #338): in a tournament whose rotation includes a stud game, the levels that deal a blind game post no ante; the stud levels post the level's ante. A tournament's rotation can give each game its own betting (`gameBetting`), so HORSE and 8-Game tournaments play Limit Hold'em and Limit Omaha Hi-Lo.
- **Where:** `packages/engine/src/variants/mixes.ts` (`MIXED_GAMES`, `skipsMixedGameAnte`), `handSetup` in `apps/server/src/runtime/table.ts`, `levelFor` in `packages/tournament/src/director.ts`.
