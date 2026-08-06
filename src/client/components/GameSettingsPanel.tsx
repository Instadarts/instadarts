import type { GameSettings } from '../../shared/types';

interface GameSettingsPanelProps {
  settings: GameSettings;
  canEdit: boolean;
  onChange: (settings: GameSettings) => void;
}

export function GameSettingsPanel({ settings, canEdit, onChange }: GameSettingsPanelProps) {
  return (
    <div className="w-80 mb-6">
      <h3 className="text-gray-400 text-sm uppercase mb-2">
        Settings
        {!canEdit && <span className="text-gray-600 ml-1">(read-only)</span>}
      </h3>
      <div className="space-y-3 bg-gray-900 rounded-lg p-4">
        <div>
          <label className="text-gray-400 text-sm">Starting Score</label>
          <select
            value={settings.startScore}
            onChange={(e) => onChange({ ...settings, startScore: Number(e.target.value) })}
            disabled={!canEdit}
            className="w-full mt-1 px-3 py-1 bg-gray-800 border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value={301}>301</option>
            <option value={501}>501</option>
            <option value={701}>701</option>
          </select>
        </div>

        <label className={`flex items-center gap-3 ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}>
          <input
            type="checkbox"
            checked={settings.doubleIn}
            onChange={(e) => onChange({ ...settings, doubleIn: e.target.checked })}
            disabled={!canEdit}
            className="w-4 h-4 accent-green-500 disabled:opacity-50"
          />
          <span className="text-gray-300">Double In</span>
        </label>

        <label className={`flex items-center gap-3 ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}>
          <input
            type="checkbox"
            checked={settings.doubleOut}
            onChange={(e) => onChange({ ...settings, doubleOut: e.target.checked })}
            disabled={!canEdit}
            className="w-4 h-4 accent-green-500 disabled:opacity-50"
          />
          <span className="text-gray-300">Double Out</span>
        </label>
      </div>
    </div>
  );
}
