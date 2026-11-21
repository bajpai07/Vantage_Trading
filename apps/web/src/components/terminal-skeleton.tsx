/**
 * The terminal while the server renders it (D-105): every region has its final dimensions, so nothing moves when data arrives.
 * Decoration for sighted users; the live region tells assistive technology that the page is loading.
 */
export function TerminalSkeleton() {
  const block = 'rounded-md bg-bg-2 motion-safe:animate-pulse';
  return (
    <div data-testid="terminal-skeleton" className="px-4 py-4 lg:px-6">
      <p role="status" className="sr-only">
        Loading the trading terminal
      </p>
      <div aria-hidden="true" className="grid gap-4 xl:grid-cols-[270px_minmax(0,1fr)_330px]">
        <div className={`${block} hidden h-[460px] xl:block`} />
        <div className="space-y-3">
          <div className={`${block} h-16`} />
          <div className={`${block} h-9`} />
          <div className={`${block} h-[380px]`} />
          <div className={`${block} h-14`} />
        </div>
        <div className={`${block} h-[560px]`} />
      </div>
    </div>
  );
}
