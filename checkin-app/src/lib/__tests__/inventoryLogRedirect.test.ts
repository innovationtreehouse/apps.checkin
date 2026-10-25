import nextConfig from '../../../next.config';

describe('retired Applied Deltas page', () => {
  it('redirects /inventory/received-deltas to the inventory log, by receipt or donation', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({
      source: '/inventory/received-deltas',
      destination: '/inventory/inventory-log?view=applies',
      permanent: true,
    });
  });
});
