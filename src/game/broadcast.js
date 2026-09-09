import { sendInterrupt } from '../net/session.js';

// Everyone who has finished logging in.
export function playingSessions(sessions) {
  return [...sessions.values()].filter((session) => session.state === 'playing');
}

export function sessionsInRoom(sessions, roomId, except = null) {
  return playingSessions(sessions).filter(
    (session) => session.roomId === roomId && session !== except
  );
}

// Send an unsolicited line to a room, usually to everyone but the person who
// caused it — they get their own wording.
export function toRoom(sessions, roomId, text, except = null) {
  for (const session of sessionsInRoom(sessions, roomId, except)) {
    sendInterrupt(session, text);
  }
}

export function toAll(sessions, text, except = null) {
  for (const session of playingSessions(sessions)) {
    if (session !== except) sendInterrupt(session, text);
  }
}
