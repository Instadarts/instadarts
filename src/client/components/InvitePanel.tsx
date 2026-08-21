import type { ReactNode } from 'react';
import { CopyableText } from './CopyableText';

interface InvitePanelProps {
  inviteCode: string | null;
  /** Users in the lobby, the host included. */
  userCount: number;
  /** The lobby's effective cap — the deployment's, narrowed by the game mode's. */
  maxPlayers: number;
  /**
   * Whether anybody else could still take a place: the roster is full, or the lobby already holds
   * as many users as it may. Either way the code has nothing left to buy, so it is not shown.
   */
  isClosed: boolean;
}

export function InvitePanel({ inviteCode, userCount, maxPlayers, isClosed }: InvitePanelProps) {
  if (isClosed) {
    // "Opponent" is only honest where a lobby holds two of them and was only ever going to: a
    // five-player lobby that filled up has no opponent, it has a roster.
    const oneOnOne = maxPlayers <= 2 && userCount >= 2;
    return (
      <Panel>
        <p className="text-green-400 text-sm font-semibold">
          {oneOnOne ? '✓ Opponent connected' : '✓ Lobby is full'}
        </p>
      </Panel>
    );
  }

  if (!inviteCode) return null;

  return (
    <Panel>
      {userCount > 1 && (
        <p className="text-green-400 text-sm font-semibold mb-2">
          {`✓ ${userCount - 1} other ${userCount === 2 ? 'user' : 'users'} connected`}
        </p>
      )}
      <p className="text-gray-400 text-sm mb-2">Invite Code</p>
      {/* The code and the clipboard glyph are one target rather than two: the code is the obvious
          thing to click, the glyph is what says it can be clicked, and separating them made the
          affordance the smaller half. */}
      <div className="flex items-center justify-center mb-2">
        <CopyableText value={inviteCode} className="flex items-center gap-2 group">
          {/* Stays a `<code>`: it is one semantically, and it is the hook seven e2e specs read the
              invite code out of. */}
          <code className="text-2xl font-mono tracking-widest text-green-400 bg-gray-800 px-4 py-2 rounded">
            {inviteCode}
          </code>
          {/* Same `text-2xl` and `py-2` as the code, so the two boxes are exactly as tall as each
              other; `px-2` keeps this one as narrow as a single glyph needs. */}
          <span className="px-2 py-2 bg-gray-700 group-hover:bg-gray-600 rounded text-2xl transition-colors">
            📋
          </span>
        </CopyableText>
      </div>
      <p className="text-gray-500 text-xs break-words">
        Or share:{' '}
        <CopyableText
          value={`${window.location.origin}/lobby/join/${inviteCode}`}
          className="text-blue-400 hover:underline"
        >
          /lobby/join/{inviteCode}
        </CopyableText>
      </p>
    </Panel>
  );
}

/**
 * A titled card, the same one the roster and the settings blocks use.
 *
 * Everything the panel says lives inside the single card element — including, whichever branch drew
 * it, the code and the words "Invite Code" as siblings. Seven e2e specs read the code as "the
 * `<code>` next to that label", so a wrapper between the two would break them.
 */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="w-full">
      <h3 className="text-gray-400 text-sm uppercase mb-2">Invite</h3>
      <div className="bg-gray-900 rounded-lg p-4 text-center">{children}</div>
    </div>
  );
}
