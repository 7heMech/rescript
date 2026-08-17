/**
 * Signal-strength bars for the model rows, drawn here rather than taken from
 * lucide: `SignalLow` and friends omit the bars above the level, so the three
 * model rows would each get a differently-shaped, differently-sized glyph.
 * These always draw all three bars and fade the inactive ones, so the rows share
 * one silhouette and read as "level N of 3".
 */

export type SignalBarsProps = {
  size?: number | string;
  className?: string;
};

/** x position and top y of each bar, shortest first. Bars sit on y = 19. */
const BARS: ReadonlyArray<{ x: number; top: number }> = [
  { x: 5.75, top: 14.5 },
  { x: 12, top: 10.25 },
  { x: 18.25, top: 6 },
];

const BASELINE = 19;
/** Matches the 2px stroke of the lucide icons beside it, plus round caps. */
const STROKE = 2.5;
const INACTIVE_OPACITY = 0.25;

function SignalBars({
  level,
  size = 24,
  className,
}: SignalBarsProps & { level: 1 | 2 | 3 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      {BARS.map((bar, i) => (
        <line
          key={bar.x}
          x1={bar.x}
          y1={bar.top}
          x2={bar.x}
          y2={BASELINE}
          opacity={i < level ? 1 : INACTIVE_OPACITY}
        />
      ))}
    </svg>
  );
}

export function SignalBarsLow(props: SignalBarsProps) {
  return <SignalBars level={1} {...props} />;
}

export function SignalBarsMedium(props: SignalBarsProps) {
  return <SignalBars level={2} {...props} />;
}

export function SignalBarsHigh(props: SignalBarsProps) {
  return <SignalBars level={3} {...props} />;
}
