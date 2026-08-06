interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}

/** A labelled range with its value read out beside it. */
export function Slider({ label, value, min, max, step, format, onChange, disabled, hint }: SliderProps) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${disabled ? 'opacity-50' : ''}`}>
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-gray-400">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </label>
  );
}
