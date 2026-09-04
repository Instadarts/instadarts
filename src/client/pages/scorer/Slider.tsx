import { Group, Slider as MantineSlider, Stack, Text } from '@mantine/core';

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
    <Stack gap={6} opacity={disabled ? 0.5 : 1}>
      <Group justify="space-between" gap="sm">
        <Text fz="sm">{label}</Text>
        <Text fz="sm" ff="monospace" c="dimmed">{format(value)}</Text>
      </Group>
      <MantineSlider
        thumbLabel={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={onChange}
        thumbSize={20}
      />
      {hint && <Text fz="xs" c="dimmed">{hint}</Text>}
    </Stack>
  );
}
