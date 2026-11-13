/** The wordmark (Inter 600, uppercase, +0.08em) with the mark: a V of two ascending strokes, blue then violet. */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M3 4 L10 17" className="stroke-accent" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M17 4 L10 17" className="stroke-violet" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className="text-[14px] font-semibold uppercase tracking-[0.08em] text-text-0">
        Vantage
      </span>
    </span>
  );
}
