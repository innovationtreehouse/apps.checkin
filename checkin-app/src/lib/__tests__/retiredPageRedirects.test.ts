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

describe('split Proposals page', () => {
  it('redirects /catalog/proposals to Item Reference Proposals', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({
      source: '/catalog/proposals',
      destination: '/catalog/item-reference-proposals',
      permanent: true,
    });
  });
});
