# Changelog

Every release of RSDP Poker Live!, newest first.

<!-- Made by `npm run changelog` from apps/web/src/roadmap/changelog.json and whatsnew.json. Edit those, not this file. -->
This file is made from [`changelog.json`](apps/web/src/roadmap/changelog.json) and
[`whatsnew.json`](apps/web/src/roadmap/whatsnew.json), the same data as the site's
[Changelog](https://rsdp-poker-live.fly.dev/changelog) and [What's new](https://rsdp-poker-live.fly.dev/whats-new) pages, so they can't
say different things. Don't edit it by hand: change the JSON and run `npm run changelog`.
The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are dates ([calendar versioning](https://calver.org/)): `2026.11.01` is the first
release on 1 November 2026 and `2026.11.01.2` the second that day. Each version has a git
tag (`v2026.11.01`) and a [GitHub release](https://github.com/jcolter11374/rsdp-poker-live/releases) that also lists the issues it
closed. Releases before 1 November 2026 weren't tagged, so they are listed by date.

On `main`, every entry here is live. On `develop`, the top entry may be the next release,
still being filled in: its tag and GitHub release only exist once it goes live. Work that is
merged but not live yet is also on the issues labelled [status: on develop](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+on+develop%22).

## [2026.11.01.9] - 2026-11-01

### Fixed and changed

- If the next event in a repeating series or Sit & Go can't be made, its lobby now still says why after a server restart, and the server tries again as soon as the host fixes the settings.
- Tournament settings now drop stray extra fields instead of saving them, and refuse prize amounts over $100,000 and payout tables that run past 10,000 entries.
- Fixed a rare mix-up where a player could be taken for a practice bot, leaving their real games off the leaderboard and their profile.
- Behind the scenes: the automatic browser test now stops its practice table when it finishes. Nothing changes at the tables.

## [2026.11.01.8] - 2026-11-01

### Fixed and changed

- In the tournament structure editor, a typed small blind, big blind or ante now stops at the site's maximum chip amount instead of letting you enter a value that can't be saved.
- Tournament payout tables now have a size limit: up to 150 ranges, each paying up to 200 places. A tournament whose settings would be too big to save as a structure is now refused when you make it, not later when you try to save it. If an existing repeating series or Sit & Go has a payout table over the limit, its lobby now says why its next event couldn't be made.
- Fair dealing: the "Download proof" file now says whose each seed is and who was dealt in, so the standalone checker script can also catch a seed listed for a practice bot, for someone who wasn't dealt in, or twice for one player.
- Hand search no longer shows a robot badge on a real player whose account id happens to look like a bot's.
- Behind the scenes: our automated tests now replay tournaments exactly and clean up after themselves. Nothing changes at the tables.

## [2026.11.01.7] - 2026-11-01

### Fixed and changed

- Cash games: the betting buttons now stay locked until your move is answered or the turn moves on, so a chat message or someone sitting down can no longer unlock them early and let a second tap through.
- Cash games: if the host sets the stack of a player who ran out of chips, that player is now dealt back in, just as after a rebuy, instead of staying stuck as out of chips.
- Fair dealing: your browser now warns about extra seeds no one else would check (more than one under your name, one under a practice bot or someone not dealt in, or the same seed twice), and "Check this hand" and the proof checker catch them too.
- Tournament structures: "+ Add level" now stops at the most the site allows (100 levels), and new levels' blinds and ante stop at the maximum chip amount.
- Saving a tournament structure or table preset without signing in now applies the same size and count limits as an account, so what you save can be brought over when you sign in.
- Behind the scenes: our automated tests now deal more varied hands and fail less often on a busy machine. Nothing changes at the tables.

## [2026.11.01.6] - 2026-11-01

### Fixed and changed

- Fixed a security problem.

## [2026.11.01.5] - 2026-11-01

### Fixed and changed

- Cash games: if the server crashed just as a hand ended, that hand could come back unfinished and be played again after the restart; it now stays finished with the result it had.
- Cash games: a run-it-twice vote that arrives very late on a slow connection no longer counts toward the next hand's vote.
- At a table, Sit out, I'm back, straddle and wait for the big blind now show a message if the server says no or the connection drops, and I'm back no longer shows when you have no chips to sit back in with.
- If you're sitting at a table, waiting for a seat, or entered in a tournament as a guest, signing in to an account you made on another device now asks you to leave first and links you to that table or tournament, instead of quietly leaving your seat or entry behind.
- Stud and Razz: if the player who must bring in is all in from the ante, the next player no longer has a bring-in posted for them when they are away or out of time (they fold instead), and practice bots that open in that spot explain it correctly.
- Tournaments: when a tournament ends, its last table just shows the winner, with no countdown to a next hand that never comes.
- How to play: the time bank and rabbit hunt guides now explain that tournaments set their own clock, time bank and rabbit hunting, and at a table the time bank example uses that table's own numbers.
- “Download full log” now includes every chat message and table event since the table started, not just the most recent ones. For tables played before this update, it has whatever had not already dropped off.
- Table settings: “Add game” and “Add level” now stop at the most the site allows (20 games, 100 levels), and new blind levels stop at the maximum chip amount.
- Saved table setups and tournament structures count each emoji in the name as two characters, the same as the name box, so a long name gets a clear “names can be up to 60 characters” message instead of a confusing “Invalid preset” error.
- Signing in with many large setups saved in your browser no longer drops the connection: they come over to your account in smaller steps.
- The Roadmap page is up to date again.
- Behind the scenes: more automatic tests, including the betting bar, a nightly run of the long game simulations, and a rehearsal of each release's upgrade on saved data.

## [2026.11.01.4] - 2026-11-01

### Fixed and changed

- The site's own code is now open source under the MIT license, so anyone may use, copy or change it. The Credits page says so.
- At the table: if your connection is slow and you tap again, a tap that reaches the table after its turn is over is now refused instead of being played on the next street.
- If something breaks on a page, you now see a short “Something broke” note with a Reload button instead of a blank screen. At a table, only the chat or the side panel goes if that is what broke. The page also sends the server a short note of what broke for its log, without your IP address or who you are (see the privacy page).
- Behind the scenes: updated the libraries that store the site's data and check settings and account details, fixing two published security warnings. The same settings are accepted and refused as before. New automatic checks help catch a database update being skipped or losing saved data before it goes live.

## [2026.11.01.3] - 2026-11-01

### Fixed and changed

- Checking John and Fair dealing: the pages now say plainly that GitHub's checks run right after each release GitHub deploys and otherwise every few hours, not every hour as they claimed (GitHub starts its scheduled jobs hours late). Checking John no longer wrongly says the checks have stopped whenever the last one is over three hours old. The privacy page now says the backup runs once a day, not every night.

## [2026.11.01.2] - 2026-11-01

_Tournament clock rules on show_

### New

- **See the clock before you sit down.** A tournament's page now shows its table rules: the heading says how long you get to act, and the Structure tab spells out the time bank, rabbit hunting and straddles (always off in tournaments). A host can also change these rules from the Host tab until the first table opens, so a repeating tournament set up before the RSDP rules arrived can switch to them with one button. Later events in that series keep the new rules. (Suggested by John.)

### Fixed and changed

- Tournaments: a host can change the clock, time bank and rabbit hunting from the lobby's Host tab until the first table opens. Before, an event made before the RSDP table rules (31 Oct) was stuck on a 30-second clock with rabbit hunting, and so was every later event in its series.
- Tournaments: copying an event made before 31 Oct, or loading a setup saved before then, now fills in the RSDP table rules instead of the old 30-second clock with rabbit hunting.
- Tournaments: the lobby shows the table rules to everyone.
- Everywhere: if your connection drops just after you press a button (a phone losing signal, or the server restarting for an update), the button no longer stays busy until you reload. You get a message to check whether it went through and try again. A button pressed while you're already offline still waits until the connection is back.
- The Changelog page shows each release's version number. It matches the release of the same name on GitHub, whose notes also list the bug reports and requests that release closed.
- Every release is now checked on the live site automatically after it goes out, and the code's outside building blocks are pinned and kept up to date.

## [2026.11.01] - 2026-11-01

### Fixed and changed

- Tournaments: a busted player who lets a rebuy offer run out (or declines it) now places by when they busted. Before, anyone who busted while they were deciding placed below them, and players busted in the same hand were no longer ordered by their starting stacks.
- Cash games: stopping the game opens every hand so far for checking once it has stayed stopped for half an hour. A host who stops and starts again sooner no longer shows everyone the earlier folded hands.

## 2026-10-31 (d)

_Review your hands, but no HUDs at the table_

### New

- **Hand downloads wait until you're done.** While the game is running and you're in a seat, the hand downloads are switched off, so nobody can run a HUD while playing. That covers the PokerTracker/Holdem Manager file, the text and JSON files and the full log. They come back as soon as you leave your seat or the host stops the game. Replays, the Hands tab, the Stats tab and the ledger CSV work the whole time, and practice tables against bots aren't affected. The Fairness page explains what this can and can't stop. (Suggested by John.)

### Fixed and changed

- Stud: the low card must bring in and can no longer fold instead. If they leave the table on that turn, the bring-in is posted for them and the next player faces it.
- Stud: a bring-in as big as the small bet (as in a 1/2 game) now counts as the opening bet, so third street can be raised. Before, the Raise button only offered to match it.
- No-limit and pot-limit: short all-ins that together make a full raise now let players who already acted raise again, as the usual tournament rules say.
- Limit: a betting round capped with three or more players stays capped when a fold leaves two.
- Tournaments: with re-entry open to the end, the last player left no longer waits forever. The event ends a minute after the last bust unless someone re-enters (or asks the host to).
- Tournaments: levels or a break added while the last level was running over now play in order, instead of being skipped.
- Tournaments: a bounty won by a player who had asked to leave during that hand is now paid to them instead of vanishing.
- Shared hand links made with Show my cards now show the sharer's cards, older links included.
- The tracker download (OHH) labels small and big blinds properly again, so PokerTracker and Holdem Manager read the blinds right.
- The leaderboard's This month and This year start at midnight where you are, not at midnight in London, so a late game on the last night of the month counts in that month.
- To keep spam out, one player or address can make up to 20 tables and 10 tournaments every 10 minutes, and keep up to 10 tournaments open at once.
- The Fairness page has a new section on HUDs and tracking software: what the site does about them, and what it can't stop.

## 2026-10-31 (c)

### Fixed and changed

- After a seat shuffle or move between hands, the player now in a seat could see the folded cards of whoever sat there in the hand just played. Everyone now sees only their own cards from that hand.
- When the server restarted mid-hand (an update or a crash), at a cash or tournament table, the player to act was folded straight away when the table came back, and a run it twice vote counted as No. Their clock now starts again in full.
- Removing a player during the run it twice vote no longer folds a hand they had already called.
- Changing the table size no longer moves the button and blinds to a random seat.
- Fixed limit: the big blind now counts as the first bet toward the cap (it allowed one raise too many before the flop and the first draw), and an all-in for less than half a bet no longer uses up the cap.
- Stud: the bring-in can no longer be skipped by calling nothing.
- A double tap on Check or Call no longer also plays your next turn.
- Tournaments: re-entries beyond the event's max players no longer wipe out the payouts, and with lots of re-entries in a small field no prize goes unpaid (the lobby's payouts list now matches).
- Tournaments: a rebuy asked for in time now waits for the host's approval instead of the player being knocked out.
- Tournaments: hand-for-hand no longer freezes at two-seat tables, and a table whose busted player is deciding on a rebuy holds the round like any other.
- Tournaments: a player moved to another table keeps what's left of their time bank.
- Tournament results count a re-entered player's earlier rebuys and add-ons.
- Tournament form: unticking Add-ons removes the break it added, and the payout table no longer shows a false error after changing Max players.
- Half an emoji in table chat (or a table name) could stop the table from being saved. It's now cleaned up.
- In rare timing (a tab closed, or moved on to another table, just as its table was loading), the player was left shown as online there. Fixed.
- Table chat is limited to 8 lines per 10 seconds per player.
- Wrong passwords when unlinking Google are now limited, like sign-in.
- Settle up no longer says the books are off at a table with a house fee; it says what the fee took.
- Stop game now warns that stopping lets everyone check every hand so far, folded cards included, and points to Pause for a break.

## 2026-10-31 (b)

_Tournament table rules_

### New

- **Our tournament clock.** A tournament now has its own table rules: the decision clock, the time bank and how often it refills, and whether rabbit hunting is allowed. New tournaments start the RSDP way: 10 seconds to act, a 20-second time bank that refills every 30 hands, and no rabbit hunting. Change them under At the tables when you make one. (Suggested by John.)

### Fixed and changed

- Tournaments have their own table rules (decision clock, time bank, rabbit hunting). New ones use the RSDP rules: 10-second clock, 20-second time bank refilled every 30 hands, no rabbit hunting. Before, tournament tables always had a 30-second clock, a 30-second time bank refilled every 10 hands, and rabbit hunting. Straddles stay off in tournaments, as before.

## 2026-10-31

_Our own tournament structure_

### New

- **Blinds the RSDP way.** A new tournament now starts on the group's own structure from PokerNow: 63,000 chips, 28 levels of 8 minutes from 100/200 up to 60,000/120,000, no antes and no breaks, with late registration through level 5. It's also the RSDP button under Start from, next to Turbo, Standard and Deep stack. (Suggested by John.)

### Fixed and changed

- New tournaments start on the group's RSDP structure (63,000 chips, 28 eight-minute levels, no antes, late registration through level 5), also offered as the RSDP starter.

## 2026-10-30 (c)

### Fixed and changed

- New tournaments show a prize pool and payouts by default ($20 buy-in, our payout table), so every tournament's buy-ins and prizes are kept with its results. Untick it for a freeroll.

## 2026-10-30 (b)

_Our own tournament payouts_

### New

- **Prizes split the RSDP way.** When you show a prize pool, a new tournament now starts with the group's own payout table from our results sheet: winner takes all up to 5 players, then one more place paid for every 5 more players, in $5 steps. At a $20 buy-in it pays exactly what the sheet does (6 players: $85 / $35, 8 players: $105 / $55). The other presets are still in the list. (Suggested by John.)

### Fixed and changed

- Tournament payouts default to the group's own RSDP payout table (rounded to $5) instead of a generic curve.

## 2026-10-30 (a)

### Fixed and changed

- No more lag during a run it twice vote: if the all-in was called with under 12 seconds left on the clock, the server got stuck re-sending the table until the vote ended, which could freeze the table (and slow others) for a few seconds.

## 2026-10-29 (f)

_A calmer, cleaner table_

### New

- **Seats stay put.** Players no longer shift round the table when your turn comes or a new hand starts. It was most noticeable on phones. (Suggested by Alon.)
- **Fewer lines on the felt.** No printed betting line, a simpler crest in the middle, and empty seats without dashed outlines. (Suggested by Alon.)
- **Chips that sound like chips.** Bets, raises and pots now make the short, dry clack of clay chips settling, instead of little rings. (Suggested by Alon.)
- **A smoother turn clock.** The clock is a thin line along the bottom of the acting player's name that glides down, red for the last few seconds.

### Fixed and changed

- Seats no longer shift round the table when your turn comes or a new hand starts, mostly noticeable on phones.
- The turn clock is a calm line along the bottom of the acting player's name that glides down, instead of a ring round it that moved in little jumps.
- A cleaner felt: no printed betting line, a simpler crest, and empty seats without dashed outlines.
- Chips sound like clay chips: short dry clacks that settle, instead of little rings.

## 2026-10-29 (e)

### Fixed and changed

- The bet slider is calmer: it stops on round amounts (quarters on small bets at .25/.50, whole dollars once the stack is deep, never 18.61) instead of moving a cent at a time, and the pot buttons round to the small blind. You can still type any amount in the box.
- Roomier table: on computers the felt is a little smaller with bigger seats and cards round it, and a bit more space round the action bar. On phones your own cards are a little bigger and players at a part-empty table spread round it instead of bunching on one side.

## 2026-10-29 (d)

### Fixed and changed

- New Credits page (link at the bottom of every page and on About): the free, open-source software the site is built on, what each piece does, and every package with its license. The license texts in full are at /third-party-licenses.txt.

## 2026-10-29 (c)

### Fixed and changed

- All-in runouts take their time: when you run it twice each card comes about 3.5 seconds apart (as on PokerNow), and a normal all-in runout 2 seconds apart. Before it was 1.3 seconds, so a turn all-in run twice showed both rivers almost at once.

## 2026-10-29 (b)

### Fixed and changed

- The turn clock round the acting player's name now runs down clockwise, like a clock hand.

## 2026-10-29 (a)

### Fixed and changed

- The Fair dealing page now opens with a plain box on what you're trusting John with, what other players can and can't do, and what the public record shows.
- New Terms of use page (link at the bottom of every page): the site is free and comes as it is, with no warranty, and John isn't liable for outages, lost records, bugs or break-ins.

## 2026-10-27 (f)

_Cash games in dollars and cents_

### New

- **Play .25/.50, or any stakes you like.** Every cash game is now played for dollars and cents. Type the blinds as money on the home page (it starts at 0.25/0.50), and stacks, bets, the pot, buy-ins, the ledger and the log all show dollars. Tournaments still use chips. (Suggested by John.)
- **Casino chips.** The chips on the felt are a casino's: pennies, nickels and quarters, then white $1, red $5, green $25, black $100 and up.
- **Your presets come along.** A preset or saved setup from before counts each old chip as a dollar, so a 1/2 game is still 1/2. Tables and records from before stay exactly as they were.

### Fixed and changed

- Log lines and buy-in messages at cash tables show dollars ("sat down with 50.25"), and a shared table link's preview shows the blinds as 0.25/0.50.

## 2026-10-27 (e)

### Fixed and changed

- The Privacy page now also says who is responsible for your data, why each thing is kept, that data is stored in the USA, your rights (see, correct, delete, object, complain), what can't be deleted and why, and how Google sign-in data is used.

## 2026-10-27 (d)

### Fixed and changed

- New Privacy page (link at the bottom of every page): what the site keeps about you, who can see it, how long it stays and how to delete it.
- Deleting your account now also removes any hand links you shared. Before, they kept working and you could no longer remove them.

## 2026-10-27 (c)

_Tidy up your practice games_

### New

- **Delete practice games.** Practice games on your profile now have a Delete button, and there's Delete all. A table you made that only you and your bots played at is erased for good. Any other practice table only leaves your profile, so their record stays. Real games can still only be hidden. The public record keeps each hand's fingerprint (no cards, no names) and notes that a practice table was deleted. (Suggested by John.)
- **A practice graph you can reset.** Your profile has a second graph, Practice vs bots, showing how you're doing against the bots. Tap Reset to start it again from zero, say when you move up a bot level. Your games stay in your list. Practice still never counts on your real graph or the leaderboard. (Suggested by John.)

## 2026-10-27 (b)

### Fixed and changed

- A page left open when a new version goes live now reloads itself into it: at a table once your hand (and any all-in runout) is over, anywhere else when you switch away or move to another page. Before, an old tab kept running the old version, so fixes like the street-at-a-time runout didn't reach it.

## 2026-10-27 (a)

### Fixed and changed

- Tournament setup now lowers seats per table as soon as you pick a game that can't deal to that many (8 for stud games, 6 for Triple Draw and Badugi) and says why, instead of refusing when you press Create.

## 2026-10-26 (m)

### Fixed and changed

- The "Seconds to act" box is gone from the home page. New cash tables start with a 30 second turn clock, and the host can change it (or turn it off with 0) in Table settings under Clock.

## 2026-10-26 (l)

### Fixed and changed

- The "Play money only. Every game and option is free." line is gone from the bottom of the home page and info pages.

## 2026-10-26 (k)

### Fixed and changed

- The pot number no longer flickers backwards for a moment when a bet goes in, and the pot keeps pace with the chips instead of lagging behind. Stacks had the same tiny flicker when chips went out.
- The chip pile in the pot grows when the swept bets land on it, rather than jumping as they leave the seats.

## 2026-10-26 (j)

_Coach tips for practice_

### New

- **Tap Tip on your turn.** In a hand where everyone else is a bot, tap Tip (or press T) on your turn for a rough guide, like "About 35% to win, the call costs 25%: call". In draw games it says which cards to throw, and in 8 or better games it gives your share of the pot. It only uses what you can see: your cards, the up cards and the board, the betting and how many cards each player drew. Tap Why? for the maths. Tips never show when another person is in the hand, or at a table where people have played each other, or in tournaments.
- **Bots say why.** After each hand, the Hands tab and the replayer show why each bot did what it did, like "Ace called: it guessed about 40% to win, and the call cost 25%". Bots guess quickly, so their numbers are rough, and they never name cards. Only you see them, and only for hands where you were the only person.

## 2026-10-26 (i)

### Fixed and changed

- Behind the scenes: the site is now backed up every night to GitHub, locked with a key only John holds, and each copy is test-restored before it's kept. A check every few minutes tells John if the site goes down. Each nightly backup shows on /transparency.

## 2026-10-26 (h)

_Checking John_

### New

- **A public record of every hand and buy-in.** Every hand, every buy-in and cash-out, every admin action and every server restart now goes into a public record where each entry is locked to the one before it, and GitHub keeps a copy every hour. Editing something after the fact now shows: Check this hand and the ledger both check themselves against the record, and your browser warns you if the record changed since you last saw it. (Suggested by John.)
- **Proof of which code the site runs.** GitHub now builds and signs every release from the public code, and checks every hour that the live site runs exactly that build. The new Checking John page (linked at the bottom of the site) shows what it found, every admin action, and what these checks still can't catch.

### Fixed and changed

- The site footer shows which build the server says it runs, linked to that code on GitHub.
- The felt colour buttons under Look and sound are full size again, with their names inside, and the colour you just picked keeps its gold border.
- On phones, the choices under Look and sound (big blinds, two or four colours, gestures) sit on one line each instead of wrapping.
- The leaderboard's colour key is back to small squares.

## 2026-10-26 (g)

_A table with some spark_

### New

- **A lit table.** A lamp over the felt, a cloth you can almost feel, a padded rail and real shadows under the cards and chips. Whoever is acting sits in a pool of light.
- **Cards and chips that move.** Cards are thrown from the dealer button, board cards turn over one by one with a snap, bets are tossed in, and stacks count up when you win. Your shot clock runs round your nameplate.
- **Big moments.** The winning five cards lift and glow, the result is a gold banner, and an all-in player goes red-hot while the cards run out.
- **Our own look.** An RSDP crest in the felt, our own card back, and bigger, clearer numbers for stacks, bets and the pot. Too much movement on a slow phone? Turn off Table motion under Look, sound and me.

### Fixed and changed

- Turning off Table motion (under Look, sound and me) stills the whole table, the older card and chip movement included, just like your device's reduce-motion setting.

## 2026-10-26 (f)

_Bot levels, better pre-moves and side games explained_

### New

- **Pick how good your practice bot is.** Choose Easy, Normal or Hard when you add a bot or start a practice game, and change it any time from the bot's popup. Easy calls a lot, bets small and never bluffs, which makes it good for learning a new game. Hard reads what your bets mean, learns how you play, uses position and bluffs. In our heads-up test matches, Hard beat Normal and Normal beat Easy in every game.
- **Pre-click your move, and change your mind.** Before your turn, tap Check / Fold, Check, Call or Call any and it plays the moment your turn comes. Tap it again to cancel. If someone bets first, Check / Fold turns into Fold, and a Check or a Call of an amount that has since been raised clears itself so you decide again. On a computer the keys work too: F, K, C and A tick a pre-move, and pressing the key again unticks it. (Suggested by John.)
- **How to play now covers the side games.** The How to play guides now explain the Nit game, the 7-2 bounty, bomb pots, double board, run it twice, straddles, rabbit hunting, the time bank, showing and mucking, the house fee and missed blinds. Each one says how it works here, walks through an example, and lists any host settings that change it. At a table, How to play shows the ones switched on there first, and the Nit game's ? button links to its full guide.
- **Your browser watches for a swapped deck.** Each hand's deck is sealed before the deal. Your browser now also warns you if the table swaps the sealed deck for the next hand for a different one without dealing it, which is one way a dishonest server could hunt for a deck it likes. The Fairness page explains how it works and what it can't catch.

### Fixed and changed

- A ticked Check / Fold no longer vanishes from view when someone bets: it shows as Fold, and you can untick it.
- In draw games, the hand log now says "stands pat (auto)" when someone stood pat because they were away or ran out of time, so it doesn't look like a choice.

## 2026-10-26 (e)

_No secret spectators_

### New

- **You're always told when spectators can see your cards.** If a host lets spectators see every hole card, everyone at the table now gets a warning in chat and on screen. While it's on, the table's rail turns red and a line says how far behind spectators watch and how many are watching. You have to agree to it before you sit down, it can only be turned on between hands, and every other settings change is now announced in the table log.

### Fixed and changed

- Turning off spectators seeing every card now works straight away, even in the middle of a hand, and spectators with a delay don't get to watch the rest of that hand face up.
- A hand dealt before spectators could see every card stays hidden from them, mucked cards included.

## 2026-10-26 (d)

_Saved tournament setups, a clearer Nit game and a changelog_

### New

- **Save your favourite tournament setups.** Save a tournament's setup under a name and load it in one tap when you make a new one. You can also save one from the lobby's Host tab, and rename or delete them any time.
- **Turbo, Standard and Deep stack starters.** Three ready-made setups that fill in the starting stack, blind levels and late registration for you.
- **Presets follow your account.** When you're signed in, your saved tournament setups and cash table presets come with you to every device. Guests keep them in their browser.
- **The Nit game explains itself.** The Nit game box under the action bar now says where the round stands: how many more players it needs, or whether you're on the nit. A ? button explains the rules, and the NIT tag on a seat shows in purple.
- **A changelog for the small stuff.** Small fixes now have their own Changelog page, linked at the bottom of the site, so What's new stays about new features and changes you'll notice.

### Fixed and changed

- When the host pauses during a hand, the turn clock now stands still on every screen. It already did behind the scenes, so nobody was ever folded for it.
- A turn paused with under five seconds left gets five seconds when play resumes.

## 2026-10-26 (c)

_Slower all-in runouts, an About page and a few tidy-ups_

### New

- **All-in runouts with some drama.** When players are all in, the board now comes out a street at a time, run 1 before run 2, with a short pause before the winner is shown. Chips going into the pot now slide over the cards and land on the pot.
- **About page.** A short page for friends who are new here: what the site is, what's free (everything) and where to start. It's linked from the menu at the top, the footer and the home page.
- **Practice stays practice.** Games with a bot, or that nobody else played, now sit in their own folded Practice games list on your profile and never count toward your results.
- **Graphs up front.** Your profit graph is now at the top of your profile. The Leaderboard now has a chart of running profit over the period for up to three people: the top three to start, or tick the ones you want to compare.
- **A heads-up on unusual games.** When you pick an unusual pairing, like No Limit Seven Card Stud, while starting a table or in table settings, a note says so and offers a one-tap switch to the usual betting. It never stops you: press Keep it to carry on.
- **A smaller straddle switch.** On a computer, Straddle and Wait for the big blind are now small chips under the action bar instead of a whole row of words.

### Fixed and changed

- The extra Play link is gone from the top menu. The logo already takes you home.
- Your profile's cash games list shows whether anyone is at each table right now.
- Quiet tables are put away after 45 minutes to keep the server quick, and open again exactly as you left them.
- The pressed Straddle chip stays green when you hover over it, and screen readers read the chips properly.
- Each person keeps the same line colour on the leaderboard chart.

## 2026-10-26 (b)

_Chat, leaderboards and your profit graph_

### New

- **Table chat you can't miss.** Chat now has its own box under the log, with one-tap replies like gg and nh. On a phone, tap the chat button at the top (it shows how many messages you've missed). New messages pop up beside the player's seat for a few seconds, and Enter jumps to the chat box.
- **Bet in big blinds.** With the Chips | BB switch on BB, you can type and bet in big blinds too. Type 3 to raise to three big blinds.
- **A steadier table.** The table keeps one size through a hand, empty seats keep clear of players, and the pot shows as one line. People, How to play, shortcuts and Look and sound now live in one Menu at the top of the table, and runs of "sat down" lines in the log fold into one.
- **Leaderboard.** See who's up this month, this year or all time on the new Leaderboard page, ranked by profit, hands played or biggest pot. Only real cash games count: practice tables with bots and tournaments are left out. Anyone with the link can see it.
- **Your profit graph.** Your profile now draws your results game by game, so you can see how your nights add up.
- **Search your hands.** Find hands you played by your cards (like AA or AKs), who you played with, the game, pot size or how it went, then replay or share them.
- **Tidy up your records.** Hide a cash table from your profile (it stays for everyone else), and hosts can delete a test table nobody really played at.
- **A cleaner front page.** A menu across the top of every page outside the tables, two big choices on the home page (start a cash game or host a tournament), tidier tournament lobby and setup screens, and simpler sign-in pages. Your profile now opens with your totals.

### Fixed and changed

- Tournament tables no longer show up in your list of cash games, on your profit graph or on the leaderboard.
- The table keeps one size through a hand instead of shrinking and growing.

## 2026-10-26 (a)

_A slicker table, co-hosts and optional accounts_

### New

- **A slicker table.** Bigger cards tucked into each player's nameplate, a clean middle with the pot above the board, and bets that sit just outside each seat. The table fills your window, so Stud fits on a laptop screen without scrolling.
- **Fuller sounds.** New, richer sounds for cards, chips and checks, and a softer marimba to tell you it's your turn.
- **Real chip colours.** Chip stacks use casino colours that scale with the blinds, so you can read a bet at a glance.
- **Play from the keyboard.** F folds, K checks and C calls, and R gets a raise ready. Each button shows its key, and "?" lists every shortcut.
- **Chips or big blinds.** Flip the Chips | BB switch at the top of the table (or press B) to see every stack and bet in big blinds.
- **Bots with names.** Each practice bot gets its own short name and robot picture, like Ace, Lucky or Ducky.
- **Co-hosts for cash tables.** Open the People list (the 👁 button, or ☰ then People on a phone) and make a friend a co-host. They can approve seats and run the game while you play.
- **Sign in on any device.** Create an account with a username and password, then sign in on your phone, laptop or tablet to play as yourself with the same name, picture and notes. Guests can still play without signing up.
- **Your history comes along.** When you create an account, everything you've played on that device stays yours. Sign in on another device and what you did there as a guest moves into your account too.
- **Your profile.** A new profile page shows your cash games with your result at each table, and your tournament finishes. Change your name, picture or password there, sign out, or delete your account.
- **Sign in with Google.** Skip the password: continue with your Google account, or link it to the account you already have from your profile.
- **Forgot your password?.** There's no email, so ask the site admin for a one-time reset code and enter it on the Forgot password page.

### Fixed and changed

- Your mood emoji stays with you when a tournament moves you to a new table.
- A hand shown after it ends now appears in the replayer.
- Bots keep their robot picture in replays, and no two bots share a name.
- Setting a new password signs you out on every other device.

## 2026-10-25 (c)

_Practice bots, a new look and fair dealing you can check_

### New

- **Practice bots.** Add a bot to any empty seat of a cash table and practice any game for free, including Stud, Razz, Triple Draw and Badugi. A player's bot needs the host's OK, like any seat.
- **A new look.** A clean, flat felt with new cards, seats with pictures, chips and buttons. On phones the seats spread out evenly and run-it-twice boards stay clear of them.
- **Fair dealing you can check.** Every deck is sealed before the deal and mixed with a random seed from each player's browser. Press "Check this hand" in the replayer to verify any hand, and read how it works on the Fairness page.
- **Roadmap and suggestions.** See what's coming next on the Roadmap page, send your own ideas, and follow what happens to them in the suggestion log.
- **Clearer game names.** Shorter game names, and hi-lo games are labelled 8 or better.

### Fixed and changed

- Fixes for players leaving while all in, tables shrinking and phones dropping out.
- The action bar no longer locks up if the server's answer gets lost.
- Empty seats keep clear of players' nameplates.

## 2026-10-25 (b)

_Tournament formats, host tools and table extras_

### New

- **Find tournaments easily.** The home page lists upcoming and running tournaments. Turn on browser alerts, chat in the lobby, and links show a proper preview in WhatsApp.
- **New tournament formats.** Bounty and progressive knockout events, invite codes, check-in, and season leaderboards that add up points across nights.
- **Tournament host tools.** Co-hosts, seat moves, custom stack approval and copying an old tournament's settings.
- **Cash game host controls.** A waitlist, seat shuffles, spectators with a delay, chat settings and saved table presets.
- **Table extras.** Avatars, emotes, stacks in big blinds, all-in odds, sounds, keep-screen-awake, and install the site on your phone like an app.
- **Better records.** Share a hand with a link, hand highlights, and full log downloads.

### Fixed and changed

- Bounty money is never lost, even when there are side pots.
- If a table delays what spectators see, the hand history is delayed too.
- Moving a player or editing a stack during a tournament no longer risks a crash.

## 2026-10-25 (a)

_RSDP Poker Live! is live_

### New

- **Every game.** Hold'em, Omaha and Omaha Hi-Lo, Seven Card Stud, Stud Hi-Lo, Razz, 2-7 Triple Draw and Badugi, with a How to play guide for each one.
- **Extras for everyone, free.** Run it twice, straddles, bomb pots, the 7-2 bounty, double board, game rotation, rabbit hunting, the time bank and the Nit game.
- **Tournaments that start on their own.** Schedule one and it starts at the set time. Sit & Gos, recurring events, late registration, rebuys, add-ons and custom payouts.
- **Ledger, replayer and stats.** Settle up after the game, replay any hand, and see your stats and notes on players.

### Fixed and changed

- A tournament ends when one player has every chip.
- Names stay in the hand log after a player leaves their seat.
- The "Connection lost" banner no longer sticks on slow phones.
- Add-ons and recurring tournaments carry on after a server restart.

[2026.11.01.9]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.9
[2026.11.01.8]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.8
[2026.11.01.7]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.7
[2026.11.01.6]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.6
[2026.11.01.5]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.5
[2026.11.01.4]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.4
[2026.11.01.3]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.3
[2026.11.01.2]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01.2
[2026.11.01]: https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v2026.11.01
