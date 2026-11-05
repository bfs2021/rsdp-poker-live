# Play-test harness

Before a release that holds any full change (see
[CONTRIBUTING.md](../../CONTRIBUTING.md#full-or-light-how-much-checking-a-change-needs))
we play it on a copy of the site, never on the live one.
These scripts do the tedious part: several real browsers (one sized like a
phone) play through the site the way a group of friends would, and save a
screenshot at each step for a person to look over. They are not tests and
don't run in CI: a run that finishes only means nothing got stuck. The
pictures are what to check.

- `cash.mjs`: a host and three friends at a cash table. Hold'em, run it
  twice, a bomb pot, Omaha and Stud, then the rules guide, ledger, hands
  and replayer. About 4 minutes.
- `tourney.mjs`: seven players register for a tournament set to start on its
  own a couple of minutes later, then everyone shoves until there is a
  winner. About 3 minutes.
- `lib.mjs`: what both share: browsers, screenshots, and bots that click the
  same buttons a player would.

Like the smoke test, they refuse a `fly.dev` address, and the browsers may
only contact the server under test (and other local addresses): anything
else is blocked and listed with the errors.

## Running one against a local copy

You need the repo set up (`npm install`) and Chromium for Playwright
(`npx playwright install chromium`, once). Start a local copy of the site in
one terminal, either from the code:

```bash
npm run build && npm start
```

or from the production image (see [DEPLOY.md](../../docs/DEPLOY.md#local-check-of-the-production-image)):

```bash
docker build -t rsdp-poker . && docker run --rm -p 3001:8080 -v rsdp-playtest:/data rsdp-poker
```

Then, in another terminal:

```bash
BASE_URL=http://localhost:3001 node e2e/playtest/cash.mjs
BASE_URL=http://localhost:3001 node e2e/playtest/tourney.mjs
```

Screenshots go to `e2e/out/playtest/` (set `OUT` to put them somewhere
else), with videos of the host's and the phone's browsers in `video/`, a
`cash-shots.json` or `t-shots.json` captioning each picture, and
`cash-errors.json` or `t-errors.json` listing any browser errors. Each run
leaves its tables and tournament behind on the copy it played on.
