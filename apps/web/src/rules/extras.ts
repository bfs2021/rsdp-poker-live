import type { TableSettings } from '@rsdp/engine/settings';
import { bombPotSchema, bounty72Schema, doubleBoardSchema, nitSchema, rakeSchema } from '@rsdp/engine/modifiers';
import { getVariant } from '@rsdp/engine/variants';
import { RSDP_TABLE_RULES } from '@rsdp/tournament';
import type { CardList } from './guides';

/*
 * Plain-language guides to the side games and house rules: what each one is,
 * how it works here, worked examples and the host settings that change it.
 * The numbers in the examples come from the constants below, and
 * extras.test.ts checks the numbers in every example against the engine, so
 * a guide can't promise a payout or a minimum raise the table would work out
 * differently. At a table, the time bank example uses that table's own clock.
 */

/** One worked example: a short story with real numbers, and optional cards to show. */
export interface Example {
  title: string;
  lines: string[];
  cards?: { label: string; cards: CardList }[];
}

export interface ExtraGuide {
  id: string;
  name: string;
  /** The whole thing in one or two sentences. */
  idea: string;
  /** How it works here, step by step. */
  steps: string[];
  examples: Example[];
  /** The host settings that change it, and where they are. */
  settings: string[];
  /** Where this table differs from what players may know from other sites and home games. */
  elsewhere?: string[];
  /** Cash games only (never in tournaments). */
  cashOnly?: boolean;
}

/** Every example plays at 1/2 unless it says otherwise. */
const SB = 1;
const BB = 2;

/** The Nit game example: 5 players in, the default prize, and a loser short of what they owe. */
export const NIT_EX = { prizeBigBlinds: 10, players: 5, loserStack: 50 } as const;
const nitPrize = NIT_EX.prizeBigBlinds * BB;
const nitOwed = nitPrize * (NIT_EX.players - 1);

/** 7-2: six players dealt in, one of them with only a few chips left. */
export const BOUNTY_EX = { amount: 10, players: 6, shortStack: 6 } as const;
const bountyFull = BOUNTY_EX.amount * (BOUNTY_EX.players - 1);
const bountyShort = bountyFull - BOUNTY_EX.amount + BOUNTY_EX.shortStack;

/** Bomb pots: the default 5 big blinds, six players, one of them with less than that. */
export const BOMB_EX = { bigBlinds: 5, players: 6, shortStack: 7 } as const;
const bombPost = BOMB_EX.bigBlinds * BB;
const bombPot = bombPost * BOMB_EX.players;
const bombMain = BOMB_EX.shortStack * BOMB_EX.players;
const bombSide = (bombPost - BOMB_EX.shortStack) * (BOMB_EX.players - 1);

/** Straddles at 1/2: what each straddle posts and the smallest raise over it. */
export const STRADDLE_EX = { utg: 2 * BB, minRaiseOverUtg: 4 * BB, button: 4 * BB, minRaiseOverButton: 8 * BB, buttonAlone: 2 * BB } as const;

/** Run it twice and double board: an odd-sized pot, so the odd chip shows. */
export const RIT_EX = { pot: 201, run1: 101, run2: 100 } as const;
export const DOUBLE_EX = {
  pot: 101,
  top: 51,
  bottom: 50,
  boards: ['Kh 9c 4d 2s 2h', 'Qs Js 8s 5c 3d'] as [CardList, CardList],
  ana: 'Kd Kc',
  ben: 'As Ts',
} as const;

/** House fee: 5% with a cap of 3, and a 2.5% short-handed rate at 3 players or fewer. */
export const RAKE_EX = {
  percent: 5,
  cap: 3,
  short: { players: 3, percent: 2.5 },
  /** Pot, players dealt in, whether it saw a flop, and the fee. */
  pots: [
    { pot: 47, players: 6, flop: true, fee: 2 },
    { pot: 100, players: 6, flop: true, fee: 3 },
    { pot: 7, players: 6, flop: false, fee: 0 },
    { pot: 40, players: 3, flop: true, fee: 1 },
  ],
} as const;

/** Time bank: a cash table's default 30-second clock and 30-second bank. */
export const TIME_EX = { clock: 30, bank: 30, firstThink: 42, refillHands: 10 } as const;
/** Tournaments set their own; new ones start on the RSDP rules. */
const RSDP = RSDP_TABLE_RULES;
const rsdpClock = `${RSDP.decisionSeconds} seconds to act, a ${RSDP.timeBankSeconds}-second time bank refilled every ${RSDP.timeBankRefillHands} hands`;

