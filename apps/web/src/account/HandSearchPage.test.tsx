// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HandSearchPage } from './HandSearchPage';
import { searchHands } from './api';

vi.mock('./AccountPages', () => ({ Shell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../components/Replayer', () => ({ Replayer: () => null }));
vi.mock('./api', () => ({
  fetchHandGames: () =>
    Promise.resolve({
      games: [
        { id: 'nlhe', betting: 'no-limit', name: "No-Limit Hold'em", hands: 3 },
        { id: 'nlhe', betting: 'fixed-limit', name: "Limit Hold'em", hands: 2 },
      ],
    }),
  searchHands: vi.fn(() => Promise.resolve({ hands: [], next: null })),
  shareFoundHand: vi.fn(),
}));

describe('hand search: the Game list', () => {
  it("lists Limit and No-Limit Hold'em apart and asks for the game and its betting", async () => {
    render(<HandSearchPage />);
    const game = screen.getByLabelText('Game') as HTMLSelectElement;
    await waitFor(() => expect(game.options).toHaveLength(3));
    expect([...game.options].map((o) => o.text)).toEqual(['Any game', "No-Limit Hold'em", "Limit Hold'em"]);
    fireEvent.change(game, { target: { value: [...game.options].find((o) => o.text === "Limit Hold'em")!.value } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(vi.mocked(searchHands)).toHaveBeenLastCalledWith(expect.objectContaining({ game: 'nlhe', betting: 'fixed-limit' }), null));
    // Back to any game: neither is sent.
    fireEvent.change(game, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(vi.mocked(searchHands).mock.lastCall![0]).toMatchObject({ game: undefined, betting: undefined }));
  });
});
