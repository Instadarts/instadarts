import { Checkbox, NativeSelect, NumberInput, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { SettingsField, SettingsValue } from '../../shared/settings';

interface SettingsFieldsProps {
  title?: string;
  fields: SettingsField[];
  values: Record<string, SettingsValue | undefined>;
  canEdit: boolean;
  onChange: (key: string, value: SettingsValue) => void;
  children?: ReactNode;
}

export function SettingsFields({ title, fields, values, canEdit, onChange, children }: SettingsFieldsProps) {
  return (
    <Stack gap="md">
      {title && (
        <Text fz="sm" tt="uppercase" c="dimmed" fw={700}>
          {title}{!canEdit && <Text span c="gray.6"> (read-only)</Text>}
        </Text>
      )}
      {children}
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key]}
          canEdit={canEdit}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </Stack>
  );
}

interface FieldProps {
  field: SettingsField;
  value: SettingsValue | undefined;
  canEdit: boolean;
  onChange: (value: SettingsValue) => void;
}

function Field({ field, value, canEdit, onChange }: FieldProps) {
  if (field.kind === 'toggle') {
    return (
      <Checkbox
        label={field.label}
        checked={value === true}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={!canEdit}
      />
    );
  }

  if (field.kind === 'select') {
    return (
      <NativeSelect
        label={field.label}
        value={typeof value === 'string' ? value : field.options[0].value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={!canEdit}
        data={field.options.map((option) => ({ value: option.value, label: option.label }))}
      />
    );
  }

  const numeric = typeof value === 'number' ? value : field.min;
  if (field.options) {
    return (
      <NativeSelect
        label={field.label}
        value={String(numeric)}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        disabled={!canEdit}
        data={field.options.map((option) => ({ value: String(option.value), label: option.label }))}
      />
    );
  }

  return (
    <NumberInput
      label={field.label}
      value={numeric}
      min={field.min}
      max={field.max}
      allowDecimal={false}
      onChange={(next) => typeof next === 'number' && onChange(next)}
      disabled={!canEdit}
    />
  );
}
