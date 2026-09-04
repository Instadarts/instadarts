let counter = 1;

export function generatePlayerId(): string {
  return `p${counter++}`;
}
