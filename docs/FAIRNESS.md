# Fair dealing in RSDP Poker Live!

> ### The short version: you're trusting John
>
> John built and runs this site. Like every online poker site, the server sees everyone's cards, and whoever runs it could cheat if they really wanted to: peek at hands, or change the code. Nothing here can make that impossible.
>
> **Other players** shouldn't be able to see your cards or rig the deck through the site. The server only sends you your own cards, unless a table's host lets spectators see every card, which everyone at the table is told about and new players have to agree to before they sit down. Every player's browser helps shuffle. That's how it's designed, but it's a hobby project built with AI help, not professionally audited, and it could have bugs or be hacked in ways we don't know about. Players could also cheat outside the site, by sharing cards in a group chat or getting help from software, just like on any poker site.
>
> **What we've done** is make cheating hard to hide. The shuffle, every hand, every buy-in and every new version of the site are recorded publicly, where it's hard for John to quietly edit them, so a careful person could spot tracks. But if you don't trust John, no page can fix that, and you shouldn't play.
>
> If you do trust him, that's all you need to know. The rest of this page is the detail, for anyone curious.

This page explains how the cards are shuffled, how anyone can check a hand
after the fact, and what an audit of the code found. Plain-language summary
first, details after.

## The shuffle, in short

- **The shuffle is a real, unbiased random shuffle.** Every hand gets a brand
  new 256-bit secret from the server's cryptographic random number generator
  (the same kind used for passwords and encryption). The deck is shuffled
  from it with the standard Fisher-Yates method, using SHA-256 to turn the
  secret into numbers, with no rounding bias.
- **The deck is locked before the deal.** Before a hand is dealt, the table
  publishes a *commitment*: a SHA-256 fingerprint of that hand's secret. Once
  published, the secret can't be swapped without the fingerprint changing.
- **Whoever runs the server can't simply pick the cards.**
  While the previous hand is being played, every seated player's browser
  quietly sends its own random seed for the next hand. The deck depends on the
  server's secret *and* every player's seed. The server committed first, so it
  can't steer the result with its own secret; players never see that secret
  until later, so they can't predict the deck either. The only way left to
  steer it is to tamper with the players' seeds, and each browser watches its
  own (below).
- **Your browser keeps the server honest during play.** When a hand is dealt,
  everyone sees which seeds went into it. If your browser's seed was left out
  although it was sent in good time, a seed your browser never sent is
  listed under your name, more than one seed is listed under your name (even
  copies of yours: each copy changes the deck), a seed is listed for a practice
  bot (bots never send one) or for someone who wasn't dealt in (checked once
  your browser has seen everyone who was), the same seed is listed twice, or
  the commitment for the next hand was swapped for another without being
  dealt, the table shows a warning straight away. One case is harmless: if
  you sit at a table from two devices at once (a phone and a laptop, say), each
  sends its own seed and the table keeps only the newest, so the other device
  sees a seed it didn't send and warns about it. The warning says so; if you
  weren't on another device, take it seriously. Your browser
  also writes down what it saw during the hand: the button, who was dealt in
  and which of them were bots, the board, and every card shown to you.
- **Anyone can check a hand afterwards.** Open a hand in the replayer and press
  **🔒 Check this hand**. Once the hand is revealed, your browser rebuilds the
  deck from the seeds and *deals the hand again* by the rules: hole cards one
  at a time clockwise from the left of the button, then the board, draws and
  reshuffles. Each seed listed must come from a different person the record
  shows dealt in, never from a practice bot, with no seed listed twice: an
  extra seed where nobody's browser would check it could steer the deck. If
  your browser was at the table, the record's list of who was dealt in, and
  which were bots, must match what it wrote down there; otherwise the record's
  own list is all it has to go on. Every card dealt, shown
  or won with must match, the record must
  match the hand's history, and it must agree with what your browser wrote
  down at the table. **Download proof** saves a file
  that `node scripts/verify-hand.mjs` checks on its own, using only Node's
  built-in OpenSSL SHA-256 and none of the app's code. The file says whose
  each seed is, who the record shows dealt in, and which of them were bots
  (marked by the record, or seen as bots by your browser at the table), so the
  script runs the same seed-list check. It can't compare that list with what
  your browser saw at the table: "Check this hand" does that before you
  download. Files saved by older versions of the site don't say whose each seed is;
  for those the script only fails a seed listed twice or more seeds than
  seats dealt in, and says so.
