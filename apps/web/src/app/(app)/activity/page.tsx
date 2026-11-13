import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ListActivityResponse, ListExecutionsResponse } from '@vantage/contracts';
import { ActivityView } from '../../../components/activity-view';
import { LoadError } from '../../../components/load-error';
import { serverGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Activity' };

export default async function ActivityPage() {
  const [executions, activity] = await Promise.all([
    serverGet('/v1/executions?limit=50', ListExecutionsResponse),
    serverGet('/v1/ledger/activity?limit=50', ListActivityResponse),
  ]);
  for (const r of [executions, activity]) {
    if (!r.ok && r.kind === 'unauthenticated') redirect('/login?reason=expired');
  }
  if (!executions.ok) return <LoadError failure={executions} what="Activity" />;
  if (!activity.ok) return <LoadError failure={activity} what="Activity" />;
  return (
    <section aria-labelledby="activity-title">
      <h1 id="activity-title" className="mb-3 text-[20px] font-semibold leading-[26px] text-text-0">
        Activity
      </h1>
      <ActivityView executions={executions.data} activity={activity.data} />
    </section>
  );
}
