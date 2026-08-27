import { Box, Group } from '@mantine/core';
import { AutoFitText } from './AutoFitText';
import markSvg from './mark.svg?raw';

/**
 * The mark, inlined from `mark.svg` so it takes the tint of whatever is showing it.
 *
 * `dangerouslySetInnerHTML` is safe here and is the point: the markup is a file in this repository
 * that Vite reads at build time, not anything that arrives at runtime. Inlining rather than `<img>`
 * is what lets `currentColor` reach it — an image is a separate document and inherits nothing.
 */
export function Mark({ size = '1.15em' }: { size?: string }) {
  return (
    <Box
      component="span"
      w={size}
      h={size}
      display="inline-flex"
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}

export interface WordmarkProps {
  /** Size of the word. The mark is sized in `em`, so it follows. */
  fz?: string;
  /**
   * Shrink to fit the parent instead of taking `fz`, up to this many pixels.
   *
   * The home page needs this and the two headers do not: at `3rem` the wordmark is a fixed 434 px
   * and the card around it is narrower than that under about 470 px of viewport, so it used to be
   * clipped by the card's own overflow rather than truncated. `AutoFitText` measures the parent and
   * picks a size, which is the same answer the match headline already uses.
   */
  fitTo?: number;
  /** `h1` where the page wants a heading. Its text stays exactly "InstaDarts". */
  component?: 'h1' | 'span';
  /** Overrides the brand tint. The screensaver wants it dim against black. */
  c?: string;
}

/**
 * The application's name, in the one place it is decided.
 *
 * It appears in the frontend header, the scoring device's header, on the home page and on the
 * screensaver, and until now the first two were duplicated markup that had to be edited twice. The
 * treatment — the mark, uppercase, the tracking that stops uppercase from looking cramped — is the
 * identity, so it lives here rather than in four sets of props.
 *
 * `tt="uppercase"` is presentation only: the text node stays "InstaDarts", which is what the
 * accessible name and several specs read.
 */
export function Wordmark({
  fz = 'lg',
  fitTo,
  component = 'span',
  c = 'var(--instadarts-accent)',
}: WordmarkProps) {
  // Everything inside is phrasing content, and the mark and the tracking are sized in `em`, so they
  // scale from one font size whether that comes from `fz` or from a fit. The gap is Mantine's
  // `Group` default and is deliberately *not* em — it is a fixed 1rem at all four sizes, which reads
  // tighter on the home page's large title and looser on the screensaver's small one.
  const lockup = (
    <Group component="span" wrap="nowrap" miw={0} fz={fitTo === undefined ? fz : undefined}>
      <Mark />
      {/* A `Box` and not a `Text`: `Text` applies its own `md` font size rather than inheriting, so
          inside a fit only the mark and the gap would scale and the word would stay at 16 px.
          Truncation is `Text`'s other job, and has to come back by hand — without it the header
          wordmark cannot shrink and pushes the camera and settings controls off a narrow screen.
          It costs the fit nothing: there the line is measured at its natural width anyway. */}
      <Box
        component="span"
        fw={800}
        lts="0.06em"
        tt="uppercase"
        miw={0}
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        InstaDarts
      </Box>
    </Group>
  );

  if (fitTo === undefined) {
    return (
      <Box component={component} c={c} miw={0} style={{ display: 'inline-flex', margin: 0 }}>
        {lockup}
      </Box>
    );
  }

  return (
    <AutoFitText
      text="InstaDarts"
      color={c}
      component={component === 'h1' ? 'h1' : 'div'}
      fitHeight={false}
      fontWeight={800}
      grow={false}
      lineHeight={1.15}
      maximumFontSize={fitTo}
      minimumFontSize={14}
    >
      {lockup}
    </AutoFitText>
  );
}
