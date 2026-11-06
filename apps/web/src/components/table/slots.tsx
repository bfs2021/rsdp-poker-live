import type { SeatView, TableView } from '@rsdp/engine/wire';
import type { Point } from '../geometry';
import { NoteBadge } from './Notes';
import { GestureLayer, SeatPersona } from './Persona';
import { EquityTag } from './Equity';
import { ChatBubbles } from './Chat';
import './extras.css';

/*
 * Mount points on the table for features that live in their own components
 * (double board, bomb pot and 7-2 badges, rabbit hunt, nit marker, notes,
 * pictures, moods and gestures, chat bubbles, all-in equity).
 * Add a line here rather than editing Table.tsx.
 */

/** Extra lines on a seat's nameplate. */
export function SeatExtras({ view, seat }: { view: TableView; seat: SeatView }) {
  return (
    <>
      {seat.nit === 'holder' && (
        <span className="tag nit-tag" title="Still holding the nit: win a pot outright to get off it">
          NIT
        </span>
      )}
      {seat.playerId !== view.me.playerId && <NoteBadge seat={seat} />}
      <SeatPersona seat={seat} />
      {seat.inHand && !seat.folded && <EquityTag view={view} seat={seat} />}
    </>
  );
}

/** Extra things under the board and pots. */
export function BoardExtras(_props: { view: TableView }) {
  return null;
}

/** Things drawn over the whole felt, with the seat positions to aim at. */
export function FeltExtras({ view, seatPoint, railPoint }: { view: TableView; seatPoint: (seat: number) => Point; railPoint: Point }) {
  return (
    <>
      <GestureLayer view={view} seatPoint={seatPoint} railPoint={railPoint} />
      <ChatBubbles view={view} seatPoint={seatPoint} width={railPoint.x * 2} height={railPoint.y} />
    </>
  );
}
