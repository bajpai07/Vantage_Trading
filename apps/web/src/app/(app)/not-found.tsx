import Link from 'next/link';

/** A page or instrument that does not exist, inside the signed-in app (so the header and search stay available). */
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl py-10 text-center" data-testid="not-found">
      <h1 className="text-[20px] font-semibold text-text-0">Not found</h1>
      <p className="mt-2 text-text-2">
        We could not find that instrument or page. Check the ticker and try the search.
      </p>
      <p className="mt-4">
        <Link href="/portfolio">Go to your portfolio</Link>
      </p>
    </div>
  );
}
