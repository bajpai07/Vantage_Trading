import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-10 text-center"
    >
      <h1 className="text-[20px] font-semibold text-text-0">Page not found</h1>
      <p className="mt-2 text-text-2">That page does not exist.</p>
      <p className="mt-4">
        <Link href="/portfolio">Go to your portfolio</Link>
      </p>
    </main>
  );
}
