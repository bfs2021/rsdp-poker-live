# Security policy

RSDP Poker Live! is a free hobby site for a group of friends, run by John. The code is public so that players can check it. If you find a way to break it, thank you: please tell John privately first.

## What counts

Please report anything that would let someone:

- see another player's cards, the deck, or the next hand's seed before they should
- act for another player, take their seat, or change their chips or results
- become a host or the admin without being given that role
- read or change data that isn't theirs, or take the site down with a few requests
- get at the keys the site and its GitHub workflows use

This covers the live site at https://rsdp-poker-live.fly.dev and the code in this repository.

Some things John could do as the operator are listed openly on [/fairness](https://rsdp-poker-live.fly.dev/fairness) under "How the developer could cheat you". Those are known limits, not bugs. A way for *someone else* to do any of them is a bug, though, and so is any gap between what that page says and what the code does.

## How to report

- **Best: GitHub's private report.** On this repository, open **Security → Report a vulnerability**. Only John can see it, along with the Claude sessions that write the code for him through his GitHub account. It is never made public unless John publishes it.
- **Or message John directly**, if you know him.
- **Don't post the details in a public issue, the table chat or the group chat.** If neither route works for you, open an issue that only says you found a security problem and would like John to get in touch, with no details. John will reply there with a private way to send them.

Please say what you did, what happened, and what you expected. A few steps to repeat it help most. Test on your own copy of the site where you can (see the README). On the live site, don't read other players' data, don't disrupt games, and don't run automated traffic against it.

## What to expect

- John aims to reply within a few days. This is a hobby project, so there's no fixed timetable.
- Fixes are made quickly, as a small pull request with tests and a review pass we run ourselves. Your report stays private, but the fix's code is public in its pull request, which is why it's released the same day under a plain title. Once the fix is live, John adds what was fixed to that release's notes on GitHub.
- There is no bounty, but you'll be thanked in the release notes if you'd like to be.
- Reports made in good faith that follow this page won't be treated as an attack on the site.
