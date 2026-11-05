# Runbook: when something goes wrong

Plain steps for the likely emergencies, in the order to try them. Background on how the site is hosted and backed up is in [DEPLOY.md](DEPLOY.md).

Who can do what:

- **John** owns the GitHub, Fly.io and Google accounts. Only he can open the Fly dashboard, change repository settings or secrets, or use his backup key.
- **Claude sessions** can read GitHub, open pull requests and run workflows from the Actions tab. They can read the live site directly (read-only, D24 in [DECISIONS.md](DECISIONS.md)), but can't reach Fly, so anything on the machine itself goes through a workflow or through John.

To see what's live: `https://rsdp-poker-live.fly.dev/api/version` reports the commit the server runs, and the newest green Deploy run on `main` shows when it went out. The newest [release](https://github.com/jcolter11374/rsdp-poker-live/releases) normally names the same commit.

After any incident, add a line to the [incident log](#incident-log) at the bottom.

## The site is down

The automatic issue "The site is down" means `/api/health` hasn't answered, or has said its database isn't answering, for about 3 minutes, and no deploy was running. GitHub's scheduler often runs that check hours late (#197). Once John sets up an outside monitor (#180), it will usually notice first.

1. **Is a deploy running?** Actions → Deploy. A deploy stops the old machine before starting the new one, so a minute or two of downtime is normal. Wait for it to finish.
2. **Restart it by redeploying.** Actions → Deploy → Run workflow, on `main`. It needs no Fly login. Tables reload from their last save, and hands in progress resume. Note that this builds the **newest commit on `main`**, without waiting for CI. First check that it's the commit the site last ran (the last green Deploy run). If something newer is on `main`, let its own CI and deploy run instead.
3. **Look at the machine (John).** Fly dashboard → rsdp-poker-live → Monitoring: is the machine running, out of memory, or out of disk? `fly logs -a rsdp-poker-live` shows the last errors. A full disk usually means the database grew. See "Disk full" below. Also check Fly's Billing page: a problem with the account's payment can stop the machine.
4. **Is Fly itself down?** Check https://status.flyio.net. If so, there's nothing to do but wait. Tell players in the group chat.
5. **Still down after a deploy?** The newest release may be the cause. See "A bad release".

The issue closes itself when the site answers again. If the outage lasted past a watcher run, the public issue "Transparency watcher found a problem" may open too, saying the site didn't say which commit it runs. Once the site is back, comment there that it was the outage, link the site-down issue, and close it.

## A bad release

Something broke right after a release: errors, a page that doesn't load, games misbehaving.

1. **Find the release.** See "To see what's live" above.
2. **Revert, don't patch in a hurry.** Open an issue for the breakage. Then open a pull request into `main` that reverts the release's merge commit (GitHub's "Revert" button on the release PR does this), and put `Part of #<that issue>` in its description, so the issue stays open until the real fix ships. GitHub's "Reverts #N" text doesn't count for the PR check. **Don't merge it yet.** Work on the revert branch (`git fetch origin && git switch <the revert branch>`) through steps 3 and 4.
3. **Keep the release notes.** The revert also takes out the release's own changelog entry, which is already live, and the PR check refuses that. Put the notes back from the release commit, then add a new entry at the top with today's version that says in plain words what was taken back, and regenerate CHANGELOG.md ([CONTRIBUTING.md](../CONTRIBUTING.md#releases)):
   `git checkout <release merge commit> -- apps/web/src/roadmap/changelog.json apps/web/src/roadmap/whatsnew.json CHANGELOG.md`, edit changelog.json, then `npm run changelog`.
4. **Keep the database changes.** If the release changed the database (anything under `apps/server/drizzle/`), the live database has already applied it. A revert that drops it would make the older code refuse every backup ("The backup is from a newer version", `apps/server/src/db/backup.ts`). The next `drizzle-kit generate` would also try to undo it. So keep the whole migration (its `.sql` file, its `meta/*_snapshot.json`, its line in `meta/_journal.json`) and the matching change to `apps/server/src/db/schema.ts`. On the revert branch:
   `git checkout <release merge commit> -- apps/server/drizzle apps/server/src/db/schema.ts`
   The release may also have changed tests that list or count every table (`apps/server/test/db.test.ts`, `apps/server/test/backup.test.ts`, `apps/server/test/backup-fixture.ts`, `apps/server/src/db/testing.ts`). Take those back from the release commit too, where they changed only for the migration, and run `npm test -w @rsdp/server`.
   So far every migration only adds things, so older code runs fine alongside an extra column or table. Check the one you're keeping, though: a new column that is `NOT NULL` with no default would break the older code's inserts. If that's the case, fix forward instead of reverting.
5. **Push and merge.** Commit the changes from steps 3 and 4 and push the revert branch. Once CI and the PR check pass on the revert PR, merge it, and the deploy runs by itself.
6. **Put the record straight.** Reopen each issue the reverted release closed (the `Closes #n` list in its release PR), with a comment linking the revert PR, so GitHub doesn't show that work as live.
7. **Bring the revert back to `develop`** (merge `main` into `develop`). That takes the reverted work out of `develop` too. To ship it again later, revert the revert in a new PR into `develop`. Keep the release notes as they are (`git checkout origin/develop -- apps/web/src/roadmap/changelog.json apps/web/src/roadmap/whatsnew.json CHANGELOG.md`), because the revert's own entry is live too, and put the lines for the work coming back in the next release's entry (`npm run changelog`). Fix the real problem on top, with a test, and release as usual. That PR says `Closes #n` for the reopened issues and the breakage issue.
8. Tell John what broke, what players saw, and when it was fixed.

## Data is wrong or lost

- **A few wrong rows** (a mistaken result, a stuck table): fix it through the site's own host or admin tools where possible. A change made by hand on the machine doesn't go in the public record, so note it in the incident log.
- **The database is damaged or gone:** restore the newest backup. The steps are in DEPLOY.md under "Restoring". Restoring takes the site back to the moment of the backup, so tell players first. John has to unlock the backup with his key.

## Disk full

The data volume is 1 GB. The server tidies the embedded database itself (it vacuums at start-up and every 5 minutes), so a full disk means something unusual. John, with `flyctl` signed in:

1. See what's using the space: `fly ssh console -a rsdp-poker-live -C "df -h /data"`, then `fly ssh console -a rsdp-poker-live -C "sh -c 'du -sh /data/*'"`.
2. Look for leftovers from a restore: `pglite-before-restore-*`, `pglite-restoring`, `restore.jsonl.gz.done-*`, `restore.jsonl.gz.failed-*`, and `restore.jsonl.gz.part` (an upload that didn't finish). Delete them once the site is fine.
3. If the database itself has outgrown the volume, growing it costs money, so it's John's call. Find the volume with `fly volumes list -a rsdp-poker-live`, then `fly volumes extend <volume-id> -s 2`.

## What each automatic issue means

| Issue title | Opened by | What it means | Who acts |
| --- | --- | --- | --- |
| The site is down | `uptime.yml` | `/api/health` didn't answer, or its database didn't, for about 3 minutes. | Anyone checks and runs Deploy (above). John checks Fly. |
| Nightly backup failed | `backup.yml` | The latest daily backup, restore drill or locking failed. The run's log says which. | A Claude session reads the log and fixes it in a PR. Two failures in a row are urgent: there's no fresh copy. |
| Transparency watcher found a problem | `transparency.yml` | One of the watcher's checks failed. It might be an image `deploy.yml` didn't sign, a secret the code doesn't read, an unexpected setting, a second machine, settings that changed without a new image, a public record that doesn't add up, or the site not saying which commit it runs (`/api/version`). That last one is also how an outage looks to the watcher. It also opens when one of its own checks hasn't managed to finish for 12 hours: a run in which a check couldn't finish, after a long gap. GitHub starting the job late (#196) can make the gap long, but the issue says "(it last exited with N)". 2 means it couldn't reach the site, Fly or GitHub, or a deploy was running: harmless if the next run is clean. 3 means the watcher's own script broke and needs a fix in a PR. This issue is public. | John looks first. If it's an outage, GitHub running late, or a mistake on our side (for example a new secret not yet allowlisted), explain that on the issue and fix anything that needs a PR. Never close it without an explanation. |
| Security advisories in the libraries the server runs | `advisories.yml` | The weekly `npm audit` found a high or critical advisory in a library that ships to the server. The issue lists them. | A Claude session checks whether it's reachable and upgrades in a PR. The issue closes itself once none are left. |

## A key may have leaked

If a key was pasted somewhere public, committed, or shown in a log, replace it. Don't wait to find out whether anyone used it. Afterwards, add an entry to the incident log.

- **Fly token (`FLY_API_TOKEN`), John.**
  - In the Fly dashboard → Tokens, make a new token with the same access as the current one.
  - In GitHub → Settings → Secrets and variables → Actions, replace `FLY_API_TOKEN`.
  - Before revoking the old token, check the new one works: run Actions → Fly setup (it must go green), then Actions → Transparency watcher, and open that run. A green tick alone isn't enough there: the run must not show the warning "A check couldn't reach the site, Fly or GitHub this time". (Unverified: whether an app-only "deploy token" can run Fly setup, which starts with `flyctl auth whoami`. If it can't, use the same kind of token as before.)
  - Then revoke the old token in Fly.
  - The watcher also uses this token to fingerprint the app's secrets, so the public record will note that "the app's secrets changed". That's expected.
- **Admin key (`ADMIN_KEY`), John.**
  - Replace the repository secret with a new random value of at least 12 characters, then run Deploy, which sets it on Fly. The old key stops working when the new release is up.
  - Then look at [/transparency](https://rsdp-poker-live.fly.dev/transparency) for admin actions nobody meant to take, such as backup downloads at odd times.
- **Recap key (`REPORT_KEY`), John.** It can only read the game-night recap (error lines, restarts, activity counts; no chat or names).
  - Replace the repository secret with a new random value of at least 12 characters, run Deploy, and put the same value in the Claude project's cloud environment as `RSDP_REPORT_KEY`.
- **Google sign-in secret, John.**
  - In the Google Cloud console, open the OAuth client and add a new client secret. Unverified: the console's exact wording. Google may show the new secret only once.
  - Replace `GOOGLE_CLIENT_SECRET` in GitHub and run Deploy.
  - Check that "Sign in with Google" works, then disable and delete the old secret in the console. That order avoids a gap where sign-in is broken.
- **Backup private key, John.**
  - Anyone holding it can open every backup still on GitHub.
  - Make a new key pair, and put the new public key in `scripts/backup/recipient.txt` through a PR. It has to reach `main` (a release), because the daily backup reads the file from there.
  - Once the first backup locked to the new key is green, delete the old backup artifacts (Actions → Nightly backup → each run → Artifacts).
- **Anything else**, like a player's password: tell John. Signed-in sessions can be ended by the player changing their password.

## Someone reports a security problem

Handle it privately, as [SECURITY.md](../.github/SECURITY.md) says. Not in a public issue or PR description.

1. **Keep a private record.** Put the report and its progress in a draft security advisory (Security → Advisories → New draft security advisory). Only John, and the sessions working through his account, can see it. If a session can't create one, John does.
2. **Fix it quickly** as a small PR with a plain title. Give it the `no issue needed` label instead of linking an issue, because there is no public issue for it. The fix's code is public as soon as the PR opens, so release it straight away.
3. **Keep its changelog line plain**, for example "Fixed a security problem".
4. **Once the fix is live,** John edits that release on GitHub (Releases → the tag → Edit) to say what was fixed, and thanks the reporter if they'd like that. This is the one time a release's notes are edited by hand. The Release workflow never rewrites a release that already exists.

If a public issue only says someone found a security problem, don't ask for details there. John switches on private reporting if it's still off (Settings → Code security → Private vulnerability reporting, #179 step 4), then replies asking them to use Security → Report a vulnerability.

## Someone asks about their data

Requests to see, correct or delete someone's data are handled **privately**, by John, within a month, as [PRIVACY.md](PRIVACY.md) says. Never in a public issue.

If a request arrives as a public issue, thank them and ask them to message John directly. Then remove their personal details. GitHub keeps every earlier version of an edited comment or issue, so delete the old version from its edit history, or delete the issue (John can).

## Logs

- **Server logs:** `fly logs -a rsdp-poker-live` (John, or anyone with Fly access). Fly keeps only recent logs (unverified: about 7 days), so copy anything important into the incident note.
- **Workflow runs:** the Actions tab keeps each run's log for the repository's retention period.
- **What players and the operator did:** the public record on the `transparency` branch, and the /transparency page.

## Incident log

Newest first. One entry per incident: what happened, what players saw, the cause, the fix, and links.

- **2026-11-01: Releases went unchecked on the live site.** Nine releases (#151 to #171) got only the health ping, because the read-only check had to be started by hand. No player impact found. Fix: the checks now run automatically after every deploy (#187, fixed in #203, live since release 2026.11.01.2).
- **2026-11-01: The table rules were wrongly reported as "not started".** A stale note in an AI session's memory said so, although the rules had been live since 31 Oct. It was one of four wrong status reports in two days. Status reports now come from the GitHub issue lists (#174, PR #175, live since release 2026.11.01.2).
- **2026-10-26: The first backup was refused.** The deploy had copied the admin key to Fly with `flyctl secrets import`, which treats everything from a `#` on as a comment. So the site expected a shorter key than the one in GitHub, and refused the backup with 401 (#117). Fixed by setting the key as given (#119). See the comment in `deploy.yml`.
- **2026-10-25: Test data on the live site ("Smoke Cup").** The after-release smoke test was run against the live site. It created a test tournament with made-up players, which kept running and showed on the home page. The smoke test now refuses `fly.dev` URLs, the after-release check became read-only, and the test events were archived from a shell on the machine (#35).
