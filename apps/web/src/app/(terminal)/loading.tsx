import { TerminalSkeleton } from '../../components/terminal-skeleton';

/** The loading state of the terminal: reserved dimensions for every region, so nothing jumps when data arrives (D-105). */
export default function Loading() {
  return <TerminalSkeleton />;
}
