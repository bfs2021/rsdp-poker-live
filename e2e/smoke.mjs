// Browser smoke test: a cash table plays a hand, another bets, raises and folds,
// a practice hand against bots gives a coach tip, and a tournament seats its
// players and deals. Runs against a server that serves the built web app.
//
//   npm run build && npm start &            (or the dev servers)
//   BASE_URL=http://localhost:3001 node e2e/smoke.mjs
//
// Screenshots go to e2e/out/. Any console error fails the run.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
// It creates tables and a tournament with made-up players, so it never runs against the live site.
if (/fly\.dev/.test(BASE)) {
  console.error('smoke test refused: it would leave test tables and tournaments on the live site');
  process.exit(1);
}
// Only the server under test is ever contacted: any other request is blocked and fails the run.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const SERVER = new URL(BASE).host;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();

async function open(label, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (LOCAL.has(url.hostname) || url.host === SERVER) return route.continue();
    errors.push(`${label}: blocked a request to ${url.origin}`);
    return route.abort();
  });
  return watch(await ctx.newPage(), label);
}

/** Another tab for the same browser (the same signed-in player), watched like the first. */
async function openTab(page, label) {
  return watch(await page.context().newPage(), label);
}

function watch(p, label) {
  p.setDefaultTimeout(15_000);
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  return p;
}

/** Checks or calls for whoever is to act until the hand is over. */
async function playOut(players, maxSteps = 120) {
  for (let i = 0; i < maxSteps; i++) {
    let acted = false;
    for (const p of players) {
      const buttons = p.locator('.action-bar.my-turn .buttons button');
      const texts = await buttons.allInnerTexts();
      const pick = texts.findIndex((t) => /^(Check|Call|Stand pat|Bring in)/.test(t));
      if (pick >= 0) {
        await buttons.nth(pick).click().catch(() => {});
        acted = true;
        await p.waitForTimeout(200);
      }
    }
    if (await players[0].locator('.pot.result').count()) return;
    if (!acted) await players[0].waitForTimeout(250);
  }
  throw new Error('the hand did not finish');
}

/**
 * Stops a cash game and waits until it has stopped. If the next hand was dealt before the click, the stop
 * waits for that hand to end, so it is played out (left alone, it would only end as everyone's clock ran down).
 */
async function stopGame(host, players) {
  await host.click('button:has-text("Stop game")');
  const stopped = host.locator('button:has-text("Start game")');
  await stopped.or(host.locator('button:has-text("Stopping after this hand")')).waitFor();
  if (!(await stopped.count())) await playOut(players);
  await stopped.waitFor();
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`ok  ${name} (${Date.now() - started} ms)`);
}

