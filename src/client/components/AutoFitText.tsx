import { Box, Text } from '@mantine/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface AutoFitTextProps {
  text: string;
  color: string;
  fontFamily?: string;
  fontWeight?: number;
  lineHeight?: number;
  minimumFontSize?: number;
  style?: CSSProperties;
}

const EDGE_TOLERANCE = 1;

/** A single unwrapped line, centered and enlarged until either available axis is exhausted. */
export function AutoFitText({
  text,
  color,
  fontFamily,
  fontWeight,
  lineHeight = 1.2,
  minimumFontSize = 8,
  style,
}: AutoFitTextProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(minimumFontSize);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const element = textRef.current;
    if (!host || !element) return;

    const availableWidth = host.clientWidth - EDGE_TOLERANCE;
    const availableHeight = host.clientHeight - EDGE_TOLERANCE;
    if (availableWidth <= 0 || availableHeight <= 0) return;

    let low = minimumFontSize;
    let high = Math.max(low, Math.floor(availableHeight / lineHeight));
    let best = low;

    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      element.style.fontSize = `${candidate}px`;
      const bounds = element.getBoundingClientRect();

      if (bounds.width <= availableWidth && bounds.height <= availableHeight) {
        best = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }

    element.style.fontSize = `${best}px`;
    setFontSize((current) => current === best ? current : best);
  }, [lineHeight, minimumFontSize, text]);

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
      ref={hostRef}
      style={{
        display: 'grid',
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        placeItems: 'center',
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
