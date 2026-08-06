interface InvitePanelProps {
  inviteCode: string | null;
  remoteConnected: boolean;
}

export function InvitePanel({ inviteCode, remoteConnected }: InvitePanelProps) {
  if (remoteConnected) {
    return (
      <div className="w-80 mb-6 text-center">
        <p className="text-green-400 text-sm font-semibold">✓ Opponent connected</p>
      </div>
    );
  }

  if (!inviteCode) return null;

  return (
    <div className="w-80 mb-6 text-center">
      <p className="text-gray-400 text-sm mb-2">Invite Code</p>
      <div className="flex items-center justify-center gap-2 mb-2">
        <code className="select-text text-2xl font-mono tracking-widest text-green-400 bg-gray-800 px-4 py-2 rounded">
          {inviteCode}
        </code>
        <button
          onClick={() => navigator.clipboard.writeText(inviteCode)}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
          title="Copy to clipboard"
        >
          📋
        </button>
      </div>
      <p className="text-gray-500 text-xs">
        Or share:{' '}
        <a
          href={`/lobby/join/${inviteCode}`}
          className="text-blue-400 hover:underline select-text"
          onClick={(e) => {
            e.preventDefault();
            navigator.clipboard.writeText(
              `${window.location.origin}/lobby/join/${inviteCode}`
            );
          }}
        >
          /lobby/join/{inviteCode}
        </a>
      </p>
    </div>
  );
}
