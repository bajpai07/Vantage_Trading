import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ListOrdersResponse } from '@vantage/contracts';
import { LoadError } from '../../../components/load-error';
import { OrdersList } from '../../../components/orders-list';
import { getWebConfig } from '../../../lib/config';
import { serverGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Orders' };

export default async function OrdersPage() {
  const [orders, open] = await Promise.all([
    serverGet('/v1/orders?limit=50', ListOrdersResponse),
    serverGet('/v1/orders?status=open&limit=100', ListOrdersResponse),
  ]);
  if (!orders.ok) {
    if (orders.kind === 'unauthenticated') redirect('/login?reason=expired');
    return <LoadError failure={orders} what="Orders" />;
  }
  if (!open.ok) {
    if (open.kind === 'unauthenticated') redirect('/login?reason=expired');
    return <LoadError failure={open} what="Open orders" />;
  }
  return (
    <section aria-labelledby="orders-title">
      <h1 id="orders-title" className="mb-3 text-[20px] font-semibold leading-[26px] text-text-0">
        Orders
      </h1>
      <OrdersList initial={orders.data} open={open.data} pollMs={getWebConfig().ordersPollMs} />
    </section>
  );
}
