import { SkeletonRows } from '../../components/ui';

/** The loading state of every private page: fixed-height placeholder rows, so nothing jumps when data arrives. */
export default function Loading() {
  return (
    <div>
      <div
        className="mb-3 h-[26px] w-40 rounded-sm bg-bg-2 motion-safe:animate-pulse"
        aria-hidden="true"
      />
      <SkeletonRows rows={6} label="Loading your data" />
    </div>
  );
}
