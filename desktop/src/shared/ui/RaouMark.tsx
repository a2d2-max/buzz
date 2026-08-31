export function RaouMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 32 24"
    >
      <path
        d="M3 4h9l4 4h13M3 12h26M3 20h9l4-4h13"
        stroke="currentColor"
        strokeLinecap="square"
        strokeWidth="1.5"
      />
      <circle cx="3" cy="4" fill="currentColor" r="2" />
      <circle cx="3" cy="12" fill="currentColor" r="2" />
      <circle cx="3" cy="20" fill="currentColor" r="2" />
      <path d="M25 5v14M29 5v14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
