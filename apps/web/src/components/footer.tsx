/** Shown on every page: this is a simulator, not a brokerage (PRD, ARCHITECTURE section 8). */
export function Footer() {
  return (
    <footer
      data-testid="virtual-money-notice"
      className="mt-auto border-t border-line bg-bg-1 px-4 pb-16 pt-3 text-center text-[12px] text-text-2 md:pb-3"
    >
      Virtual money — not real trading. VANTAGE is a simulator, not a brokerage.
    </footer>
  );
}
