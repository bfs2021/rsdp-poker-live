// Play-test: Dealer's choice (D31). A host makes a Dealer's choice table from
// the front page, three friends join (one on a phone), and they take turns
// picking games: in time, early during the last hand of a pick, and late (the
// current game carries on). Then three bots join, so Badugi (6 seats) is greyed
// out for seven players, and the table is shown on a wide, short screen.
// Takes about 6 minutes.
//   BASE_URL=http://localhost:3001 node e2e/playtest/dealers-choice.mjs
// See README.md.

import { writeFileSync } from 'node:fs';
import { BASE, OUT, DESK, PHONE, browser, errors, open, shot, shots, bot } from './lib.mjs';

const WIDE_SHORT = { width: 2300, height: 824 };
const john = await open('John', DESK, true);
const maya = await open('Maya');
const dev = await open('Dev');
const rosa = await open('Rosa', PHONE, true);
const people = [john, maya, dev, rosa];

const pickerOf = (p) => p.locator('.modal[aria-label="Pick the next game"]');
/** Whoever has the picker open, waiting up to `ms`. */
async function chooser(ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const p of people) if (await pickerOf(p).count()) return p;
    await john.waitForTimeout(300);
  }
  throw new Error('nobody was asked to pick');
}
async function pick(p, name) {
  await pickerOf(p).locator('.game-picker-pick', { hasText: new RegExp(`^${name}$`) }).click();
  await pickerOf(p).waitFor({ state: 'detached' });
}
const topBar = (p) => p.locator('.topbar .stakes').innerText();

try {
  await john.goto(BASE);
  await john.fill('input[required]', 'John');
  await john.locator('select').filter({ has: john.locator('option[value="choice"]') }).selectOption('choice');
  await shot(john, 'dc-home', "The front page: Dealer's choice is under Mixed games, with a line on how it works.");
  await john.click('button:has-text("Create table")');
  await john.waitForURL(/\/t\//);
  const url = john.url();
  await john.locator('.seat.empty button').first().click();
  await john.click('button:has-text("Sit down")');
  await john.waitForSelector('.seat.me');

  await john.click('button:has-text("Table settings")');
  await shot(john, 'dc-settings', "Table settings > Game: How the game is chosen, the menu (the 8-Game games to start) and one-tap fills.");
  await john.locator('.modal').getByRole('button', { name: 'Close' }).or(john.locator('.modal button:has-text("Cancel")')).first().click();

  for (const [p, name] of [
    [maya, 'Maya'],
    [dev, 'Dev'],
    [rosa, 'Rosa'],
  ]) {
    await p.goto(url);
    await p.locator('.seat.empty button').first().click();
    await p.fill('.modal input[required]', name);
    await p.click('button:has-text("Ask to sit")');
    await john.locator('.request button:has-text("Approve")').first().click();
    await p.waitForSelector('.seat.me');
  }

  const bots = people.map((p) => bot(p, 'call'));
  bots[0].host = true;
  await john.click('button:has-text("Start game")');

  // The first pick: the table waits, the chooser's panel opens by itself.
  const first = await chooser();
  await shot(first, 'dc-picker', `${first.label} has the Pick chip: the panel opens by itself, with How to play for every game and the time left.`);
  const watcher = people.find((p) => p !== first && p !== rosa) ?? maya;
  await shot(watcher, 'dc-picking-felt', `Everyone else sees "${first.label} is picking the next game" on the felt, and the PICK tag on ${first.label}'s seat.`);
  if (first !== rosa) await shot(rosa, 'dc-picking-phone', 'The same moment on a phone.');
  // How to play opens on top of the panel.
  await pickerOf(first).locator('button.link').first().click();
  await first.locator('.modal[aria-label="How to play"]').waitFor();
  await shot(first, 'dc-how-to-play', 'How to play opens on top of the panel without closing it.');
  await first.locator('.modal[aria-label="How to play"] button:has-text("Close")').last().click();
  await pick(first, 'Razz');
  await john.locator('.playing-card').first().waitFor();
  await shot(john, 'dc-razz', `Razz is dealt. The top bar says: ${await topBar(john)}`);

  // The next chooser picks early, during the last Razz hand.
  const early = people.find((p) => p !== first);
  for (let i = 0; i < 200; i++) {
    let found = null;
    for (const p of people) if (await p.locator('.topbar .pick-button').count()) found = p;
    if (found) {
      await shot(found, 'dc-pick-early', `${found.label} has the chip and the last Razz hand is on: a Pick next game button in the top bar, no clock.`);
      await found.click('.topbar .pick-button');
      await shot(found, 'dc-picker-early', 'The panel during the hand: no countdown yet.');
      await pick(found, "Pot-Limit Omaha");
      break;
    }
    await john.waitForTimeout(500);
  }
  await john.waitForFunction(() => /PLO/.test(document.querySelector('.topbar .stakes')?.textContent ?? ''), null, { timeout: 120_000 });
  await shot(john, 'dc-omaha', `Omaha straight after Razz, with no wait. Top bar: ${await topBar(john)}`);

  // A missed pick: the current game carries on.
  const late = await chooser(240_000);
  await shot(late, 'dc-picker-due', `${late.label}'s turn to pick after the Omaha orbit. ${late.label} lets the clock run out.`);
  await late.locator('.modal[aria-label="Pick the next game"] button:has-text("Close")').click();
  await john.waitForFunction(() => document.querySelector('.log, .side')?.textContent?.includes("didn't pick in time") ?? false, null, { timeout: 60_000 }).catch(() => {});
  await shot(john, 'dc-missed', 'Nobody picked in time: Omaha carries on for another orbit, and the chip moves on.');

  // Seven at the table: Badugi seats 6, so it is greyed out.
  for (let i = 0; i < 3; i++) {
    await john.locator('.seat.empty button.add-bot').first().click();
    await john.locator('.modal button.primary').click();
  }
  const seven = await chooser(300_000);
  await shot(seven, 'dc-greyed', `Seven at the table: Badugi and 2-7 Triple Draw seat 6, so they are greyed out for ${seven.label}.`);
  await pick(seven, 'Seven Card Stud');

  // Wide, short screen.
  await john.setViewportSize(WIDE_SHORT);
  await john.waitForTimeout(1500);
  await shot(john, 'dc-wide-short', 'The table on a wide, short screen (2300x824), with the PICK tag on the next chooser.');
  for (const b of bots) b.stop = true;
  await john.waitForTimeout(1000);
} catch (e) {
  errors.push(`script: ${e.stack ?? e}`);
  await shot(john, 'dc-failure', 'Where the script stopped.').catch(() => {});
} finally {
  writeFileSync(`${OUT}/dc-shots.json`, JSON.stringify(shots, null, 2));
  writeFileSync(`${OUT}/dc-errors.json`, JSON.stringify(errors, null, 2));
  console.log(errors.length ? `${errors.length} errors, see dc-errors.json` : 'no errors');
  await browser.close();
}
