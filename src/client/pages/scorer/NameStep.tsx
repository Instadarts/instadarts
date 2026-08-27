// Step one of setting a phone up: what to call it.
//
// First because it is the only step somebody can answer without the phone being on its mount, and
// because it is the name the *other* screen will use — the owner picking a board camera sees this,
// not a device id. A phone that says "Board camera" or "Left board" is one somebody can point at
// from across the room; "Camera 2" is one they have to guess at.
//
// Nothing here is required. A phone left nameless is listed by its position, which is a worse answer
// than a name and a perfectly good one.

import { Button, Text, TextInput } from '@mantine/core';

interface NameStepProps {
  name: string;
  /** Per keystroke: this is what saves it. Same path the scoring screen's field uses. */
  onRename: (name: string) => void;
  /** Forward, which also publishes the name to whoever this device is paired to. */
  onContinue: () => void;
}

/** The scoring screen's field caps the name at this, and the two must not disagree. */
const MAX_LENGTH = 20;

export function NameStep({ name, onRename, onContinue }: NameStepProps) {
  return (
    <>
      <Text fz="sm" c="dimmed">
        Give this scoring device a name.
      </Text>

      <TextInput
        type="text"
        value={name}
        onChange={(event) => onRename(event.currentTarget.value.slice(0, MAX_LENGTH))}
        // Enter is what a phone keyboard offers instead of reaching for the button below it.
        onKeyDown={(event) => event.key === 'Enter' && onContinue()}
        placeholder="Board camera"
        autoFocus
        data-testid="onboarding-name"
      />

      <Button
        onClick={onContinue}
        data-testid="onboarding-name-continue"
        style={{ alignSelf: 'flex-start' }}
      >
        Continue
      </Button>
    </>
  );
}