/**
 * The time bank example. `atTable` uses a table's own numbers: the first think
 * then spends two fifths of the bank, as the default example does (12 of 30).
 */
function timeExample(t: { clock: number; bank: number; refillHands: number; firstThink?: number }, atTable: boolean): Example {
  const firstThink = t.firstThink ?? t.clock + Math.max(1, Math.round((t.bank * 2) / 5));
  const used = firstThink - t.clock;
  const left = t.bank - used;
  const refill =
    t.refillHands === 0
      ? `At this table the bank never refills, so you have ${left} seconds of it for the rest of the game.`
      : `At the next refill (every ${t.refillHands === 1 ? 'hand' : `${t.refillHands} hands`}${atTable ? ' at this table' : ' by default'}) the bank is back to ${t.bank}.`;
  return {
    title: `${atTable ? 'This table: a' : 'A'} ${t.clock}-second clock and a ${t.bank}-second bank`,
    lines: [
      `You think for ${firstThink} seconds before calling. The first ${t.clock} are your normal time, so ${used} come out of the bank and ${left} are left.`,
      `Next time you're stuck, you have ${t.clock} + ${left} = ${t.clock + left} seconds before you're checked or folded.`,
      refill,
    ],
  };
}

export const EXTRAS: ExtraGuide[] = [
  {
    id: 'mixed-games',
    name: 'Mixed games: HORSE and 8-Game',
    idea: 'The table plays several games in turn, switching after a set number of orbits or hands. HORSE and 8-Game are the two classic mixes.',
    steps: [
      "HORSE is five Limit games: Hold'em, Omaha Hi-Lo, Razz, Seven Card Stud and Stud Hi-Lo (the first letters spell it).",
      "8-Game plays 2-7 Triple Draw, Limit Hold'em, Omaha Hi-Lo, Razz, Seven Card Stud, Stud Hi-Lo, No-Limit Hold'em and Pot-Limit Omaha.",
      'Each game lasts one orbit to start with: once the button has gone all the way round, the next game starts. The table log says when the game changes, and the table shows the game being played.',
      "The blind games (hold'em, Omaha and Triple Draw) use the table's blinds. The stud games have no blinds: everyone antes, and the lowest up card (the highest in Razz) brings in.",
      'Only the stud games ante. The ante you set is the stud ante; the blind games are played without it.',
      'In the Limit games every bet and raise is a fixed size: the small bet on the early rounds and the big bet, twice as much, on the later ones.',
      'Seats are capped by the smallest game: 8 for HORSE (stud deals up to seven cards each) and 6 for 8-Game (Triple Draw needs cards to draw from).',
    ],
    examples: [
      {
        title: 'HORSE at $0.25/$0.50',
        lines: [
          "Hold'em and Omaha Hi-Lo: blinds of $0.25 and $0.50, then bets of $0.50 before the flop and on the flop, and $1 on the turn and river.",
          'Razz, Stud and Stud Hi-Lo: everyone antes $0.10, the bring-in is $0.15, and the bets are $0.50 on third and fourth street and $1 from fifth street on.',
        ],
      },
    ],
    settings: [
      'Start a cash game: pick HORSE or 8-Game under Mixed games in the Game list.',
      'At a table: Table settings > Game, then tap HORSE or 8-Game. You can then change how long each game lasts, drop games or add others.',
      'Table settings > Stakes sets the blinds, the Limit small and big bets, the stud ante and the bring-in.',
    ],
    elsewhere: [
      'Card rooms often switch games every orbit or every 8 hands online; change the lengths to match the game you know.',
      'Some games play the No-Limit and Pot-Limit rounds of 8-Game at different blinds. Here every game shares the same blinds.',
    ],
  },
  {
    id: 'nit-game',
    name: 'Nit game',
    cashOnly: true,
    idea: 'A side bet that punishes sitting on your hands. Everyone in a round starts "on the nit". Win a pot by yourself to get off it. The last player still on it pays a prize to each of the others.',
    steps: [
      'The host turns it on and sets the prize (in big blinds, paid to each player) and how many players it needs.',
      'To join, tick "Play the Nit game" under your action bar. A round starts on the first hand that enough ticked players are dealt into. Everyone in that round gets a purple NIT tag on their seat.',
      'Win a pot all by yourself to get off the nit, at showdown or because everyone folded. If there are side pots, you have to win every pot you are in.',
      "A chop doesn't count, and neither does half of a split hi-lo pot or one run of a run-it-twice hand.",
      "When only one player is still on the nit, they pay the prize to each of the others straight from their stack, and the round ends. If their stack can't cover it all, the rest is added to their buy-in, so it shows up when the table settles up.",
      "Once a round starts you're in it until it ends. Unticking only keeps you out of the next round. Sitting out doesn't get you off the nit: you can only win a pot in a hand you're dealt into.",
      "Players who didn't tick still play every hand as normal. They just aren't part of the side bet.",
      "Leaving the table while you're on the nit counts as losing: you pay everyone straight away. If you leave after getting off it, you simply drop out of the round and collect nothing. A round left with fewer than two players ends with nobody paying.",
      "The prize is fixed when the round starts, using the big blind at that moment. If the host turns the Nit game off, the round is cancelled and nobody pays.",
    ],
    examples: [
      {
        title: `A ${NIT_EX.players}-player round at ${SB}/${BB}`,
        lines: [
          `The prize is ${NIT_EX.prizeBigBlinds} big blinds, so ${nitPrize} chips to each player. Ana, Ben, Cy, Dee and Eve are all in, so all five start on the nit.`,
          'Hand 1: Ben bets the flop and everyone folds. He won the pot alone, so he is off the nit.',
          "Hand 2: Ana and Cy split the pot with the same straight. A chop doesn't count, so both are still on.",
          'Hand 3: Dee and Eve are all in and run it twice. Dee wins run 1 and Eve wins run 2. Neither won the pot alone, so both stay on.',
          'A few hands later Ana, Cy and Dee have each won a pot on their own. Eve is the last one on the nit.',
          `Eve pays ${nitPrize} to each of the other four: ${nitOwed} in all. The round is over, and a new one starts once enough ticked players are dealt in again.`,
        ],
      },
      {
        title: "When the loser can't cover it",
        lines: [
          `Same round, but Eve has only ${NIT_EX.loserStack} chips left when she loses. She pays the ${NIT_EX.loserStack} from her stack, and the other ${nitOwed - NIT_EX.loserStack} is added to her buy-in. The others still get ${nitPrize} each.`,
        ],
      },
    ],
    settings: [
      'Table settings → Side games → Nit game: "Play the Nit game" turns it on.',
      '"Prize (big blinds, to each player)": 1 to 100, 10 when you first turn it on.',
      '"Players needed": how many ticked players must be dealt into a hand before a round starts, 2 to 10 (3 by default).',
    ],
    elsewhere: [
      "Some sites make every player set the whole possible payout aside before a round starts. Nothing is set aside here: the loser pays from their stack at the end, and anything they can't cover goes on their buy-in.",
      "Not ticking the box doesn't sit you out. You keep playing every hand; you're just not in the side bet.",
    ],
  },
  {
    id: 'seven-deuce',
    name: '7-2 bounty',
    cashOnly: true,
    idea: 'Win a pot holding 7-2, the worst starting hand in Hold\'em, show it, and every other player dealt into the hand pays you a bounty.',
    steps: [
      'Hold\'em only: games with two hole cards and a board. It doesn\'t apply in Omaha, stud or draw games, but it does in a bomb pot dealt as Hold\'em.',
      'You have to win chips with the 7-2: the whole pot, or any share of it. A chop, one board of a double board, one run of a run-it-twice hand or a side pot all count.',
      'You have to show both cards. If the host has "Show a winning 7-2 automatically" on (it is by default), the table shows them for you, even when everyone folded. If it\'s off, tap "Show cards" after the hand, before the next one is dealt.',
      'Every other player who was dealt into the hand pays you the bounty, whether they folded or not. Players sitting out or waiting to come in don\'t pay.',
      "It comes straight from their stacks, outside the pot, so the house fee never touches it. Someone who can't cover it pays what they have, and owes nothing more.",
      "If two players both win a share with 7-2, each payer's bounty is split between them.",
      'It\'s paid once a hand at most. The host chooses which 7-2 hands count: any, offsuit only, or suited only.',
    ],
    examples: [
      {
        title: `A bounty of ${BOUNTY_EX.amount} with ${BOUNTY_EX.players} players`,
        cards: [{ label: 'Cy', cards: '7s 2d' }],
        lines: [
          `Cy raises with 7-2 and everyone folds. The table shows Cy's cards, and the other ${BOUNTY_EX.players - 1} players pay ${BOUNTY_EX.amount} each: ${bountyFull} on top of the pot.`,
          `If Ben had only ${BOUNTY_EX.shortStack} chips left, he'd pay ${BOUNTY_EX.shortStack} and Cy would collect ${bountyShort}.`,
        ],
      },
      {
        title: 'Half a pot still counts',
        lines: [
          `Cy is all in with 7-2 and the hand is run twice. Cy wins run 1 and loses run 2. He won a share of the pot, so he still collects the full bounty from everyone else dealt in.`,
        ],
      },
    ],
    settings: [
      'Table settings → Side games → 7-2 bounty: "Play the 7-2 bounty" turns it on.',
      '"Bounty per player": a fixed number of chips (not big blinds).',
      '"Which 7-2": any, offsuit only, or suited only.',
      '"Show a winning 7-2 automatically": on by default.',
    ],
    elsewhere: [
      'The usual rule is that an unshown 7-2 earns nothing. That\'s the same here, but the host can have the table show a winning 7-2 for you, and can limit the bounty to suited or offsuit 7-2.',
    ],
  },
  {
    id: 'bomb-pots',
    name: 'Bomb pots',
    cashOnly: true,
    idea: 'Everyone puts in the same amount before the cards are dealt, there\'s no betting before the flop, and the flop comes straight away. Big pots, lots of action.',
    steps: [
      'Every player dealt in posts the bomb pot amount, set by the host in big blinds. Nobody posts blinds that hand.',
      'The flop is dealt at once. Betting starts with the first player left of the button, as on any flop, and the hand plays on as normal from there.',
      "A player with less than the amount posts everything they have and is all in. The chips they couldn't match go into a side pot.",
      'The host decides when they happen: by chance each hand, every so many hands (counted from the last bomb pot), or with the "Bomb pot next hand" button in Host controls. The button works even when automatic bomb pots are off.',
      "A bomb pot can be a different game from the table's, for example Pot-Limit Omaha bomb pots at a Hold'em table. It has to be a game with a flop.",
      'Missed blinds aren\'t collected in a bomb pot: they wait for the next normal hand. Players waiting for the big blind sit the bomb pot out.',
      'With double board set to "Bomb pots only", every bomb pot is dealt with two boards.',
    ],
    examples: [
      {
        title: `${BOMB_EX.bigBlinds} big blinds at ${SB}/${BB}, ${BOMB_EX.players} players`,
        lines: [
          `Everyone posts ${bombPost}, so there are ${bombPot} chips in the middle before anyone acts. The flop comes out and the player left of the button acts first.`,
        ],
      },
      {
        title: 'A short stack',
        lines: [
          `Same bomb pot, but Dee has only ${BOMB_EX.shortStack} chips. She posts ${BOMB_EX.shortStack} and is all in.`,
          `The main pot is ${BOMB_EX.shortStack} from each of the ${BOMB_EX.players} players: ${bombMain}. The other ${BOMB_EX.players - 1} players' extra ${bombPost - BOMB_EX.shortStack} each makes a side pot of ${bombSide} that Dee can't win.`,
        ],
      },
    ],
    settings: [
      'Table settings → Side games → Bomb pots: "Deal bomb pots on their own" turns on the automatic ones.',
      '"Chance each hand (%)": 10% by default. "Or every (hands)": 0 turns it off.',
      '"Each player posts (big blinds)": 1 to 100, 5 by default.',
      '"Bomb pot game" and "Betting": play bomb pots as another flop game.',
      'Host controls → "Bomb pot next hand" calls one for the next hand only.',
    ],
    elsewhere: [
      'Some sites only deal bomb pots at random. Here the host can also have one every so many hands, call one for the next hand, or play them as a different game.',
      "Some sites collect missed blinds during a bomb pot. Here they wait for the next normal hand.",
    ],
  },
  {
    id: 'double-board',
    name: 'Double board',
    cashOnly: true,
    idea: 'Two boards are dealt instead of one. Half of each pot goes to the best hand on the top board and half to the best on the bottom board.',
    steps: [
      'Every street deals both boards: two flops, two turns and two rivers. There\'s still one round of betting per street.',
      'At showdown each pot is cut in half. The best hand on the top board wins one half, and the best hand on the bottom board wins the other. Win both to take it all.',
      'A tie on one board splits that half. If a pot won\'t split evenly, the odd chip goes to the top board\'s half.',
      'In hi-lo games each board\'s half is split again into a high half and a low half. With run it twice too, each run gets its own pair of boards and the pot is cut into four.',
      "Flop games only. If the deck doesn't hold enough cards for two boards (lots of players in a 5 or 6-card game), that hand is dealt with one board.",
    ],
    examples: [
      {
        title: `A ${DOUBLE_EX.pot}-chip pot`,
        cards: [
          { label: 'Top', cards: DOUBLE_EX.boards[0] },
          { label: 'Bottom', cards: DOUBLE_EX.boards[1] },
          { label: 'Ana', cards: DOUBLE_EX.ana },
          { label: 'Ben', cards: DOUBLE_EX.ben },
        ],
        lines: [
          `On the top board Ana has a full house, kings full of twos. On the bottom board Ben has an ace-high flush in spades.`,
          `Ana wins the top board's ${DOUBLE_EX.top} (it gets the odd chip) and Ben wins the bottom board's ${DOUBLE_EX.bottom}.`,
        ],
      },
    ],
    settings: [
      'Table settings → Side games → Double board: "Deal two boards" turns it on.',
      '"When": bomb pots only (the default) or every hand.',
    ],
  },
  {
    id: 'run-it-twice',
    name: 'Run it twice',
    cashOnly: true,
    idea: "When players are all in before the river, the rest of the board can be dealt twice, with half the pot on each run. It doesn't change what you win on average, it just makes a bad beat hurt less.",
    steps: [
      'It comes up when nobody can bet any more (everyone left is all in, or all but one) and there are still board cards to come. Flop games only.',
      'With "Players choose", everyone still in the hand gets "Run it once" and "Run it twice" buttons and 12 seconds to answer. It runs twice only if every one of them says twice. One "once", or no answer in time, means it runs once.',
      'Players marked away answer "once" automatically. Practice bots always say twice.',
      'With "Always", it runs twice every time, without asking.',
      'Only the cards still to come are dealt twice. All in before the flop: two whole boards. All in on the flop: two turns and two rivers. All in on the turn: two rivers.',
      'Every pot, side pots included, is cut in half: one half for the best hand on run 1, the other for run 2. The odd chip goes to run 1.',
      "It's skipped if the deck doesn't have enough cards left for two runs.",
    ],
    examples: [
      {
        title: `A ${RIT_EX.pot}-chip pot run twice`,
        lines: [
          `Ana and Ben are all in before the flop, and the pot is ${RIT_EX.pot}. Both say "Run it twice".`,
          `Run 1 is worth ${RIT_EX.run1} (it gets the odd chip) and run 2 is worth ${RIT_EX.run2}. Ana wins run 1 and Ben wins run 2, so Ana gets ${RIT_EX.run1} and Ben gets ${RIT_EX.run2}. If Ana won both, she'd get all ${RIT_EX.pot}.`,
        ],
      },
    ],
    settings: ['Table settings → Rules → "Run it twice": Off, Players choose (the default for cash tables) or Always.'],
  },
  {
    id: 'straddles',
    name: 'Straddles',
    cashOnly: true,
    idea: 'A straddle is an extra blind, double the big blind, posted before the cards by the player just left of the big blind ("under the gun"). It doubles the stakes for that hand.',
    steps: [
      'Turn on "Straddle when I\'m under the gun" (the Straddle chip on a computer). It then posts for you every time you\'re under the gun. If the host allows button re-straddles, the same switch also straddles for you when you\'re on the button.',
      'The straddle is live: action starts with the player on your left, and you act last before the flop. If nobody raises, you can check or raise.',
      'The smallest raise over a straddle is a whole straddle more.',
      'If the host allows a button re-straddle, the player on the button can straddle too, for double whatever the biggest blind is. Then the small blind acts first and the button acts last before the flop.',
      "There's no straddle with fewer than three players dealt in, when under the gun is also the button, on the hand you post a blind to come back in, or in stud games. A short stack straddles all in for what they have.",
    ],
    examples: [
      {
        title: `An under-the-gun straddle at ${SB}/${BB}`,
        lines: [
          `Cy is under the gun and straddles ${STRADDLE_EX.utg}. Dee, on Cy's left, acts first: she can fold, call ${STRADDLE_EX.utg}, or raise to at least ${STRADDLE_EX.minRaiseOverUtg}.`,
          'If everyone just calls, the action comes back to Cy last, who can check or raise.',
        ],
      },
      {
        title: 'With a button re-straddle',
        lines: [
          `Cy straddles ${STRADDLE_EX.utg} and Eve, on the button, re-straddles to ${STRADDLE_EX.button}. Ana in the small blind acts first, and the smallest raise is to ${STRADDLE_EX.minRaiseOverButton}. Eve acts last.`,
          `If Cy hadn't straddled, Eve's button straddle would be ${STRADDLE_EX.buttonAlone}.`,
        ],
      },
    ],
    settings: [
      'Table settings → Rules → "Straddles": Off, Under the gun (the default), or Under the gun and button re-straddle.',
      "Each player turns their own straddle on or off at their seat.",
    ],
    elsewhere: [
      `Some sites let you raise a straddle by just one big blind (to ${STRADDLE_EX.utg + BB} over a ${STRADDLE_EX.utg} straddle at ${SB}/${BB}). Here, as in most cardrooms, the smallest raise is a whole straddle more: to ${STRADDLE_EX.minRaiseOverUtg}.`,
      'Many sites only allow an under-the-gun straddle. The button re-straddle is extra here.',
    ],
  },
  {
    id: 'rabbit-hunt',
    name: 'Rabbit hunt',
    idea: 'When a hand ends before all the board cards are out, you can peek at the cards that would have come. Just for curiosity: it changes nothing.',
    steps: [
      'After a hand in a flop game ends early (everyone folded), a "🐇 Rabbit hunt" button appears under the action bar until the next hand is dealt.',
      'Tap it to see the rest of the board. Only you see it. Anyone else who wants to look taps too.',
      "They're the real next cards. The deck's order is fixed when it's shuffled and no cards are burned, so you see exactly what would have been dealt.",
      'With double board you see what would have come on each board.',
    ],
    examples: [
      {
        title: 'Would the flush have come?',
        cards: [
          { label: 'Flop', cards: 'Qh 8h 3c' },
          { label: 'Rabbit', cards: 'Th 2s' },
        ],
        lines: ['Ben folds his flush draw to Ana\'s big bet on the flop. He taps Rabbit hunt and sees the ten of hearts on the turn: he would have made his flush. Ana still wins the pot.'],
      },
    ],
    settings: [
      'Cash tables: Table settings → Rules → "Rabbit hunting": on by default.',
      `Tournaments follow the event's own rules: the host sets "Allow rabbit hunting" on the new tournament form or in the lobby's Host tab, until the first table opens. The RSDP rules a new tournament starts on have it ${RSDP.rabbitHunt ? 'on' : 'off'}.`,
    ],
    elsewhere: ['On some sites rabbit hunting starts switched off. Here it starts on at cash tables.'],
  },
  {
    id: 'time-bank',
    name: 'Time bank',
    idea: 'Extra thinking time for big decisions, on top of the normal clock. You keep what you don\'t use, and it fills back up every so many hands.',
    steps: [
      `Each turn you have the normal clock: ${TIME_EX.clock} seconds by default at a cash table. Tournaments follow the event's own rules: the RSDP rules are ${rsdpClock}.`,
      'Your time bank is extra seconds you carry from hand to hand.',
      'When your normal time runs out, the bank starts by itself (unless the host turned that off, or you\'re offline or sitting out). You can also start it early with the "Time bank" button on your turn.',
      "You only spend time you use past the normal clock, rounded up to whole seconds. Starting it early and then acting in your normal time costs nothing.",
      "When the bank runs out too, you check if you can, otherwise you fold. Run out of time twice in a row and you're sat out.",
      'Every so many hands (counted from the last refill) the bank goes back to full, whether you used it or not.',
      'When the host pauses the game, every clock stops where it is.',
    ],
    examples: [timeExample(TIME_EX, false)],
    settings: [
      'Cash tables: Table settings → Clock: "Seconds to act" (0 = no clock), "Time bank (seconds)" (0 to 300), "Refill every (hands)" (0 = never) and "Use the time bank automatically".',
      'Cash tables: Table settings → Seats → "Timeouts before away": how many timeouts in a row before a player is sat out (2 by default, 0 = never).',
      `Tournaments: the host sets "Decision clock", "Time bank" and "Refill bank every (hands)" on the new tournament form or in the lobby's Host tab, until the first table opens. A new tournament starts on the RSDP rules: ${rsdpClock}.`,
    ],
    elsewhere: [`Here the bank refills all at once: every so many hands (${TIME_EX.refillHands} by default at a cash table) it goes back to full, rather than topping up a little each hand.`],
  },
  {
    id: 'showdown',
    name: 'Showing and mucking',
    idea: "At showdown, hands that can't win anything are thrown away unseen, in the order a cardroom uses. You can always choose to show your cards after the hand.",
    steps: [
      'When the last bet is called on the river, the last player who bet or raised in that round shows first. If everyone checked, the first player left of the button shows first.',
      'Going round to the left, each hand is shown if it beats or ties the best hand shown so far (on any board, or for either half of a hi-lo pot). Hands that can\'t win anything are mucked unseen.',
      "A player who is all in always shows. In flop and stud games, when nobody can bet any more before the last card, every hand still in is turned face up straight away.",
      'After the hand, anyone who was dealt in can show all their cards, or just one, with the Show cards buttons, until the next hand starts. In draw games a folded hand can\'t be shown.',
      'The host can switch on "Show every hand at showdown" to turn every hand that reached showdown face up.',
    ],
    examples: [
      {
        title: 'Who shows and who mucks',
        lines: [
          'On the river Ana bets and Ben and Cy call. Ana bet last, so she shows first: a pair of kings.',
          "Ben, on her left, has a pair of queens. It can't beat the kings, so it's mucked and nobody sees it.",
          'Cy has two pair. It beats the kings, so it\'s shown, and Cy wins.',
        ],
      },
    ],
    settings: [
      'Table settings → Rules → "Show every hand at showdown": off by default.',
      'Table settings → Chat & watching: whether spectators see every hole card (everyone at the table is told if this is on).',
    ],
    elsewhere: ['Some sites always muck losing hands. Here the host can choose to show every hand at showdown instead.'],
  },
  {
    id: 'house-fee',
    name: 'House fee (rake)',
    cashOnly: true,
    idea: 'An optional fee taken from each pot, the way a cardroom takes rake. It\'s off unless the host turns it on, and no money goes anywhere: the chips just leave the table and a running total is kept.',
    steps: [
      'A percentage of each pot is taken before the pot is awarded, rounded down to whole chips. Each side pot is charged on its own.',
      'The host can cap the fee per pot, and set a smallest pot (for the whole hand) that pays any fee at all.',
      '"No flop, no fee": a hand that ends before the flop pays nothing. In stud and draw games that means a hand that ends in the first betting round.',
      'An optional short-handed rate is used when only a few players are dealt in, with its own cap.',
      'The 7-2 bounty and Nit game payments are never charged.',
      "The total is shown under the action bar to the host and co-hosts, or to everyone if the host chooses. Each hand's log shows what was taken from it.",
    ],
    examples: [
      {
        title: `${RAKE_EX.percent}% with a cap of ${RAKE_EX.cap}`,
        lines: [
          ...RAKE_EX.pots
            .filter((p) => p.players > RAKE_EX.short.players)
            .map((p) =>
              !p.flop
                ? `Everyone folds before the flop with ${p.pot} in the pot: no fee.`
                : (p.pot * RAKE_EX.percent) / 100 > RAKE_EX.cap
                  ? `A ${p.pot} pot: ${RAKE_EX.percent}% is ${(p.pot * RAKE_EX.percent) / 100}, but the cap is ${RAKE_EX.cap}, so the fee is ${p.fee}.`
                  : `A ${p.pot} pot: ${RAKE_EX.percent}% is ${(p.pot * RAKE_EX.percent) / 100}, rounded down to ${p.fee}.`,
            ),
          ...RAKE_EX.pots
            .filter((p) => p.players <= RAKE_EX.short.players)
            .map(
              (p) =>
                `With a short-handed rate of ${RAKE_EX.short.percent}% at ${RAKE_EX.short.players} players or fewer, a ${p.pot} pot with ${p.players} players dealt in pays ${(p.pot * RAKE_EX.short.percent) / 100}, rounded down to ${p.fee}.`,
            ),
        ],
      },
    ],
    settings: [
      'Table settings → Side games → House fee: "Take a house fee", "Fee (% of each pot)", "Cap per pot", "Smallest pot with a fee" and "No flop, no fee" (on by default).',
      'The short-handed rate, fee and cap, and "Who sees the total" (only the host by default).',
    ],
    elsewhere: ['Some sites need paid credits for a table fee and stop the game when they run out. There are no credits here.'],
  },
  {
    id: 'missed-blinds',
    name: 'Joining and missed blinds',
    cashOnly: true,
    idea: 'How you come into a cash game, and what you owe if the blinds passed you while you were away.',
    steps: [
      "The button and blinds move the same way every hand: the big blind moves on exactly one player, so nobody skips it or pays it twice. When a seat is empty the button can sit on it (a dead button).",
      'When you sit down, you post a big blind to be dealt into the next hand. It\'s live: it counts as your bet, so if nobody raises you can check.',
      'If you sit down where the button or the small blind is about to be, you wait for the big blind to reach you instead. You can also tick "Wait for the big blind" while you wait to come in, so you don\'t post anything extra.',
      'If you sit out and the big blind passes you, you owe it when you come back: a live big blind, plus a dead small blind if you missed that too. The dead small blind goes into the pot and doesn\'t count toward your bet.',
      'When the table is just starting (fewer than two players have played a hand), new players don\'t have to post or wait to come in. Bomb pots never collect missed blinds.',
    ],
    examples: [
      {
        title: `Coming back at ${SB}/${BB}`,
        lines: [
          `Dee sat out while both blinds went past her. When she comes back she posts ${BB} live and ${SB} dead. If nobody raises, she can check: her ${BB} covers the call, and the ${SB} stays in the pot.`,
        ],
      },
    ],
    settings: ['These rules are the same at every cash table. In tournaments everyone is dealt every hand, so nobody waits or posts extra to come back in.'],
  },
];

