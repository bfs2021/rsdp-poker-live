# Privacy

RSDP Poker Live! is a free, non-commercial site for one group of friends. It is
run by John, who also runs the server. This page says, in plain words, what
the site keeps about you, who can see it, how long it stays and how to remove
it. It is written from what the code actually does, and the code is public on
GitHub, so anyone can check it. It is not legal advice, and nobody here is a
lawyer.

Last updated: 6 November 2026. Every change to this page is in its
[history on GitHub](https://github.com/jcolter11374/rsdp-poker-live/commits/main/docs/PRIVACY.md).

## Who is responsible

John (jcolter11374 on GitHub) runs the site on his own, as a hobby for his poker group, and
decides what it keeps. In privacy-law terms he is the "controller". There is
no company behind it. To reach him, message him directly or in the group chat.
If you don't have his details, open an issue on
[GitHub](https://github.com/jcolter11374/rsdp-poker-live/issues) (issues are
public, so don't put anything private in one, just ask him to get in touch).

## The short version

- **Nothing is sold, rented or shared for marketing.** There are no ads, no
  analytics, no trackers and no third-party scripts on the site.
- **You don't need an account.** As a guest, the site knows you only by a
  random id kept in your browser and the name you type at a table.
- **With an account** the site also keeps a username and a password (scrambled,
  never stored as typed), or the id Google gives you if you sign in with
  Google. The site never asks Google for your email address and doesn't have it.
- **Poker hands and table results are kept for good**, because the group likes
  its history, leaderboards and hand search. Deleting your account removes
  your name, picture, notes and sign-in, but the hands you played stay in the
  other players' history under the name you used at the time.
- **John can read everything in the database**, as whoever runs a server can.
  That includes table chat and private notes. He can also read any table's
  chat from the site's admin page, even after the table has closed; each time
  he does that, the [public record](/transparency) shows that a chat was read,
  with only the table's fingerprint: people with the table's link can tell it
  was theirs, nobody else can. Reading the database or a backup leaves no
  such entry. See [Fair dealing](/fairness) and
  [Checking John](/transparency) for what he can and can't do at a table.

## What the site keeps

| What | Where it comes from | Who can see it |
| --- | --- | --- |
| A random player id for your browser, and a secret that proves it's you | Made the first time you open the site | Only the site. The secret is stored only as a fingerprint (a SHA-256 hash). |
| The name you use at tables, when you were first and last seen | You type the name | Everyone at your tables, and on the leaderboard |
| Your picture | You pick one from the library or upload a small image | Everyone at your tables. The picture's address isn't secret, and browsers may keep a copy for a while. |
| Username and scrambled password | You, when you make an account | Only the site. The password is scrambled with scrypt and can't be read back. |
| Google's id for you (a long number) | Google, if you sign in with Google | Only the site. Google also shares your name, used once to make your starting username and table name. No email, no contacts, nothing else. |
| Signed-in sessions (30 days) and one-time password reset codes | Made when you sign in or John gives you a code | Only the site, stored as fingerprints |
| Hands: who was dealt in, the cards, every action, the board, who won | The game | Players at that table see what poker rules allow them to see. Shown and mucked cards follow the table's settings. |
| Table chat and the table log (joins, rebuys, seat moves, host actions, Dealer's choice picks) | You and the game | Everyone at that table, and spectators if the host allows them. At a tournament table, also the tournament's host, co-hosts and players, who can download every table's chat and log once the tournament is over. John can read any table's chat from the admin page (with the admin key), open or closed, and each such read is shown publicly on [/transparency](/transparency). |
| Tournament lobby chat and log | You and the tournament | Everyone who opens that tournament |
| Each table's ledger: buy-ins, rebuys, cash-outs | The game | Everyone at that table. Totals from real games also feed the public leaderboard and your profit graph. |
| Private notes and colour tags you keep on other players | You | Only you (and John, who can read the database) |
| Saved table presets and tournament structures | You, when signed in. Guests keep theirs in their own browser. | Only you |
| Tables you hid, practice games you deleted, when you reset your practice graph | You | Only you |
| Shared hand links | You, when you press Share on a hand | Anyone with the link, until you delete it or your account |
| Roadmap suggestions | You, with the name you type | Everyone, on the [roadmap](/roadmap) |
| Feedback you send with **Send feedback** at a table, with the name you used there, the table, its name, cash or tournament, the game, the hand number, whether you were seated, phone or desktop, and the site's version | You | Only John (with the admin key), so he can look into it, and Claude when it writes John's game-night recap (without your name, the table or its name; see below) |

## Why the site keeps it

Under European privacy law (the GDPR) every use of personal data needs a
reason. These are ours:

- **To run the games you ask for.** Seating you, dealing, chat, ledgers,
  your account and sign-in only work if the site keeps them. (The GDPR calls
  this "performance of a contract", even for a free site.)
- **Legitimate interests**, where we weigh your privacy against the reason:
  keeping hand history, chat, records and the leaderboard the group plays for
  (they are what the group comes back to, and hold nothing beyond the games
  you played);
  the public record and backups, so cheating can be spotted and the site
  survives a disaster (the record holds no names, and backups are locked);
  feedback you send, so problems can be found and fixed;
  John reading a table's chat, to read feedback left there or look into a
  complaint;
  and rate limits, to keep the site safe. You can object
  to any of these (see *Your rights*).
- Nothing is done on the basis of consent, so there is nothing to withdraw,
  except that signing in with Google is your choice. You can stop using it
  from your profile (set a password first if Google is your only way in), and
  remove the site's access on Google's side at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

You don't have to give the site anything beyond a name to sit at a table. The
site makes no automatic decisions about you beyond the game itself, and does
no profiling. No money changes hands through the site.

## The public record

To make cheating by John easy to spot, the site keeps a public, append-only
record of fingerprints of every hand, admin actions (including each chat John
reads from the admin page) and server starts, and
copies it to GitHub every few hours. It also lists each player's buy-ins and
cash-outs at each table, as amounts. It holds **no names, no cards and no
table links**: a table and each player at it appear only as fingerprints that
someone who already has the table's link can match up. See [Checking John](/transparency)
for how it works.

## Your browser

- The site keeps a few things in your browser's local storage: your guest id
  and secret, your signed-in session, your table name, settings such as
  sound, volume and alerts, players you muted, tips you've dismissed, guest
  presets, tournaments you made, and what your
  browser saw during hands (so it can check the dealing later). Clearing the
  site's data in your browser removes them, and makes you a new guest.
- The only cookie is a short one (10 minutes) set while you sign in with
  Google, to make sure the sign-in finishes in the browser that started it.
- Your browser fetches a small public file from GitHub
  (raw.githubusercontent.com) to compare the public record with GitHub's copy.
  GitHub sees that request, as it would for any page.
- When you open the leaderboard, your browser sends its time zone (such as
  America/New_York), so "This month" and "This year" start at your midnight.
  The site uses it only for that answer and doesn't save it.

## Other services involved

- **Fly.io** hosts the site and its database in the USA (Virginia). Like any web host it
  sees your IP address while you're connected. The site keeps IP addresses only in
  memory and never saves them. It uses them to slow down people guessing
  passwords or flooding the site with requests, and forgets each one within a
  few minutes of its limit's time window running out (at most about an hour).
  If you make a tournament, the address you made it from is also remembered
  while that tournament is open, so one address can't fill the home page with
  events; it is forgotten within a few minutes of the tournament ending. A
  server restart forgets them all. The server's own logs record errors, not
  visitors. They go to Fly's log service, and the site's database also keeps
  each error line for 30 days, for John's game-night recap (below).
  When something breaks on a page in your browser, the page sends the server
  a short note for those logs: the error and where in the site's code it
  happened, the kind of page (such as "a table", never its link) and which
  version of the site it was running. The server logs it without your IP
  address or who you are. The error's own text can show which kind of browser
  it came from (for example Chrome or Safari), but nothing more about it.
- **Claude (Anthropic)**, the AI assistant that builds and runs this site for
  John, reads a short recap the morning after a night with games, so John
  hears about problems without going looking. The recap holds: the server's
  error lines, when the server restarted, how many tables, hands and
  tournaments there were (with each tournament's name, entry count and start
  time), and what was sent with Send feedback (its words, kind, game, hand
  number, cash or tournament, seated or not, phone or desktop, but not your
  name, the table or its name). Error lines and feedback go with table links
  and ids removed. It holds no chat, names, IP addresses, accounts, cards or
  chip counts.
  Claude writes John a plain-English summary of it in John's private
  workspace.
- **GitHub** holds the code, the regular copy of the public record and the
  daily backups (below).
- **Google**, only if you choose to sign in with Google. Google's own privacy
  policy covers what Google does. The site asks Google only for the basic
  sign-in scopes (`openid` and `profile`), uses what it gets only to sign you
  in and set your starting name, and never shares it, sells it, uses it for
  ads or uses it to train AI. Its use of information received from Google
  APIs follows the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
  including the Limited Use requirements.

Fly.io and GitHub act as service providers ("processors"): they store and
serve the data for the site and don't use it for their own purposes.
Anthropic receives only the recap described above. Nobody else receives
anything, unless the law forces John to hand something over.

**Data leaves Europe.** If you play from the EU or UK, your data goes to the
USA, where Fly.io and GitHub keep it and Claude reads the recap. Fly.io and
GitHub publish data protection terms that cover this (such as the EU's
standard contractual clauses or the EU-US Data Privacy Framework); you can
read them on their websites. The USA's privacy laws are weaker than Europe's.

## Backups

Once a day a GitHub job takes a full copy of the database, locks it with a
key only John holds, and keeps it for 90 days so the site can be restored
after a disaster. The locked copy can't be opened without that key. Each
backup also shows up on [Checking John](/transparency).

## How long things are kept

- Hands, ledgers and table results: for as long as the site runs, so the
  history, leaderboard and hand search keep working.
- Table chat and the table log: for as long as the site runs, like the
  table's hands, so the table's full log download has all of it. They go
  when the table is deleted. Tables used to keep only their latest 200 chat
  messages and 300 log lines, so lines that had already dropped off before
  this changed are gone.
- Tournament lobby chat: for as long as the site runs.
- The server's error lines: 30 days.
- Practice tables you made and only you and bots played at: until you delete
  them from your profile.
- Feedback sent from a table: until John deletes it, and at most a year.
- Signed-in sessions: 30 days. Password reset codes: until used or expired.
  The Google sign-in cookie: 10 minutes.
- Backups: 90 days each.

## Your rights

Wherever you live, you can ask John to:

- **show you** what the site holds about you and give you a copy (your
  profile and hand search already show most of it, and each table's side
  panel lets you download its hands; for anything else, John can put
  together a copy by hand);
- **correct** something wrong;
- **delete** it (below, with what can't be deleted and why);
- **stop or limit** a use you object to, or **move** your data elsewhere.

He'll answer within a month and won't charge. If you're in the EU or UK and
unhappy with the answer, you can complain to your country's data protection
authority (in the UK, the ICO).

## Deleting your data

- **With an account:** open [your profile](/profile) and use **Delete account**.
  That removes your username, password, Google link, sessions, browser
  secrets, name, picture, notes, saved setups, hidden tables, practice graph
  reset, shared hand links and feedback you sent while signed in straight away. Hands you already
  played, and your messages in table chat, stay in other players' history,
  ledgers and table logs under the name you used at the time, because they
  are part of their games too. If you want your
  name taken out of those as well, ask John: names aren't part of the
  public record's fingerprints, so he can replace yours with "Deleted
  player" without breaking it. Copies in backups
  disappear as the backups expire, within 90 days.
- **As a guest:** clear the site's data in your browser to start fresh. To
  have anything removed from the server, ask John.
- **Anything else** (a chat message, a name in an old hand or tournament, a suggestion): ask
  John. He'll tell you honestly what can be removed and what can't.
- **What can't be deleted:** the public record. It is built so that nothing
  in it can be changed or removed, which is the point of it. It holds no
  names, cards or table links: your entries there are fingerprints and
  buy-in and cash-out amounts that can be tied to you only by someone who
  already has the table's link and knows who sat where.

## Children

The site is meant for adults in our group. It isn't aimed at children and
doesn't knowingly keep anything about anyone under 16. If you think it does,
tell John and he'll delete it.

## Changes and questions

When this page changes, the "Last updated" date above changes too, and every
change is in its history on GitHub. Questions: ask John (see *Who is
responsible*).
