import type { ReactNode, SVGProps } from "react";

/**
 * A tiny, consistent icon set: 16×16 grid, 1.5px stroke (kept at 1.5px at any size), currentColor.
 * Filled glyphs (play, pause, dot) use currentColor fill so they share the same optical weight.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Icon({ size = 16, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      {children}
    </svg>
  );
}

const ns = { vectorEffect: "non-scaling-stroke" } as const;

export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

export const ChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M10 3.5 5.5 8 10 12.5" />
  </Icon>
);

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
);

export const ArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />
  </Icon>
);

export const Play = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M5 3.2v9.6a.5.5 0 0 0 .76.43l7.4-4.8a.5.5 0 0 0 0-.86l-7.4-4.8A.5.5 0 0 0 5 3.2Z" fill="currentColor" />
  </Icon>
);

export const Pause = (p: IconProps) => (
  <Icon {...p}>
    <rect {...ns} x="4" y="3" width="2.5" height="10" rx=".5" fill="currentColor" />
    <rect {...ns} x="9.5" y="3" width="2.5" height="10" rx=".5" fill="currentColor" />
  </Icon>
);

/** Back to the start: bar + left triangle. */
export const SkipStart = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M3.5 3v10" />
    <path {...ns} d="M12.5 3.6v8.8a.5.5 0 0 1-.78.42L6 8.42a.5.5 0 0 1 0-.84l5.72-4.4a.5.5 0 0 1 .78.42Z" fill="currentColor" />
  </Icon>
);

/** To the end: right triangle + bar. */
export const SkipEnd = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M12.5 3v10" />
    <path {...ns} d="M3.5 3.6v8.8a.5.5 0 0 0 .78.42L10 8.42a.5.5 0 0 0 0-.84L4.28 3.18a.5.5 0 0 0-.78.42Z" fill="currentColor" />
  </Icon>
);

export const Dot = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const Circle = (p: IconProps) => (
  <Icon {...p}>
    <circle {...ns} cx="8" cy="8" r="4.5" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Icon>
);

/** Anchor marker: the same diamond the timeline uses for anchor nodes. */
export const Diamond = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M8 3 13 8 8 13 3 8Z" />
  </Icon>
);

export const Settings = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
    <circle {...ns} cx="11" cy="4.5" r="1.5" />
    <circle {...ns} cx="5" cy="11.5" r="1.5" />
  </Icon>
);

/** A window with a sidebar: the two-pane layout (turn list beside the selected turn). */
export const Sidebar = (p: IconProps) => (
  <Icon {...p}>
    <rect {...ns} x="2" y="3" width="12" height="10" rx="2" />
    <path {...ns} d="M6.5 3v10" />
  </Icon>
);

export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle {...ns} cx="7" cy="7" r="4.25" />
    <path {...ns} d="M10.25 10.25 13.5 13.5" />
  </Icon>
);

export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect {...ns} x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path {...ns} d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
  </Icon>
);

export const Trash = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.1a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4L12 4.5" />
  </Icon>
);

export const Minus = (p: IconProps) => (
  <Icon {...p}>
    <path {...ns} d="M4 8h8" />
  </Icon>
);
