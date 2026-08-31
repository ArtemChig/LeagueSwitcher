/**
 * Shrink text just enough to fit its container, instead of truncating it.
 *
 * A Riot ID can be 16 characters plus a 5-character tag, which overflows the card at the
 * display size. Ellipsis was the default answer and it is the wrong one here: the name IS the
 * card — cutting it off is cutting off the one thing being identified, and two smurfs on the
 * same prefix become indistinguishable.
 *
 * So the type scales down to fit, one line, down to a floor that stays comfortably readable.
 * Cards keep a uniform height (wrapping would make them ragged), and short names are untouched
 * at full size, so the grid still reads as one system.
 *
 * Measurement is done against scrollWidth with the element temporarily un-clamped, and re-run
 * on resize via ResizeObserver, so it survives window resizing and the grid reflowing.
 */
import { useLayoutEffect, useRef, useState } from "react";

export interface FitTextOptions {
  /** Size when the text fits comfortably, in rem. */
  max: number;
  /** Never shrink below this, in rem — past it, ellipsis is kinder than a microscopic name. */
  min: number;
  /** Rem to remove per attempt. Small enough to look deliberate, not stepped. */
  step?: number;
}

export function useFitText<T extends HTMLElement>(
  text: string,
  { max, min, step = 0.05 }: FitTextOptions
): { ref: React.RefObject<T | null>; fontSize: string } {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState(max);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      // Start from the top each time: a container that grew should let the text grow back.
      let next = max;
      el.style.fontSize = `${next}rem`;

      // scrollWidth only exceeds clientWidth while the element is actually clamped, which it
      // is — nowrap plus hidden overflow. No layout thrash beyond these few reads.
      let guard = 0;
      while (el.scrollWidth > el.clientWidth && next > min && guard++ < 40) {
        next = Math.max(min, +(next - step).toFixed(3));
        el.style.fontSize = `${next}rem`;
      }
      setSize(next);
    };

    fit();

    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, max, min, step]);

  return { ref, fontSize: `${size}rem` };
}