- **When hands are revealed** (decided 25 October 2026, the half hour added
  1 November 2026): once the game has stayed stopped for 30 minutes, or 12
  hours after the hand, whichever comes first. The reveal shows the whole deck,
  including folded and mucked hands, so it waits until the game is over. A
  host who stops and starts again within the half hour is still in the same
  game, so earlier hands stay private. A game started again after the half
  hour keeps its earlier hands revealed, so the Stop button says so and points
  to Pause for a break. Practice bots explain each move to the one person who played
  that hand against only bots, once it is over. The explanations give rough
  numbers, never cards, so a folded bot's cards still wait for the reveal.
- **Your cards stay private during play.** The server sends each person only
  what they may see. Undealt cards, other players' hole cards and the secrets
  never leave the server during a hand.
- **Coach tips are for practice only.** Tips never show when another person
  is in the hand, or at a table where people have played each other, or in
  tournaments, and the server checks this, not your browser. Nothing stops
  someone using an odds calculator on another device at a table with people;
  we just never offer one there.
- **Some of what John could do now leaves public traces.** Since 26 October
  2026, GitHub builds and signs every release, checks which build the live
  site runs (every few hours in practice, and since 1 November 2026 also
  right after each release GitHub deploys), and keeps a copy of a
  tamper-evident record of every hand, chip total and admin action. See [Checking John](#checking-john) and
  the [/transparency](/transparency) page.
- **This doesn't make the developer impossible to cheat.** The next section
  lists, plainly, what John could still do as the person who runs the site.

## How the developer could cheat you

John built this site and runs the server. Nothing above stops everything he
could do, so here is the whole list, plainly. He doesn't do any of it, but
you are taking his word for that, the same as trusting a friend not to peek
when they deal at a home game.

- **See every card during a hand.** The deck of the hand being played, with
  everyone's hole cards and the cards still to come, is in the server's
  memory and database. Anyone who controls the server can read it, and no
  check on this page would show it. This is the biggest one, and every online
  poker site has it.
- **Run code that isn't the code on GitHub.** The code is public, but you can't
  confirm the live site runs exactly that code: John can put any version
  live. A changed server could send cards to him or a friend, let a practice
  bot see them, or make a coach tip use them. Your browser's seed check is
  also code the site sends you, so a changed site could switch it off or
  quietly send a seed the server chose; then the server could pick the deck, and "Check this hand", or even
  the proof file run through your own copy of `scripts/verify-hand.mjs`, would
  still pass. Since 26 October 2026 a normal release can be checked: GitHub
  builds it from the public code and signs a record of which commit it came
  from, and GitHub's watcher checks that the live machine runs exactly
  that image (see [Checking John](#checking-john)). It also checks the
  machine's start command, its environment variables against `fly.toml` and
  the names of its secrets, since a setting like `NODE_OPTIONS` could make the
  same image run other code. That catches a quiet redeploy or settings change
  that is still in place when the watcher next looks, which can be hours
  later; one undone before then shows only as restarts in Fly's list of
  machine events, which keeps only recent events.
  It can't see the values of secrets, only a fingerprint of each, and it
  doesn't catch changes made from a shell on the running server,
  which John can open: he could change the code there, or read its memory,
  without a new deploy, and nothing records that.
- **Throw away a deck it doesn't like.** The server knows the deck the moment
  the last seed is in. It could drop that commitment, publish a new one,
  collect fresh seeds and try again. Since 26 October 2026 your browser watches
  for this while it shows you the table live (seated, or watching with no
  delay): it remembers each commitment offered for the next hand and checks the
  hands actually dealt against them. If a commitment is skipped, a hand comes
  from a commitment never offered or is shown without one, or a hand number
  reappears with a different commitment while you stay connected, that hand
  and every later one you see there are marked. Seated players get the warning live; anyone who watched
  gets it in "Check this hand". "Check this hand", opened from the table's hand
  list, also checks that the hand's record carries the commitment the hand was
  shown under at the table, and the first commitment a hand number was shown
  under is never replaced, so a server can't show you one commitment and
  record another. What it doesn't cover: a server restart honestly starts a
  fresh commitment and drops every connection, so the watch starts over
  whenever your connection drops and comes back. A server that drops the
  connection on purpose just as a hand is dealt can deal that hand from any
  deck it likes, without the players' seeds; you'd notice a brief
  "reconnecting", and "Check this hand" would list no seeds for it. A server
  could also leave a hand you watched out of the hand list, or file it under
  another number, so there's nothing to compare. The watch also starts over when you leave or reload the
  page, or when a view that hid the hands (a delayed spectator, or watching
  turned off) turns live, so a server could get a retry by showing you that
  way for a moment. It is blind if nobody at the table is watching, or if
  browser storage is blocked. It also relies on the browser code being the
  published code (above).
- **Change the records.** Chip counts, the cash ledger, the leaderboard and
  hand histories live in a database he controls, and he could edit them.
  Since 26 October 2026 every hand, every change to a player's buy-ins and
  cash-outs, every admin action that changes something, and every chat read
  from the admin page also goes into a public, hash-chained
  record, and GitHub copies it every few hours. Editing something already in the
  record now shows: in "Check this hand", in the ledger's check against the
  record, in a warning from any browser that saw the record before, and in
  the GitHub copy. What it doesn't stop: a false entry written at the time
  (say, a changed server recording a wrong hand as it happens; you'd see the
  hand play out differently), an edit in the hours before GitHub next copies
  it that no browser saw, and the leaderboard, which is worked out from hands
  and isn't checked separately. If amounts matter, keep your own tally too.
- **Read table chat.** Since November 2026 (issue #300) the admin page can
  read any table's chat, cash or tournament, while it is open or long after it
  has closed. That includes everything said at the table, by players and
  spectators. Each read from the admin page goes in the public record and on
  [/transparency](/transparency) as "Chat read". The entry holds only the
  table's (or tournament's) fingerprint, the same one its hands use, so
  anyone with the table's link can tell it was their table, and nobody else
  can tell which table it was. Other ways John can see chat leave no "Chat
  read" entry: reading the database or a backup, a shell on the server, or
  sitting at or watching the table. He could always read chat in the
  database; the admin page makes it easy, so that way is recorded. Lobby chat is open to anyone with the tournament's
  link anyway. Don't say anything at a table you wouldn't want John to read.
- **Use admin powers, or a shell on the server.** The admin page can remove
  test tables, answer suggestions and read table chat; each use now goes in the public record
  and on [/transparency](/transparency). Looking is not recorded: the admin
  page can list tables and who is at them without leaving an entry, and the
  game-night recap John gets (errors, restarts, how much was played; see
  [Privacy](/privacy)) isn't recorded either. It holds no chat, cards or chip
  counts. Once a
  day (lately around midday in New York, since GitHub starts the job hours
  after its 5 am slot) GitHub downloads a backup of the whole database with the admin key,
  locked with a key only John holds. It includes any hand being played at that
  moment, cards and all, so John could open it and look; each download goes in
  the public record, so you can see when one was taken. John can also open a shell on the
  server through Fly, the hosting company. That isn't recorded anywhere
  players can see, and from there everything in this list is possible.
- **Show your cards to a spectator without the warnings.** A host can let
  spectators see every hole card, and the site makes sure everyone is told
  (see the next section). Those warnings are code too: a changed server could
  send the cards to someone watching, or to any browser, without them.
- **Nobody independent has checked this.** The code was written with an AI
  assistant (Claude), and the reviews mentioned below were also done by AI
  reviewers we ran ourselves. No outside auditor or security firm has looked
  at it.

## Checking John

These checks run outside John's server, mostly on GitHub, so a changed server
can't also change what they found. They are independent of the server, not of
John: he owns the GitHub repository and the Fly account, so he could switch
them off or rewrite the `transparency` branch. Not quietly, though: the code
and its history are public, a check that stops running stops updating its
public log, and anyone can keep a copy John can't touch by cloning or forking
the repository (and pulling the `transparency` branch now and then).

- **Signed builds.** Every release is built by GitHub Actions from the public
  code on `main` (`.github/workflows/deploy.yml`). GitHub signs a record of the
  image and the commit it came from (build provenance), and Fly runs that
  exact image. The site's footer shows the commit the server says it runs.
  Since 5 November 2026 a GitHub rule protects `main`: its history can't be
  rewritten, the branch can't be deleted, and changes reach it only through a
  pull request whose tests pass. John owns the repository, so he could switch
  that rule off. That's why the watcher also checks that the commit an image
  was built from is still on `main`.
- **The deploy watcher.** Right after each release GitHub deploys (since 1
  November 2026), and on a schedule set to every hour, GitHub asks Fly which
  image the live machine runs, its settings and secret names, and the starts and stops Fly
  reports, checks GitHub's signed record of that image, and writes the result
  to the
  [`transparency` branch](https://github.com/jcolter11374/rsdp-poker-live/tree/transparency/deploys)
  (`.github/workflows/transparency.yml`). An image GitHub didn't build from
  `main`, a second machine, a server that names a different commit, a
  replaced start command, an environment variable `fly.toml` doesn't set, or
  a secret the code doesn't use, extra containers, a start command replaced
  in the machine's settings, settings that change without a new image, or a
  build from a commit no longer on `main` opens an issue on GitHub, which
  notifies everyone watching the repository. A secret that changes is noted
  in the log (by a fingerprint keyed with a secret only GitHub has, so it
  can't be used to guess the secret). GitHub starts scheduled jobs late, by
  hours: the schedule has run every 3 to 8 hours rather than every hour. So a
  release made any other way than through GitHub, say from John's own
  computer, is only seen at the next scheduled run. If the watcher can't
  reach the site, Fly or GitHub, it tries again on its next run, and opens an
  issue on its first run after a check has gone 12 hours without managing to
  run (with GitHub's delays, up to about 20 hours), since switching a check
  off would look the same. It skips the deploy check while a deploy is running. Restarts are logged too; one after each
  release is normal. Fly keeps only its recent events, so a burst of restarts
  between two checks may show only in part.
- **The public record.** Every hand, every change to a player's buy-ins and
  cash-outs, every table deleted, every admin action that changes something,
  every chat read from the admin page, and every server start is
  an entry in an append-only chain (`packages/engine/src/audit.ts`). Each entry
  includes a fingerprint (SHA-256) of the one before, so changing or removing
  an old entry changes every fingerprint after it. Entries hold no names and
  no table links: a table or player appears only as a fingerprint that
  someone at that table can work out. A hand's entry is the fingerprint of the
  whole hand as "Check this hand" sees it once revealed (a hand shown after it
  ends is recorded again). It includes the hand's secret server seed, so it
  can't be used to work out folded cards while the hand is still sealed. Anyone can read the record at `/api/audit/entries`.
  Privacy: the record names nobody, but anyone with a table's link can find
  that table's entries and see each player's buy-ins and cash-outs there,
  without names, and anyone can see when hands were played.
- **GitHub's copy of the record.** Each time the watcher runs, it reads the whole
  record again, checks every entry it ever copied is still there unchanged
  and that the chain is unbroken, and copies the new entries to the
  `transparency` branch. If an entry it already copied is changed or gone, it
  opens an issue, keeps the old copy aside in the branch, and starts copying
  the record as it is now. The issue stays open until someone closes it, and
  closing it is public too.
- **Your browser's checks.** Your browser remembers the latest entry it saw
  and checks, on each visit, that the record still holds it unchanged and
  that everything since follows on; it does the same against GitHub's copy.
  If not, every page shows a warning. "Check this hand" checks a revealed hand
  against its entry, and marks a hand that is missing while hands before and
  after it are recorded (an honest server only does that if it crashed just
  as the hand finished). The ledger checks every buy-in and cash-out against
  the record, and says so if a player's totals were found changed when a
  closed table was opened again. Those two compare with the record as the
  site shows it now; it's GitHub's regular check of the whole record that shows
  whether those entries were edited since they were copied. These checks are
  code the site sends you, so they are only as honest as that code; GitHub's
  copy is the one that doesn't depend on it.

To check it all yourself, with Node 20 or later:

```sh
git clone https://github.com/jcolter11374/rsdp-poker-live && cd rsdp-poker-live
git clone -b transparency https://github.com/jcolter11374/rsdp-poker-live copy
node scripts/verify-audit.mjs --copy copy --proof hand-12-proof.json
```

It uses Node's own SHA-256 and nothing from the app. To be told when a check
fails, press **Watch** on the repository's GitHub page (custom: Issues).

What these checks can't do:

- They can't show what happens inside the running server: a shell on it,
  reading the live deck from memory, or code changed in place.
- They see secrets only as names and fingerprints, so they show that a
  secret changed, not what it says.
- A wrong entry written at the time looks like any other entry. The record
  shows later edits, not lies told on the spot.
- An edit made before GitHub's next copy, that no browser saw, isn't caught.
- The server saves each entry before showing it, but a hosting failure that
  loses the last few writes would make it reuse their numbers. Browsers and
  the watcher would report that as a changed record, as they should.
- If the database were lost, the record would start again from entry 1, and
  the watcher would report it as a problem. That is the right call; John would
  owe everyone an explanation.

## What a table's host can do

The host of a table (and any co-host they name) runs the game, but the site
doesn't let them see your cards, and changes to what anyone can see are never
silent.

- **The host never sees hole cards.** Seated, they see their own cards like
  everyone else. Not seated, they see the table live but with every hole card
  face down.
- **Every settings change is announced in the table log**, with its own line
  for anything about what people can see or who can talk: the spectator delay,
  spectator chat, rabbit hunting, showing hands at showdown and who sees the
  rake.
- **Host actions on players are logged too**: changing a stack, moving or
  removing a player, muting someone in chat.

**Spectators seeing every card is the one way a host can open hands up.** It
is meant for coaching or streaming. While it's on, someone watching could pass
your cards to a player at the table, so the site makes it hard to miss:

- It can only be turned on between hands, and only hands dealt after that are
  shown. A hand already played, mucked cards included, stays hidden.
- Turning it on is posted in the table log and in chat, and every seated
  player gets a warning they have to dismiss.
- While it's on, the table has a red rail and a line saying how far behind
  spectators watch and how many are watching. The invite link's preview says
  so too, and nobody can sit down without ticking that they agree.
- Turning it on suggests a two-minute delay, but the host can set it to none.
  The warnings always say which.
- Turning it off works at once, even in the middle of a hand.

## HUDs and tracking software

A HUD is a program (PokerTracker, Holdem Manager and the like) that reads hand
histories as you play and puts numbers on every opponent, such as how often
they play a hand or raise. We don't want those running at our tables, but
going over your own hands afterwards is welcome. So:

- **While the game is running and you're in a seat, the hand-history
  downloads are switched off:** the tracker file (OHH), the hands as text or
  JSON, and the full log. They come back as soon as you leave your seat or
  the host stops the game (in a tournament: once you're out, or the event
  ends). The money ledger (CSV) is always available. A practice table where
  you've only played against bots keeps them open, since a HUD on bots costs
  nobody anything.
- Someone watching who hasn't played at the table doesn't get the download
  buttons either until the game stops. The host and co-hosts do while
  they're not seated.
- **The table's own Stats tab stays on.** It shows everyone's VPIP and PFR
  to everyone at the table, so it works like a small HUD, but one every
  player has, so nobody gets an edge from it.
- **Replays and the Hands tab work the whole time.** Nothing the site sends
  gets ahead of the table: each finished hand is sent only once it's over, and
  only as you saw it.

What this can't stop, stated plainly: switching off the downloads removes the
buttons, not the hands. Every finished hand still reaches your browser (as you
saw it) so replays, hand search and the Stats tab work, and someone who can
program could write a script to collect them, from their own seat or a second
device, and feed a HUD. Someone could also stand up, download and sit back
down, read the screen, or jot notes by hand. So this keeps ordinary tracking
software out of the game and makes a live HUD clearly against the rules, but
it isn't a lock a determined programmer can't get around. If you think someone
is doing it, tell the host.

## How a hand is dealt (rsdp-fair-v1)

1. The table keeps a secret `serverSeed` for the next hand: 32 bytes from the
   server's CSPRNG (`crypto.getRandomValues`), as 64 hex characters.
2. It publishes `commit = SHA-256(serverSeed)` (of the hex text) in every table
   view as `fair.nextCommit`.
3. Each seated player's browser answers with `fair:seed {commit, seed}`, a
   fresh 16-byte random hex seed. The server only accepts it against the
   commitment currently published, so a seed is always chosen *after* the
   server's secret was fixed. One seed per player; a later one replaces it.
4. When the hand starts, the server takes the seeds of the players dealt in and
   computes
   `handSeed = SHA-256("rsdp-fair-v1|" + serverSeed + "|" + sortedClientSeeds.join(","))`.
   Nothing else goes in, so the server has no free input to vary. The hand's
   commitment and seeds are in every player's view (`hand.fair`), and a new
   secret is committed for the following hand straight away. After a restart
   the table commits to a fresh secret, so a deal lost in a crash is never
   dealt again.
5. The deck is a Fisher-Yates shuffle of `2c 2d 2h 2s 3c … As` (ranks
   `23456789TJQKA`, suits `cdhs`), going from the last card to the first, with
   `j = rng(i + 1)`. `rng(n)` reads SHA-256(`handSeed|deck|0`),
   SHA-256(`handSeed|deck|1`), … as big-endian 32-bit words and rejects any
   word at or above `floor(2^32 / n) * n`, so every outcome is exactly equally
   likely.
6. Cards are dealt from the top of the deck in order, with no burn cards:
   hole cards one at a time around the table starting left of the button, then
   the board. Run it twice, double board, bomb pots, stud's shared seventh-street
   card and rabbit hunting all use the next cards of the same deck. Each deal,
   board and draw event records `pos`, the deck place of each card.
7. Draw games: when the stub runs out, its last card and the muck (earlier
   discards and folded hands, in the order they went there) are reshuffled
   with the same method, using the label `reshuffle:<deck place>`. The checker
   replays this too.

Once a hand is revealed, its record carries every event with every card, so
the checker can deal it again. Shared hand links never carry the seeds.

The code: [`packages/engine/src/fairness.ts`](../packages/engine/src/fairness.ts)
(the scheme, a dependency-free SHA-256, and `verifyHand`), the runtime's
"provably fair dealing" section in
[`apps/server/src/runtime/table.ts`](../apps/server/src/runtime/table.ts), and
[`scripts/verify-hand.mjs`](../scripts/verify-hand.mjs). The tests check our
SHA-256 against OpenSSL on every input length from 0 to 300 bytes, pin the
deck for a known seed (so old hands stay checkable), and deal up to 3,000
random hands spread across every game, reshuffles included, then check each one with both
checkers. They also check that a swapped card, cards handed out of turn, a
shown card nobody was dealt, a seed listed twice, and in the script a seed
listed for a practice bot, for someone not dealt in, or twice for one player
are all caught.

### Checking a hand by hand

With a copy of the code (`git clone https://github.com/jcolter11374/rsdp-poker-live`)
and Node 20 or later, take the file from **Download proof** and run:

```sh
printf %s <serverSeed> | sha256sum        # must equal the commitment
node scripts/verify-hand.mjs hand-12-proof.json
```

## What this proves, and what it doesn't

It proves the deck for each hand was fixed before anyone acted, came from a
fair shuffle of seeds no single person controlled, and that every card you saw
came from its place in that deck. It rules out a rigged shuffle, a card
swapped mid-hand, and "dealing seconds" (skipping a card to give someone a
better one).

Limits, stated plainly:

- A dishonest server could list a made-up seed under a player's name, or drop
  a real one, to steer the deck. Each browser checks its own entry, live and
  in "Check this hand". The server never deals sooner than 2.5 seconds after
  showing a hand's commitment, and browsers send their seed the moment they
  see it (normally one per commitment: a browser's other tabs, or the page
  after a reload, send the same one again). If a
  seated player's browser is connected but its seed hasn't arrived yet (a slow
  or stalled connection), the server waits for it, up to 10 seconds after the
  commitment appeared; so a player whose page stops sending seeds can slow
  quick hands down to one every 10 seconds or so. A browser warns if a seed it never sent is listed under its name; if
  its seed was left out although sent more than 1.5 seconds before the deal
  (whatever the server answered: an honest server only turns down a seed that
  arrived after the deal); if its seed was left out of a hand dealt less than
  2 seconds after it saw the commitment appear; and if the server uses a seed
  it said it turned down. It also warns about extra seeds no one else would
  check: more than one under its name, one under a practice bot, one under
  someone who wasn't dealt in (once it has seen everyone who was), and the
  same seed listed twice. The browser only knows when a commitment appeared if
  it was already showing that table, seated or watching, on the same
  connection, and kept running. One that opens the table (including when a
  tournament moves you), reconnects, or wakes from a frozen tab or a sleeping
  device with a commitment already up can't tell how long it was up, so it
  doesn't warn about that hand being dealt too soon; a tab left in the
  background for a long time, which browsers slow right down, mostly skips
  this check too. A server could cause a reconnect or a tournament move to hide
  a last-moment commitment; you might only see a brief "Reconnecting" notice,
  or the page switching tables. So this is caught
  unless the affected player never looks (say they left right after the hand,
  or play with browser storage blocked), opened the table, reconnected or woke
  the page just before a deal, or sat down in the last moment before a deal.
  "Check this hand" also lists who sent no seed.
- A server could also replace a published commitment without dealing from
  it, to try another deck. A browser showing the table live marks the hands
  dealt after that, unless its watch started over in between: after a dropped
  connection (a restart honestly starts a fresh commitment), a reload, or a
  moment in a view that hid the hands. "Check this hand" also flags a hand
  recorded under a different commitment from the one shown at the table; an
  honest server only does that if it crashed before saving a deal and dealt
  that hand number again. A connection dropped just as a hand is dealt lets a
  server deal that hand without the players' seeds; it then lists none.
- The checker trusts the server's account of the betting. It doesn't
  re-evaluate who won each pot; everyone sees that live.
- Nothing can stop someone who runs the server from *reading* the deck of a
  live hand out of the server's memory or database. Every online poker site
  has this limit; only the operator can do it, and the code never exposes it.
- None of this stops players from sharing their cards with each other off the
  table.

## Audit findings (2026-10-25)

| Area | Finding | Status |
|---|---|---|
| Main shuffle | Fisher-Yates over `crypto.getRandomValues` with rejection sampling: sound. | Replaced by the seeded scheme above, which is equally strong and checkable. |
| Draw-game reshuffle | Used a non-cryptographic xorshift generator from a 31-bit seed, with a tiny modulo bias. Only about 2 billion possible reshuffles. | **Fixed**: now SHA-256 from the hand's 256-bit seed, unbiased. Hands in progress during the upgrade finish the old way. |
| Run it twice, double board, bomb pots, rabbit hunt, stud | All deal the next cards of the one pre-shuffled deck. Rabbit cards are the real next cards, shown only after the hand to whoever asks. | OK |
| Button draw, seat shuffle, bomb-pot timing | Use the CSPRNG. | OK |
| Tournament seat draw | A fast non-cryptographic generator (mulberry32) from a secret 32-bit CSPRNG seed that stays on the server. Seats only, never cards. | Acceptable; could move to the seeded scheme later. |
| All-in equity | Computed in the browser from cards already visible; its seeded sampling only affects the displayed percentages. | OK |
| Coach tips | Worked out on the server only for the one person dealt into a hand where everyone else is a practice bot, at a cash table where people have never played each other, never in tournaments, from a copy of the hand holding only what that person can see: no deck, no other hole cards, no muck, no seeds (`seenBy()` in apps/server/src/bots/strategy.ts). Sent only to them and never saved. Tests swap every card they can't see and check the tip doesn't change. | OK |
| `Math.random` | Only in the sound effects. | OK |
| What clients receive | Hole cards are filtered per viewer on the server (`visibleEvents`, the table view); undealt cards, the deck, and the seeds never go out during play. Hand history drops the deck. Tests check that no secret appears in any player's or spectator's view. Practice bots' explanations stay on the server until the hand ends, then go only to the one person in that hand; they hold numbers, never cards, and sit outside the hand's fingerprint. | OK |
| After a restart | The deck, the next hand's secret and its commitment live in the server's saved table, never in anything sent to browsers. A restart throws away the unused next-hand secret and commits to a fresh one, so a deal lost in a crash is never dealt again. | OK |
| Host setting "Spectators see every hole card" | With no delay, anyone with the table link sees all hole cards live and could relay them. The host is warned and seated players see a banner. | Use it with a spectator delay. |
| Practice bots | They decide from their own cards and cards dealt face up only (`situation()` in apps/server/src/bots/strategy.ts), never other hole cards or the deck. Their own random choices don't touch the deck. Their explanations are their own account of those numbers: nobody can check them. | OK |
| Separate review of this scheme (a second AI code reviewer we ran ourselves, not an outside auditor) | Found that the first checker only verified that each card's recorded place was used once, so a server could have handed places to the wrong players; that the list of seeds and the hand id were not bound to anything; that shown cards and draw-game reshuffles were not checked; that a "hide my cards" share link would carry the seeds; and that a crash could re-deal a deck. | **All fixed** as described above, each with a test. A second review then found that a server could still drop or invent seeds, and that the checker compared the server's revealed record with nothing players saw live: both closed with the browser's own records above. |

## Statistical tests

[`npx tsx scripts/fairness/stats.ts 2000000`](../scripts/fairness/stats.ts) shuffles two million decks with the
seeded scheme that deals every hand now, and two million with the direct
CSPRNG shuffle (what dealt hands before this change, and still shuffles seats),
and compares them with the exact theory. A p-value is the chance of seeing a deviation that large from a
perfect shuffle; values spread evenly between 0 and 1 are what a fair shuffle
produces, and only values below 0.0001 would be a red flag.

Results of 25 October 2026:

| Test | What was measured | Statistic | p-value |
|---|---|---|---|
| Direct CSPRNG shuffle: Card x position | Each of 52 cards at each of 52 positions, 2,000,000 decks (386s) | chi2=2526.0 df=2601 | 0.8511 |
| Direct CSPRNG shuffle: Five-card hands | high card 50.0491% (theory 50.1177%); one pair 42.2977% (theory 42.2569%); two pair 4.7686% (theory 4.7539%); three of a kind 2.1205% (theory 2.1128%); straight 0.3937% (theory 0.3925%); flush 0.1969% (theory 0.1965%); full house 0.1445% (theory 0.1441%); four of a kind 0.0271% (theory 0.0240%); straight flush 0.0017% (theory 0.0015%) | chi2=12.65 df=8 | 0.1245 |
| Direct CSPRNG shuffle: Pocket pairs | 5.8632% vs theory 5.8824% (first two cards) | chi2=1.33 df=1 | 0.2497 |
| Direct CSPRNG shuffle: Suited starting hands | 23.6057% vs theory 23.5294% (first two cards) | chi2=6.46 df=1 | 0.0110 |
| Direct CSPRNG shuffle: Neighbours same suit | 23.5363% vs theory 23.5294% (every adjacent pair of cards) | chi2=2.66 df=1 | 0.1029 |
| Direct CSPRNG shuffle: Neighbours same rank | 5.8871% vs theory 5.8824% (every adjacent pair of cards) | chi2=4.22 df=1 | 0.0400 |
| Direct CSPRNG shuffle: Deck to next deck | Top card of one deck against the top card of the next | chi2=2617.9 df=2703 | 0.8770 |
| Direct CSPRNG shuffle: All 24 orders of 4 cards | 24 of 24 orders seen, 2,000,000 shuffles | chi2=23.0 df=23 | 0.4604 |
| Direct CSPRNG shuffle: All 120 orders of 5 cards | 120 of 120 orders seen, 2,000,000 shuffles | chi2=106.0 df=119 | 0.7965 |
| Seeded deck (rsdp-fair-v1): Card x position | Each of 52 cards at each of 52 positions, 2,000,000 decks (296s) | chi2=2587.1 df=2601 | 0.5727 |
| Seeded deck (rsdp-fair-v1): Five-card hands | high card 50.1208% (theory 50.1177%); one pair 42.2274% (theory 42.2569%); two pair 4.7755% (theory 4.7539%); three of a kind 2.1208% (theory 2.1128%); straight 0.3927% (theory 0.3925%); flush 0.1948% (theory 0.1965%); full house 0.1414% (theory 0.1441%); four of a kind 0.0251% (theory 0.0240%); straight flush 0.0016% (theory 0.0015%) | chi2=5.29 df=8 | 0.7264 |
| Seeded deck (rsdp-fair-v1): Pocket pairs | 5.8982% vs theory 5.8824% (first two cards) | chi2=0.90 df=1 | 0.3424 |
| Seeded deck (rsdp-fair-v1): Suited starting hands | 23.5009% vs theory 23.5294% (first two cards) | chi2=0.90 df=1 | 0.3427 |
| Seeded deck (rsdp-fair-v1): Neighbours same suit | 23.5273% vs theory 23.5294% (every adjacent pair of cards) | chi2=0.25 df=1 | 0.6181 |
| Seeded deck (rsdp-fair-v1): Neighbours same rank | 5.8835% vs theory 5.8824% (every adjacent pair of cards) | chi2=0.24 df=1 | 0.6257 |
| Seeded deck (rsdp-fair-v1): Deck to next deck | Top card of one deck against the top card of the next | chi2=2805.1 df=2703 | 0.0838 |
| Seeded deck (rsdp-fair-v1): All 24 orders of 4 cards | 24 of 24 orders seen, 2,000,000 shuffles | chi2=34.5 df=23 | 0.0589 |
| Seeded deck (rsdp-fair-v1): All 120 orders of 5 cards | 120 of 120 orders seen, 2,000,000 shuffles | chi2=161.9 df=119 | 0.0055 |

18 tests; 0 with p < 0.0001

All 18 pass. The lowest, 0.0055 for the orders of five cards from the seeded
deck, is about what you expect to see once among 18 tests; three fresh runs of
three million shuffles each came out at chi-square 115.2, 131.9 and 105.8 (119
expected), well inside the normal range.
