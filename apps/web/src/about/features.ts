/** What the /about page highlights. Plain words for friends, not a full feature list (that's the roadmap). */
export interface Feature {
  icon: string;
  title: string;
  detail: string;
  link?: { href: string; label: string };
}

export const FEATURES: Feature[] = [
  {
    icon: '♠',
    title: 'Every game you play, and some new ones',
    detail: "Hold'em, Omaha and Omaha Hi-Lo with 4, 5 or 6 cards, plus Seven Card Stud, Stud Hi-Lo, Razz, 2-7 Triple Draw and Badugi. Each game has a short How to play guide, so nobody has to learn mid-hand.",
    link: { href: '/rules', label: 'Learn the games' },
  },
  {
    icon: '💣',
    title: 'The fun extras, free for everyone',
    detail: "Bomb pots, the 7-2 bounty, double board, run it twice, straddles, game rotation and Dealer's choice. Anyone can host a table with them, not just one person in the group.",
  },
  {
    icon: '🏆',
    title: 'Tournaments that start on their own',
    detail: 'Schedule one and it starts at the set time, even if the host is running late. Sit & Gos, bounty and knockout events, rebuys, add-ons and season leaderboards are all there.',
    link: { href: '/tn/new', label: 'Host a tournament' },
  },
  {
    icon: '🤖',
    title: 'Practice bots',
    detail: "Trying a new game? Add bots to the empty seats of a cash table and play with play chips, taking your time with nobody waiting on you. In a hand with only bots, tap Tip on your turn for a rough guide, and after the hand each bot says why it played as it did. Tips are for practice: never at a table where people have played each other, and bots never play in tournaments.",
  },
  {
    icon: '📈',
    title: 'Stats, leaderboard and hand search',
    detail: 'See how the group stacks up, follow your results over time, and find that one hand everyone is still arguing about. Replay any hand step by step.',
    link: { href: '/leaderboard', label: 'See the leaderboard' },
  },
  {
    icon: '🔒',
    title: 'Fair dealing you can check',
    detail: "Every deck is locked in before the deal, and every seated player's browser adds to the shuffle. Afterwards, anyone can check that a hand was dealt fairly.",
    link: { href: '/fairness', label: 'How fair dealing works' },
  },
  {
    icon: '👤',
    title: 'An account if you want one',
    detail: 'Sign in with Google or a username so your name, picture, notes and history follow you to any device. Guests can still just click the link and play.',
    link: { href: '/signin', label: 'Sign in' },
  },
  {
    icon: '💬',
    title: 'Chat at the table',
    detail: 'Talk trash, call for a bomb pot, or say good game. Chat sits right next to the table on a computer and one tap away on a phone.',
  },
];
