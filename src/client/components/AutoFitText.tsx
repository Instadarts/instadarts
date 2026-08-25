import { Box, Text } from '@mantine/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface AutoFitTextProps {
  text: string;
  color: string;
  component?: 'div' | 'h2';
  fitHeight?: boolean;
  fontFamily?: string;
  fontWeight?: number;
  horizontalAlign?: 'start' | 'center' | 'end';
  lineHeight?: number;
  maximumFontSize?: number;
  minimumFontSize?: number;
  style?: CSSProperties;
}

const EDGE_TOLERANCE = 1;

/** A single unwrapped line, enlarged until its configured available axes are exhausted. */
export function AutoFitText({
  text,
  color,
  component = 'div',
  fitHeight = true,
  fontFamily,
  fontWeight,
  horizontalAlign = 'center',
  lineHeight = 1.2,
  maximumFontSize,
  minimumFontSize = 8,
  style,
}: AutoFitTextProps) {
  const hostRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(minimumFontSize);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const element = textRef.current;
    if (!host || !element) return;

    const availableWidth = host.clientWidth - EDGE_TOLERANCE;
    const availableHeight = host.clientHeight - EDGE_TOLERANCE;
    if (availableWidth <= 0 || (fitHeight && availableHeight <= 0)) return;

    let low = minimumFontSize;
    const naturalMaximum = fitHeight
      ? Math.floor(availableHeight / lineHeight)
      : Math.ceil(availableWidth * 2);
    let high = Math.max(low, Math.floor(Math.min(maximumFontSize ?? naturalMaximum, naturalMaximum)));
    let best = low;

    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      element.style.fontSize = `${candidate}px`;
      const bounds = element.getBoundingClientRect();

      if (bounds.width <= availableWidth && (!fitHeight || bounds.height <= availableHeight)) {
        best = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }

    element.style.fontSize = `${best}px`;
    setFontSize((current) => current === best ? current : best);
    // `fontFamily` and `fontWeight` belong here: both are applied to the element being measured and
    // both change how wide it comes out, so a fit computed under the old ones is the wrong answer.
    // `style` is not, although it can do the same through letter spacing or a transform — callers
    // pass an object literal, so depending on it would refit on every render and memoizing nothing.
    // A caller whose `style` changes the metrics has to change something here too.
  }, [fitHeight, fontFamily, fontWeight, lineHeight, maximumFontSize, minimumFontSize, text]);

  useLayoutEffect(() => {
    fit();
    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver(fit);
    observer.observe(host);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <Box
      component={component}
      ref={(element) => { hostRef.current = element; }}
      style={{
        alignItems: 'center',
        display: 'grid',
        flex: '1 1 0',
        justifyItems: horizontalAlign,
        margin: 0,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <Text
        ref={textRef}
        component="span"
        c={color}
        ff={fontFamily}
        fw={fontWeight}
        style={{
          ...style,
          display: 'block',
          fontSize,
          lineHeight,
          whiteSpace: 'nowrap',
          width: 'max-content',
        }}
      >
        {text}
      </Text>
    </Box>
  );
}
