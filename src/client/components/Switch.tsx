interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The accessible name. Where a visible label sits beside the switch, that text has to appear in
   * here too, or somebody dictating "board camera" hits a control the browser calls something else.
   */
  label: string;
  disabled?: boolean;
  title?: string;
}

/**
 * An on/off switch, for settings that take effect the moment they are touched.
 *
 * A button carrying `role="switch"` rather than a checkbox styled into a track: the usual trick —
 * a visually hidden `<input>` under a decorative span — gives a control that is a pixel wide and
 * covered by its own decoration, which neither a pointer nor a test can reliably hit.
 */
export function Switch({ checked, onChange, label, disabled = false, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
        disabled
          ? 'bg-gray-800 cursor-not-allowed'
          : checked
            ? 'bg-green-600 hover:bg-green-500'
            : 'bg-gray-700 hover:bg-gray-600'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform ${
          disabled ? 'bg-gray-600' : 'bg-white'
        } ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  );
}
