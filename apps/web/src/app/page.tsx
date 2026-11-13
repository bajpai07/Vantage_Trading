import { redirect } from 'next/navigation';

// The proxy already sends signed-in users to the portfolio and everyone else to the login page; this is the fallback.
export default function Home(): never {
  redirect('/portfolio');
}