try {
  await step('cash table: create, approve a seat, play a hand', async () => {
    const host = await open('cash host');
    const guest = await open('cash guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Ann');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');

    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Bob');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');
    await host.waitForSelector('.seat .hole .playing-card');
    // Two people in the hand: no coach tip for whoever is to act, not even with the T key.
    const first = await Promise.any([host, guest].map((p) => p.locator('.action-bar.my-turn').waitFor().then(() => p)));
    await first.keyboard.press('t');
    await first.waitForTimeout(300);
    for (const p of [host, guest]) if (await p.locator('.play-tip-button, #play-tip').count()) throw new Error('a coach tip showed in a hand between two people');
    await playOut([host, guest]);
    await host.screenshot({ path: path.join(OUT, 'cash.png') });

    // A private note on Bob: saved, shown on his seat, and never shown to Bob.
    await host.click('.seat:not(.me) .note-badge');
    await host.click('.note-swatch.red');
    await host.fill('.note-text', 'Bluffs rivers');
    await host.click('.modal button:has-text("Save")');
    await host.waitForSelector('.seat:not(.me) .note-badge.has-note');
    await host.reload();
    await host.waitForSelector('.seat:not(.me) .note-badge.has-note');
    if (await guest.locator('.note-badge.has-note').count()) throw new Error('Bob can see a note');
    await host.screenshot({ path: path.join(OUT, 'notes.png') });

    // Bob picks a picture and a mood from his own seat; Ann sees both and throws him a gesture.
    await guest.click('.seat.me .nameplate');
    await guest.click('.avatar-pick[aria-label="fox"]');
    await guest.click('.mood-pick:has-text("🤠")');
    await guest.click('.modal button:has-text("Close")');
    await host.waitForSelector('.seat:not(.me) .seat-avatar .avatar:not(.initials)');
    await host.waitForSelector('.seat:not(.me) .seat-mood:has-text("🤠")');
    await host.click('.seat:not(.me) .nameplate');
    await host.click('.gesture-grid button[aria-label^="Fish"]');
    await guest.waitForSelector('.gesture-flight');
    await guest.screenshot({ path: path.join(OUT, 'gesture.png') });
    // B shows the felt in big blinds.
    await host.keyboard.press('b');
    await host.waitForSelector('.seat.me .stack:has-text("BB")');
    await host.keyboard.press('b');

    // Records: share the hand as a link anyone can open, and download the full log and tracker file.
    await host.click('.side-panel .tabs button:has-text("Hands")');
    await host.click('.hand-row .hand-text:has-text("Share")');
    await host.click('.modal button:has-text("Make a link")');
    const link = await host.locator('.share-hand input[readonly]').inputValue();
    await host.click('.modal button:has-text("Close")');
    const viewer = await open('shared hand viewer', { width: 390, height: 844 });
    await viewer.goto(link);
    await viewer.waitForSelector('.replayer .felt');
    await viewer.screenshot({ path: path.join(OUT, 'shared-hand.png') });
    await viewer.close();
    // No hand downloads while seated in a running game (no live HUDs): a note says when they open.
    await host.waitForSelector('.side-panel .records-locked');
    if (await host.locator('button:has-text("Tracker (OHH)")').count()) throw new Error('tracker download offered mid-game');

    // Fair dealing: the hand is sealed while the game runs, and still for half an hour after the host stops it.
    // STOP_REVEAL_WAIT_MS: against a server started with a short fairStopRevealMs, wait that long and check it opens.
    await guest.click('.side-panel .tabs button:has-text("Hands")');
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("Sealed")');
    await guest.click('.replayer button[aria-label="Close"]');
    await stopGame(host, [host, guest]);
    await guest.waitForTimeout(500);
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("Sealed"):has-text("half an hour after the host stops the game")');
    await guest.click('.replayer button[aria-label="Close"]');
    const revealWait = Number(process.env.STOP_REVEAL_WAIT_MS ?? 0);
    if (revealWait > 0) {
      // No reload: the open page hears the hands have opened and fetches them again.
      await guest.waitForTimeout(revealWait);
      await guest.locator('.hand-open').first().click();
      await guest.click('.replayer button:has-text("Check this hand")');
      await guest.waitForSelector('.fair-check:has-text("This hand checks out")');
      await guest.screenshot({ path: path.join(OUT, 'fair-check.png') });
      await guest.click('.replayer button[aria-label="Close"]');
    }

    // With the game stopped, the tracker file and the full log download.
    await host.click('.side-panel .tabs button:has-text("Hands")');
    const ohh = host.waitForEvent('download');
    await host.click('button:has-text("Tracker (OHH)")');
    if (!(await ohh).suggestedFilename().endsWith('.ohh')) throw new Error('no OHH file');
    await host.click('.side-panel .tabs button:has-text("Log")');
    const log = host.waitForEvent('download');
    await host.click('button:has-text("Download full log")');
    if (!(await log).suggestedFilename().endsWith('-log.txt')) throw new Error('no full log');
  });

  await step('cash table: bet with a preset, raise from the bet box, fold', async () => {
    const host = await open('betting host');
    const guest = await open('betting guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Fay');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Gus');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');

    const move = (p, label) => p.locator('.action-bar.my-turn .buttons button', { hasText: label });
    // A tap within half a second of your last move is taken as a double tap and ignored, so wait a little longer.
    const press = async (p, label) => {
      await move(p, label).waitFor();
      await p.waitForTimeout(600);
      await move(p, label).click();
    };
    // Heads up the button acts first before the flop and the big blind first after it.
    const button = await Promise.any([host, guest].map((p) => p.locator('.action-bar.my-turn').waitFor().then(() => p)));
    const blind = button === host ? guest : host;
    await press(button, /^Call/);
    await press(blind, /^Check/);

    // On the flop the big blind bets the pot from the presets...
    await move(blind, /^Bet /).waitFor();
    const smallest = await move(blind, /^Bet /).innerText();
    await blind.locator('.action-bar.my-turn .presets button', { hasText: /^Pot$/ }).click();
    const potBet = await move(blind, /^Bet /).innerText();
    if (potBet === smallest) throw new Error(`the Pot preset left the bet at "${smallest}"`);
    await press(blind, /^Bet /);

    // ...the button raises to twice the smallest raise, typed in the bet box...
    const box = button.locator('.action-bar.my-turn input[aria-label="Amount"]');
    await box.waitFor();
    const to = String(2 * Number(await box.getAttribute('min')));
    await box.fill(to);
    const raise = (await move(button, /^Raise to/).innerText()).split('\n')[0];
    if (!raise.includes(to)) throw new Error(`typed ${to} in the bet box but the button says "${raise}"`);
    await press(button, /^Raise to/);

    // ...and the big blind folds.
    await press(blind, /^Fold/);
    await host.waitForSelector('.pot.result');
    // Read the log before stopping: if the next hand is dealt first, the stop plays it out and the log moves on.
    const log = await host.locator('.side').innerText();
    for (const words of [' bets ', ' raises to ', ' folds']) if (!log.includes(words)) throw new Error(`the hand log has no "${words.trim()}"`);
    await host.screenshot({ path: path.join(OUT, 'betting.png') });
    // Stop the game: left running, the table would keep dealing and timing out after the run, and CI's backup
    // drill reads the leaderboard twice and wants it unchanged.
    await stopGame(host, [host, guest]);
  });

  await step('practice: a hand against bots, with a coach tip on your turn', async () => {
    const p = await open('practice');
    await p.goto(BASE);
    await p.fill('input[required]', 'Pia');
    await p.click('button:has-text("Practice with bots")');
    await p.waitForURL(/\/t\//);
    // The bots play on their own, and a hand folded round to Pia's big blind ends without her turn, so allow a few hands.
    const pill = p.locator('.action-bar.my-turn .play-tip-button');
    await pill.waitFor({ timeout: 60_000 });
    await pill.click();
    const tip = p.locator('#play-tip');
    await tip.filter({ hasText: /to win|of the pot|Draw|Stand pat/ }).waitFor().catch(async () => {
      throw new Error(`no tip, the panel said: ${(await tip.innerText().catch(() => 'nothing')).trim()}`);
    });
    await p.screenshot({ path: path.join(OUT, 'practice-tip.png') });
    // Stopped like the cash tables: closed mid-hand, the hand would only end as Pia's clock ran out, after the
    // run, and CI's backup drill would find the public record had moved on since it read it.
    await stopGame(p, [p]);
    await p.close();
  });

  await step('rules guides: open a game from its link and switch games', async () => {
    const p = await open('rules');
    await p.goto(`${BASE}/rules/badugi`);
    await p.waitForSelector('.guide-body h3:has-text("Badugi")');
    await p.click('.guide-chip:has-text("Razz")');
    await p.waitForSelector('.guide-body h3:has-text("Razz")');
    await p.close();
  });

  await step('side games: a PLO bomb pot on two boards at a Hold\'em table', async () => {
    const host = await open('side games host');
    const guest = await open('side games guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Dee');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Eli');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Table settings")');
    await host.click('.tabs button:has-text("Side games")');
    await host.locator('label:has-text("Bomb pot game") select').selectOption('plo4');
    await host.locator('label.toggle:has-text("Deal two boards") input').check();
    await host.click('.modal button:has-text("Save")');
    await host.click('button:has-text("Bomb pot next hand")');
    await host.click('button:has-text("Start game")');
    await host.locator('.topbar:has-text("Bomb pot")').waitFor();
    await host.locator('.board-row').nth(1).waitFor();
    await playOut([host, guest]);
    await host.screenshot({ path: path.join(OUT, 'bomb-pot.png') });
    // Stopped like the other cash tables, so it isn't still dealing when CI's backup drill runs.
    await stopGame(host, [host, guest]);
  });

  await step('tournament: create, register with names, start, everyone taken to the table', async () => {
    const host = await open('tournament host');
    await host.goto(`${BASE}/tn/new`);
    await host.getByRole('radio', { name: 'When I start it' }).click();
    await host.locator('label:has-text("Name") input').first().fill('Smoke Cup');
    await host.getByRole('button', { name: 'Create tournament' }).click();
    await host.waitForURL(/\/tn\/[0-9a-f]+$/);
    const id = host.url().split('/').pop();

    const players = [host, await open('tournament player 2'), await open('tournament player 3', { width: 390, height: 844 })];
    const names = ['Hana', 'Bo', 'Cy'];
    for (const [i, p] of players.entries()) {
      if (i > 0) await p.goto(`${BASE}/tn/${id}`);
      await p.locator('.tn-name input').fill(names[i]);
      await p.getByRole('button', { name: /^Register/ }).click();
      await p.getByText("You're registered.").waitFor();
    }
    // The host starts from the card by the clock, without opening the Host tab.
    await host.locator('.tn-host-start').getByRole('button', { name: 'Start now' }).click();

    const table = new RegExp(`/t/${id}-t1$`);
    for (const p of players) await p.waitForURL(table, { waitUntil: 'commit' });
    await host.locator('.tn-strip:has-text("Level 1")').waitFor();
    await host.waitForSelector('.seat .hole .playing-card');
    await playOut(players);
    const log = await host.locator('.side').innerText();
    for (const name of names) if (!log.includes(name)) throw new Error(`${name} was not in the first hand`);
    if (log.includes('(auto)')) throw new Error('a player was acted for automatically in the first hand');
    await host.screenshot({ path: path.join(OUT, 'tournament.png') });

    // The host ends it early the way the Host tab asks (pause, let the hand in progress finish, end), so its
    // table isn't still dealing when CI's backup drill runs. The players stay at the table to finish that hand.
    const lobby = await openTab(host, 'tournament host lobby');
    await lobby.goto(`${BASE}/tn/${id}`);
    await lobby.getByRole('tab', { name: /^Host/ }).click();
    await lobby.getByRole('button', { name: 'Pause', exact: true }).click();
    await lobby.locator('.tn-status-paused').waitFor();
    const finished = lobby.locator('.tn-status-finished');
    for (let tries = 0; !(await finished.count()); tries++) {
      if (tries === 10) throw new Error('the tournament did not end');
      // A hand dealt before the pause is still being played: play it out first.
      if (!(await host.locator('.pot.result').count())) await playOut(players);
      // The director may not have heard the hand end yet, and then refuses: try again.
      await lobby.getByRole('button', { name: 'End and rank by chips' }).click();
      await finished.waitFor({ timeout: 2000 }).catch(() => {});
    }
  });

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log('smoke test passed');
} catch (e) {
  console.error('smoke test FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
