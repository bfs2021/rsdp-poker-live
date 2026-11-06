# Notes for AI coding sessions

Claude sessions write this project's code. Each session is short-lived, so the rules that matter are kept here, in the repo, rather than in any one session's memory. People are welcome to read this too.

## Where the truth is

- **GitHub is the record.** Open work, bugs and who is waiting on whom are [issues](https://github.com/jcolter11374/rsdp-poker-live/issues). Changes are pull requests. What's live is the commit the site's `/api/version` reports, deployed by the newest green Deploy run on `main`. The newest [release](https://github.com/jcolter11374/rsdp-poker-live/releases) normally names the same commit.
- **Memory and chat notes are a cache.** Check them against GitHub before repeating them. A status report comes from the issue lists, open bugs first, and says "unverified" for anything not checked.
- **Decisions** are in [docs/DECISIONS.md](docs/DECISIONS.md). Don't reopen a settled question or "fix" a deliberate simplification listed there. If one needs changing, add a new entry that replaces it.

## How work flows

[CONTRIBUTING.md](CONTRIBUTING.md) has the full process. In short:

- One issue per piece of work. One branch and one pull request into `develop`, which says `Closes #n` (or `Part of #n`).
- Merge into `develop` once CI is green and a review pass is done. Post the review as a comment on the PR: what was checked, the findings, how each was resolved, and the commit reviewed. Call it "a separate review we ran ourselves", never "independent": it isn't an outside auditor.
- Releases are pull requests from `develop` into `main`. A merge into `main` deploys.
- **Full or light.** A change that touches the game, tournaments, who sees what, fairness, accounts, stored data or how the site runs is *full*: a review pass, a play-test on a copy, and a release at a quiet time. One that is only displayed wording, layout, a download button for what people can already download, docs or new tests is *light*: CI plus a short review pass, and it can go live as soon as it's ready (a table-look change still needs John's before-and-after OK, D21). When unsure, full. A release takes the path of its riskiest change. The lists are in [CONTRIBUTING.md](CONTRIBUTING.md#full-or-light-how-much-checking-a-change-needs).
- How a release is tested and checked: [docs/DEPLOY.md](docs/DEPLOY.md). What to do when something goes wrong: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Hard rules

- **Never send test traffic to the live site** (`rsdp-poker-live.fly.dev`): no bots, test tables, test tournaments or sign-ups. Test on a local copy. Only read-only checks touch the live site: from GitHub Actions, or plain reads (GET requests to public pages and read-only endpoints like `/api/version` and `/api/health`) from a Claude session, which can reach that one host since 2026-11-05 (D24). Fly itself still goes only through `main`'s workflows.
- **Deploy only through `deploy.yml` on `main`.** Never from a laptop or a branch: the transparency watcher opens a public issue when it finds the live machine running an image `deploy.yml` didn't build and sign. It checks after each GitHub deploy and on a schedule that GitHub runs every few hours.
- **New secrets or settings:** add a new Fly secret to `SECRETS` in `scripts/transparency/deploys.mjs`, or a new plain setting to `[env]` in `fly.toml`, in the same PR, *before* it is set on Fly. Otherwise the watcher reports, in a public issue, an unknown secret or a setting that `fly.toml` on main doesn't have. See "Adding a setting or secret" in docs/DEPLOY.md.
- **Never handle John's backup private key.** Only John holds it. Don't ask for it.
- **Production keys stay in `main`'s own workflows.** Workflows that use `FLY_API_TOKEN` or `ADMIN_KEY` run only from `main`: keep their main-only `if:` guard, and never give them a `push` or `pull_request` trigger that runs on another branch. Changing them through a normal PR into `develop` is fine.
- **Keep public pages honest.** /fairness, /transparency and /privacy must describe what the code really does. If a change affects what they say, update them in the same PR. Any new stored data, cookie or outside service needs a docs/PRIVACY.md change.
- **Keep private things out of this public repo:** players' names (unless already public), table invite links, the group's results spreadsheet, John's budget, and anything else a player or John hasn't made public.
- **Ask John before** anything that costs money, changes what the product is, or can't be undone (deleting data, removing live tournaments).

## Before a session stops

Don't call work done until the whole ask is done and checked on the live site (by looking only; games are tested on a copy), and every follow-up issue you opened has someone working on it or a "waiting on" label with the reason: see [Definition of done](CONTRIBUTING.md#definition-of-done) (D30). Opening an issue doesn't hand the work to anyone.

Leave nothing only in chat or memory. Open or update the issue, push the branch, and put what's left in the PR's "Left to do" section. A bug you found but didn't fix becomes a new issue. The exception is a security hole: tell John privately, and keep the record in a draft security advisory (Security → Advisories → New draft security advisory), which only he and sessions working through his account can see. If you can't create one, ask John to. Then follow [docs/RUNBOOK.md](docs/RUNBOOK.md#someone-reports-a-security-problem).
