const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  sessions: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5",
  key: "M3 15.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M10.7 12.3l9.8-9.8M17 6l3 3M14.5 8.5l2 2",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z",
  plus: "M12 5v14M5 12h14",
  copy: "M9 11a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  check: "M20 6 9 17l-5-5",
  external: "M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  down: "M12 5v14M19 12l-7 7-7-7",
  up: "M12 19V5M5 12l7-7 7 7",
  close: "M18 6 6 18M6 6l12 12",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  clock: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 3",
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h16V9H5a2 2 0 0 1-2-2zM17 14h.01",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  arrow: "M5 12h14M13 5l7 7-7 7",
  undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8",
  menu: "M4 6h16M4 12h16M4 18h16",
  sun: "M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  moon: "M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z",
  monitor: "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM8 21h8M12 17v4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="icon"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <defs>
        <linearGradient id="br-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#br-logo)" />
      <path d="M10 9h7a4 4 0 0 1 0 8h-7zM10 17h8a4 4 0 0 1 0 8h-8z" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}