const BY_ID = new Map(EXTRAS.map((g) => [g.id, g]));

/**
 * A guide by id. Given a table's settings, the time bank example uses that
 * table's clock, bank and refill (a tournament's can differ from a cash
 * table's defaults).
 */
export function extraFor(id: string, settings?: TableSettings): ExtraGuide | null {
  const g = BY_ID.get(id) ?? null;
  const t = settings?.timing;
  if (g?.id !== 'time-bank' || !t || t.decisionSeconds <= 0 || t.timeBankSeconds <= 0) return g;
  return { ...g, examples: [timeExample({ clock: t.decisionSeconds, bank: t.timeBankSeconds, refillHands: t.timeBankRefillHands }, true)] };
}

/** Guides for the side games and house rules switched on at a table, in guide order. */
export function extrasOn(settings: TableSettings): string[] {
  const cash = settings.table.mode === 'cash';
  const rot = settings.game.rotation;
  const specs = (rot.enabled && rot.steps.length ? rot.steps.map((s) => s.gameId) : [settings.game.gameId]).flatMap((id) => {
    try {
      return [getVariant(id)];
    } catch {
      return [];
    }
  });
  // Straddles need blinds; the 7-2 bounty needs Hold'em (two hole cards and a board).
  const blinds = specs.some((g) => g.family !== 'stud');
  const holdem = specs.some((g) => g.family === 'flop' && g.streets.reduce((n, st) => n + st.dealDown + st.dealUp, 0) === 2);
  const on: Record<string, boolean> = {
    'mixed-games': rot.enabled && rot.steps.length > 1,
    'nit-game': cash && nitSchema.get(settings).enabled,
    'seven-deuce': cash && holdem && bounty72Schema.get(settings).enabled,
    'bomb-pots': cash && bombPotSchema.get(settings).enabled,
    'double-board': cash && doubleBoardSchema.get(settings).enabled,
    'run-it-twice': cash && settings.play.runItTwice !== 'off',
    straddles: cash && blinds && settings.play.straddle !== 'off',
    'rabbit-hunt': settings.play.rabbitHunt,
    'time-bank': settings.timing.decisionSeconds > 0 && settings.timing.timeBankSeconds > 0,
    showdown: true,
    'house-fee': cash && rakeSchema.get(settings).enabled,
    'missed-blinds': cash,
  };
  return EXTRAS.filter((g) => on[g.id]).map((g) => g.id);
}
