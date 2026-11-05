# Deploying RSDP Poker Live!

The whole site is one container: the game server plus the built web app, built from the `Dockerfile` at the repo root. On every pull request, CI builds an image from that Dockerfile and runs the browser smoke test against it. The deploy builds its own image from the same commit (see [Fly.io](#flyio-production)).

What to do when something goes wrong is in [RUNBOOK.md](RUNBOOK.md).

## What the host must provide

- **Exactly one instance, always on.** Live tables and tournaments run in that one process on a server clock. A scheduled tournament has to start on time even when nobody has the site open, so turn off any "sleep when idle", "scale to zero" or auto-stop setting, and never run two copies at once.
- **WebSockets** (Socket.IO). Every mainstream host supports them.
- **Data that survives deploys.** Either:
  - set `DATABASE_URL` to a managed Postgres (14 or later), or
  - leave it unset and mount a persistent volume at `/data`. The server keeps an embedded PGlite database in `/data/pglite`.
  The container starts as root only to take ownership of `/data`, then runs the server as the unprivileged `node` user.
- **About 1 GB of memory.** With PGlite, the process peaks near 600 MB at boot, so 512 MB plans are too small. With Postgres it needs less.
- **HTTPS** in front of port `8080` (or whatever `PORT` says).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` in the image, `3001` when run locally | Port the server listens on. |
| `DATABASE_URL` | unset | Postgres connection string. When set, PGlite is not used. |
| `PGLITE_DIR` | `/data/pglite` in the image | Where the embedded database lives when `DATABASE_URL` is unset. |
| `NODE_ENV` | `production` in the image | Turns off development CORS. |
| `PUBLIC_URL` | unset; `fly.toml` sets the live address | The site's public address. Link previews use it, and Google sends people back to `PUBLIC_URL` + `/auth/google/callback`. Unset, the request's own address is used. |
| `ADMIN_KEY` | unset (a secret) | Turns on the roadmap admin page and the backup download (`/api/admin/backup`). At least 12 characters, or the server ignores it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset (secrets) | Sign in with Google is on only when both are set. |
| `BUILD_COMMIT` | set when the image is built | The commit the image came from. `deploy.yml` passes it as a build argument, and `/api/version` reports it. |
| `FLY_IMAGE_REF`, `FLY_MACHINE_ID` | set by Fly | Reported by `/api/version`. `FLY_IMAGE_REF` also goes in the public record each time the server starts, with the commit. |

On the live site, the plain settings live in `fly.toml` under `[env]`. The three secrets are copied to Fly by `deploy.yml` from GitHub's repository secrets, on every deploy.

### GitHub secrets

| Secret | Used by | What it is |
| --- | --- | --- |
| `FLY_API_TOKEN` | `deploy.yml`, `fly-setup.yml`, `transparency.yml` | A Fly API token for the app (see [Fly.io](#flyio-production)). The watcher also uses it as its fingerprint key (`WATCH_KEY`), so a new token changes every published secret fingerprint once. The public record then says the app's secrets changed, which is expected. |
| `ADMIN_KEY` | `deploy.yml` (copies it to Fly), `backup.yml` (downloads the daily backup) | The admin key above. Removing the secret turns the admin page off at the next deploy, and stops the backups too, because they need it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `deploy.yml` (copies them to Fly) | The Google sign-in client, from the Google Cloud console. |

Only workflows on `main` should use these. GitHub never shows a secret's value again, so replacing one means making a new value at its source. The steps are in [RUNBOOK.md](RUNBOOK.md#a-key-may-have-leaked).

### Adding a setting or secret

The transparency watcher publishes the names of the live app's secrets and a fingerprint of its settings. It opens a **public** issue for any secret not in `SECRETS`, and for any setting that `fly.toml` on main doesn't have or sets differently. So, in this order:

1. In the same pull request that starts reading it, add a new **secret** to `SECRETS` in `scripts/transparency/deploys.mjs`, or put a new **plain setting** in `fly.toml` under `[env]`. Add it to the tables above.
2. For a secret, add the step that copies it to Fly in `deploy.yml`. Set it with `flyctl secrets set`, as the admin key step does, not with `secrets import`, which cuts a value off at the first `#`. (The Google step still uses `secrets import`. That's safe only because Google's values never contain a `#`.)
3. Merge and release. Only then add the GitHub secret (John), and run Deploy once.

Never set a secret on Fly by hand. The watcher can't tell who set it.

The schema migrates itself at startup. Concurrent starts are serialised with an advisory lock.

- **Health check:** `GET /api/health` returns `{"ok":true,...,"db":"ok"}` (see [Site-down alert](#site-down-alert) for `db`).
- **Shutdown:** on `SIGTERM` the server saves every table and tournament and then exits, within 10 seconds. Give the host's stop timeout at least that long.

## Restarts and deploys

A deploy restarts the process:
- Tables reload from their last saved state.
- A hand in progress resumes with the same cards.
- Tournaments keep their clocks, and scheduled ones still start on time.
- Players' browsers reconnect by themselves.

**Each release's upgrade is rehearsed first.** Every pull request into `main` runs "Upgrade from what is live" (`.github/workflows/upgrade.yml`) on GitHub's machines, never on the live site. It runs `main`'s image and makes data with `main`'s own smoke test, then starts the pull request's image on that same volume. The new image must give the same leaderboard and keep every entry of the public record unchanged. It must also read back every saved table, with the same hands and players, and every saved tournament: a release that can't read them would drop them at deploy, even with the leaderboard unchanged. Then it starts `main`'s image again on the upgraded data, as a rollback would, and checks the same things. The play-test before a release (see CONTRIBUTING.md) can use the scripts in `e2e/playtest/`, which play a cash game and a tournament through real browsers on a local copy (see their README).

## Backups

The live site is backed up once a day, off Fly, by GitHub Actions (`.github/workflows/backup.yml`). It is scheduled for 09:41 UTC (about 5 am in New York, the quietest time for games), but GitHub starts scheduled jobs hours late: the first runs started between about 15:30 and 16:30 UTC, around midday in New York.

1. It reads the site's leaderboard and newest public record entry, then downloads the whole database from `GET /api/admin/backup` (needs the `X-Admin-Key` header; one at a time, and a server shutting down stops it first). The server reads every table in one transaction, so the copy is one moment in time; on PGlite, table saves wait for it (about a second per 25 MB). Each download goes in the public record as an admin action the moment it starts (so one stopped part-way shows too), because a copy holds any hand being played at that moment.
2. **Restore drill:** it restores the copy into a fresh PGlite folder (`apps/server/src/restore.ts`), starts a real server on it (`scripts/backup/drill.sh`), and checks that the restored server gives the same all-time leaderboard and has the site's newest public record entry with the same hash. CI runs the same drill on every pull request, after the browser smoke test.
3. It locks the copy with [age](https://age-encryption.org) to the public key in `scripts/backup/recipient.txt` and keeps it as a workflow artifact for 90 days. The repo is public and anyone signed in to GitHub can download artifacts, so the lock is what keeps the copy private. Only the matching private key opens it. John made the pair on his own computer (`ssh-keygen -t ed25519 -f rsdp-backup-key -N ""`; age takes an SSH public key as a recipient, and `ssh-keygen` comes with macOS and Windows) and keeps the private half outside GitHub, in his password manager. It is in no secret, file or server of ours, so nothing GitHub or Fly holds can open a backup. It is a random key, not a password, so it can't be guessed. Lose it and the backups can't be opened: make a new pair, put the new public key in `recipient.txt`, and the next day's copy uses it. Locking needs no secret, so this adds nothing to Fly and the transparency watcher is unaffected.
4. A failure opens the issue "Nightly backup failed", mentioning John; the next good run closes it.

Fly's own daily volume snapshots carry on as a second copy (same company, same region).

**Format:** gzipped JSON lines: a header (format version, time, number of migrations, tables), one line per row (`row_to_json`, so jsonb, timestamps and big numbers come back exactly), and an end line with each table's row count, which is how a restore knows the copy wasn't cut short. A backup restores into a fresh database of the same or a newer schema, PGlite or Postgres.

**Restoring:**

```bash
# 1. Download the artifact (Actions → Nightly backup → a run → Artifacts), unzip it, and unlock it with the private key
#    (the private key file, rsdp-backup-key; delete any copy you made for this afterwards):
age -d -i rsdp-backup-key -o backup.jsonl.gz rsdp-backup-….jsonl.gz.age
# 2. Test it on your own machine: restores into memory and prints the rows per table.
npx tsx apps/server/src/restore.ts backup.jsonl.gz --check
# 3. Into a new PGlite folder (or a postgres:// URL of an empty database). Nothing is written unless all of it restores.
npx tsx apps/server/src/restore.ts backup.jsonl.gz /data/pglite-restored
```

On Fly, the server does the swap itself when it starts, because swapping folders under a running server corrupts both:

1. Check there is room: `fly ssh console -C "df -h /data"`. The old data stays until you delete it, so you need about twice the database's size free.
2. Copy the unlocked backup up beside the data folder, then rename it into place (so a half-copied file is never picked up):
   `fly ssh sftp shell`, then `put backup.jsonl.gz /data/restore.jsonl.gz.part`, then `fly ssh console -C "mv /data/restore.jsonl.gz.part /data/restore.jsonl.gz"`.
3. Restart: `fly machine restart`. Before it opens the database, the server restores the file into a new folder (`apps/server/src/db/restoreOnStart.ts`) and swaps it in. It keeps the old data as `/data/pglite-before-restore-<time>` and renames the file to `restore.jsonl.gz.done-<time>`. If the backup doesn't restore, nothing changes, the file becomes `restore.jsonl.gz.failed-<time>`, and the log says why (`fly logs`).
4. Once all is well, delete the old folder and the file to free the space.

If the volume is gone, deploy first so a new one exists. Restoring takes the site back to the moment of the backup: tell players, and expect the public record on GitHub to show where the site's record went back (that is the record working as intended). Unlocking needs `age` on your computer (`brew install age` on a Mac, `winget install FiloSottile.age` on Windows).

- **Postgres:** `restore.ts` restores into an empty Postgres database too, with a role that may skip foreign key checks while loading (a superuser). With managed Postgres, also use the provider's own backups.

## Site-down alert

`.github/workflows/uptime.yml` asks `/api/health` whether the site is up and its database answers within a second. If not for about 3 minutes, and no deploy is running, it opens the issue "The site is down", mentioning John so GitHub emails him, and closes it when the site is fine again. It is scheduled every 5 minutes, but GitHub starts scheduled jobs late when it is busy: since 26 October 2026 it has run only every 3 to 7 hours. So it is a slow backstop, and an outage overnight or at a tournament's automatic start could go unnoticed for hours. GitHub also turns off scheduled workflows in a public repo after 60 days without a commit; re-enable them under Actions if that happens.

**A quick alert needs an outside monitor** in John's own name (issue #180): a free monitor such as UptimeRobot, type Keyword, URL `https://rsdp-poker-live.fly.dev/api/health`, keyword `"ok":true`, every 5 minutes, alerting John's email and phone. That keyword only tells whether the server answers. `/api/health` always answers `ok: true` with status 200 while the server runs (Fly's own health check relies on that), plus `db`: `"ok"`, `"slow"` (no answer within a second) or `"error"`. Only the GitHub check reads `db`, counting anything but `"ok"` as down; a monitor on the keyword `"db":"ok"` would catch a stuck database too, but could also alert on a single slow moment.

## Before a release: testing on a copy

There is no standing staging server (a second Fly machine would roughly double the bill). A release is tested on a **copy**: the production image, run locally by whoever prepares the release. Rules:

- **Never the live site, and never real player data.** Don't restore a real backup into a copy: it holds every player's hands. Make test data on the copy itself.
- **Production settings and code.** Run the image as it ships. If a test needs something production doesn't have (for example, a shorter wait before hands are revealed, which takes a code change), say so in the release PR, and test the real behaviour too where you can.
- **Start from the live version when the release changes the database.** That is what the live site goes through at deploy time, and CI doesn't rehearse it yet (#189):

  ```bash
  wait_up() { for i in $(seq 1 60); do curl -sf localhost:3001/api/health > /dev/null && return; sleep 1; done; docker logs copy; return 1; }
  git fetch origin
  git switch --detach origin/main && docker build -t rsdp-live .        # what's live now
  docker volume rm rsdp-upgrade 2>/dev/null                              # start from an empty volume
  docker run -d --name copy -p 3001:8080 -v rsdp-upgrade:/data rsdp-live && wait_up
  BASE_URL=http://localhost:3001 npm run smoke                           # main's own smoke test makes some data
  docker stop copy && docker rm copy
  git switch --detach origin/develop && docker build -t rsdp-release .  # what the release ships
  docker run -d --name copy -p 3001:8080 -v rsdp-upgrade:/data rsdp-release && wait_up   # the upgrade
  ```

  Then check the old tables, results and leaderboard are still there, run the smoke test again (now develop's), and finish with `docker stop copy && docker rm copy`.

The commands:

```bash
docker build -t rsdp-poker .
docker volume rm rsdp-copy 2>/dev/null                         # for a fresh copy; leave this out to keep its data
docker run -d --name copy -p 3001:8080 -v rsdp-copy:/data rsdp-poker
for i in $(seq 1 60); do curl -sf localhost:3001/api/health > /dev/null && break; sleep 1; done
BASE_URL=http://localhost:3001 npm run smoke                   # cash table, practice hand, tournament
docker stop copy && docker rm copy                             # when you're done
```

Then try what the release changes, by hand in a browser or with bots placed by hand. The release PR records it all under **How it was tested**: what was run on the copy, what passed, and any setting that was changed.

## Releasing

Work merges into `develop` as it's ready. A release is a pull request from `develop` into `main`, and merging it deploys.

- **Who decides.** John gave a standing OK on 2026-10-26: finished work may go live without asking him each time. Ask him first about anything that costs money or changes what the product is. Tell him what shipped after each release.
- **The release PR** says `Closes #n` for every issue it ships, and its changelog entry follows the rules in [CONTRIBUTING.md](../CONTRIBUTING.md#releases) (version, What's new only for features, the roadmap page). It lists the review passes and the copy test.
- **Timing.** A deploy restarts the server. Hands in progress resume and browsers reconnect by themselves, but players see a short pause, so prefer quiet times.
- **After the merge,** Deploy runs by itself once CI passes on `main`. It checks that the live site reports the new commit, and runs the read-only checks (pages load, closed endpoints stay closed, sign-in setup answers). Watch that run. If it goes red, see [RUNBOOK.md](RUNBOOK.md#a-bad-release).
- **A fix made straight on `main`** (a hotfix) must be merged back into `develop` right away, or the next release conflicts.
- **To undo a release,** revert it with a pull request into `main` and keep any database migrations. See [RUNBOOK.md](RUNBOOK.md#a-bad-release).

## Outside accounts and costs

Everything runs on John's own accounts. No values here, only what each one is for.

| Account | What depends on it |
| --- | --- |
| GitHub (`jcolter11374`) | The code, CI, deploys, daily backups, the public record (`transparency` branch), issues and alerts. |
| Fly.io | The live server, its data volume and daily volume snapshots, and the image registry. Billed by usage. |
| Google Cloud | The OAuth client behind "Sign in with Google". |

Costs: Fly bills one always-on small machine and a 1 GB volume to John's account, by usage. GitHub (public repository) and Google sign-in cost nothing. Anything that adds cost needs John's OK first: a second machine, a bigger volume, a paid service, or audio and video. If John loses access to one of these accounts, the site loses what it provides, so each one should have two-factor sign-in and saved recovery codes (#180).

## Local check of the production image

```bash
docker build -t rsdp-poker .
docker run -d --name copy -p 3001:8080 -v rsdp-data:/data rsdp-poker
for i in $(seq 1 60); do curl -sf localhost:3001/api/health > /dev/null && break; sleep 1; done
BASE_URL=http://localhost:3001 npm run smoke
docker stop copy && docker rm copy
```

## Fly.io (production)

The live site is the Fly app `rsdp-poker-live`, at https://rsdp-poker-live.fly.dev. `fly.toml` holds its settings: one `shared-cpu-1x` machine with 1 GB of memory in `iad`, never auto-stopped, with a 1 GB volume `rsdp_data` mounted at `/data` and a 30 s stop timeout. Fly takes a daily snapshot of the volume and keeps it for 5 days.

- **Deploys are automatic.** Every push to `main` runs CI, and when CI passes `.github/workflows/deploy.yml` deploys that commit with `flyctl`. Because the machine has a volume, Fly stops the old copy before it starts the new one. Afterwards the workflow checks that the live site reports the commit it just deployed and runs read-only checks (the pages load, the operator-only endpoint stays closed); a failed check turns the run red. You can also run the Deploy workflow by hand from the Actions tab.
- **Setup.** The deploy uses the GitHub Actions secret `FLY_API_TOKEN`, a Fly access token. `scripts/fly-provision.sh` creates the app and the volume if they are missing, and every deploy runs it first. The Fly setup workflow runs the same script on its own, by hand only (Actions → Fly setup → Run workflow, from `main`). It never runs on pull requests, because it holds the production Fly key.
- **Keep it at one machine.** Don't run `fly scale count 2` and don't add a second volume. Two copies would each run their own tables.
- **Useful commands** (with `flyctl` signed in): `fly logs -a rsdp-poker-live`, `fly status -a rsdp-poker-live`, `fly volumes snapshots list <volume-id>`.
- **Never point test traffic at the live site.** `e2e/smoke.mjs` creates tables and a tournament with made-up players, so it refuses a `fly.dev` URL. After a release, only read-only checks (health, pages loading) run against the live site, from the Deploy workflow or as plain reads from a Claude session (D24 in [DECISIONS.md](DECISIONS.md)).
- **Removing a test tournament.** From a shell on the machine (`fly ssh console -a rsdp-poker-live`), `GET http://127.0.0.1:8080/api/admin/tournaments` lists every event the server holds, and `POST http://127.0.0.1:8080/api/admin/tournaments/<id>/archive` ends it the way its host would and hides it from every list (results are kept). These endpoints answer 404 to anything that comes through Fly's proxy.
