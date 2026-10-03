import type { SVGProps } from 'react';

function Icon({ children, size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const ChevronLeft = (p: P) => (
  <Icon {...p}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);
export const ChevronRight = (p: P) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);
export const Check = (p: P) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const Plus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const Close = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const Folder = (p: P) => (
  <Icon {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
  </Icon>
);
export const Send = (p: P) => (
  <Icon {...p}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </Icon>
);
export const Stop = (p: P) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);
export const Play = (p: P) => (
  <Icon {...p}>
    <path d="M7 5v14l11-7z" />
  </Icon>
);
export const Trash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Icon>
);
export const ArrowDown = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);
export const Terminal = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m7 10 3 2-3 2" />
    <path d="M12 15h5" />
  </Icon>
);
