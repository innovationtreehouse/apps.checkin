"use client";

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { NavLink, Stack, Text, TextInput, Title } from '@mantine/core';
import { PageContainer } from '@/components/ui/PageContainer';
import { IconSearch } from '@tabler/icons-react';
import { PAGES } from '@/components/pageRegistry';
import { useTodoCounts } from '@/hooks/useTodoCounts';

export default function IndexPage() {
  const { data: session } = useSession();
  const signedIn = !!session;
  const user = session?.user;
  // Computed-role gates (leads ≥1 program) read from the same payload the nav uses.
  const counts = useTodoCounts(signedIn);
  const [query, setQuery] = useState('');

  const visible = useMemo(
    () => PAGES.filter((p) => p.visible(user, counts)),
    [user, counts],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? visible
      : visible.filter((p) =>
          `${p.label} ${p.section} ${p.keywords ?? ''}`.toLowerCase().includes(q),
        );
    return [...filtered].sort((a, b) => a.label.localeCompare(b.label));
  }, [visible, query]);

  return (
    <PageContainer>
      <Title order={2} mb="md">Index</Title>
      <TextInput
        placeholder="Search pages…"
        leftSection={<IconSearch size={16} />}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        data-autofocus
        autoFocus
        mb="lg"
      />
      {matches.length === 0 ? (
        <Text c="dimmed">No pages match “{query}”.</Text>
      ) : (
        <Stack gap={0}>
          {matches.map((p) => (
            <NavLink
              key={p.href}
              component={Link}
              href={p.href}
              label={p.label}
              description={p.href}
            />
          ))}
        </Stack>
      )}
    </PageContainer>
  );
}
