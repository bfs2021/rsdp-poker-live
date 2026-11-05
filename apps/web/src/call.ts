// Commands that take an answer from the server, with a time limit. Kept apart
// from socket.ts (which connects as soon as it loads) so it can be tested.

type AckResult = { ok: true } | { ok: false; error: string };

/** What call() needs from a socket.io client socket. */
export interface AnswerSocket {
  /** Commands socket.io is holding until it is connected again. */
  readonly sendBuffer: readonly unknown[];
  emit(event: string, ...args: unknown[]): unknown;
  on(event: 'connect' | 'disconnect', listener: () => void): unknown;
  off(event: 'connect' | 'disconnect', listener: () => void): unknown;
}

/**
 * How long a command waits for the server's answer once it has gone out.
 * Without a limit, a command sent just before the connection dropped never
 * settled (socket.io forgets a plain answer callback when the connection
 * goes), and its button stayed busy.
 */
export const CALL_TIMEOUT_MS = 30_000;
/** Downloads of a whole game's hands can be big, so they get longer on a slow phone connection. */
export const SLOW_CALLS: Record<string, number> = { 'table:export': 120_000, 'table:fullLog': 120_000, 'tournament:tableChat': 120_000 };

/** What a player sees when no answer came. */
export const NO_ANSWER = 'No answer from the server. Check your connection, then try again.';
export const DROPPED = 'The connection dropped before the server answered. Check whether it went through, then try again.';

/** The server said no to `event`. Its message is for the player and can name people at the table, so error reports leave it out. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly event: string,
  ) {
    super(message);
  }
}

/** No answer came: time ran out, or the connection dropped. The server may or may not have done it. */
export class NoAnswerError extends Error {
  constructor(readonly dropped: boolean) {
    super(dropped ? DROPPED : NO_ANSWER);
    this.name = 'NoAnswerError';
  }
}

/**
 * call() for a socket: emits an event that takes an answer and resolves with
 * the reply; rejects with the server's message when it refuses, and with a
 * NoAnswerError when no answer comes: DROPPED at once when the connection
 * drops after the command went out, NO_ANSWER when the time limit runs out.
 *
 * A command made while offline is left to socket.io, as it always was: it
 * waits until the connection is back, then goes out before any of the page's
 * own reconnect handlers run. So a table move made offline reaches a server
 * that hasn't re-joined this player to the table yet, and is refused instead
 * of being played late, perhaps on a later street. The time limit starts only
 * once the command has gone out, so a page opened while offline still loads.
 * Events without a payload pass none.
 */
export function callerFor<Event extends string = string>(socket: AnswerSocket, limitFor: (event: Event) => number = (e) => SLOW_CALLS[e] ?? CALL_TIMEOUT_MS) {
  return function call<T extends object = object>(event: Event, ...payload: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', sent);
        socket.off('disconnect', dropped);
        done();
      };
      // socket.io forgets a plain answer callback when the connection drops, so listen for the drop here.
      const dropped = () => settle(() => reject(new NoAnswerError(true)));
      const sent = () => {
        socket.off('connect', sent);
        socket.on('disconnect', dropped);
        timer = setTimeout(() => settle(() => reject(new NoAnswerError(false))), limitFor(event));
      };
      const held = socket.sendBuffer.length;
      socket.emit(event, ...payload, (res?: AckResult & T) =>
        settle(() => (res?.ok ? resolve(res) : reject(res && !res.ok && res.error ? new Refusal(res.error, event) : new Error(NO_ANSWER)))),
      );
      // socket.io holds a command when it is offline, or has just found the connection dead (a phone or laptop
      // waking up), and sends what it held before it tells anyone it's connected again.
      if (socket.sendBuffer.length > held) socket.on('connect', sent);
      else sent();
    });
  };
}
