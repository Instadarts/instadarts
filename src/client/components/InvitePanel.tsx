import { CopyableText } from './CopyableText';

interface InvitePanelProps {
  inviteCode: string | null;
  userCount: number;
  isFull: boolean;
  maxPlayers?: number;
}

export function InvitePanel({ inviteCode, userCount, isFull, maxPlayers = 2 }: InvitePanelProps) {
  if (isFull || (maxPlayers <= 2 && userCount >= 2)) {
    return (
      <div className="w-80 mb-6 text-center">
        <p className="text-green-400 text-sm font-semibold">
          {userCount <= 2 ? '✓ Opponent connected' : '✓ Lobby is full'}
        </p>
      </div>
    );
  }

  if (!inviteCode) return null;

  return (
    <div className="w-80 mb-6 text-center">
      {userCount > 1 && (
        <p className="text-green-400 text-sm font-semibold mb-2">
          {userCount === 2 ? '✓ Opponent connected' : `✓ ${userCount - 1} other users connected`}
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
      <p className="text-gray-500 text-xs">
        Or share:{' '}
        <CopyableText
          value={`${window.location.origin}/lobby/join/${inviteCode}`}
          className="text-blue-400 hover:underline"
        >
          /lobby/join/{inviteCode}
        </CopyableText>
      </p>
    </div>
  );
}
