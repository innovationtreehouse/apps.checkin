"use client";

import { Card, Group, List, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { BadgeScanChart, ConfigHealthBox, CronRunsBox, KioskHeartbeatBox, SReadDiagnosticsBox, SystemVersionBox } from "@/components/admin/SystemHealthPanels";

export default function SystemStatusHealthPage() {
  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder radius="md" padding="lg">
          <Title order={4} mb="md">Quick Stats</Title>
          <SimpleGrid cols={2}>
            <Card withBorder radius="sm" padding="sm" ta="center">
              <Text fz="xl" fw={800}>--</Text>
              <Text size="xs" c="dimmed" tt="uppercase">Active Guests</Text>
            </Card>
            <Card withBorder radius="sm" padding="sm" ta="center">
              <Text fz="xl" fw={800}>--</Text>
              <Text size="xs" c="dimmed" tt="uppercase">Check-ins Today</Text>
            </Card>
          </SimpleGrid>
          <Text size="sm" c="dimmed" mt="md">
            Real-time stats are coming soon in the next update.
          </Text>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Title order={4} mb="md">System Health</Title>
          <List spacing="xs" listStyleType="none">
            <List.Item>
              <Group justify="space-between">
                <span>Database</span>
                <Text c="green">● Operational</Text>
              </Group>
            </List.Item>
            <List.Item>
              <Group justify="space-between">
                <span>RFID Gateway</span>
                <Text c="green">● Connected</Text>
              </Group>
            </List.Item>
            <List.Item>
              <Group justify="space-between">
                <span>Last Backup</span>
                <Text c="dimmed">2 hours ago</Text>
              </Group>
            </List.Item>
          </List>
        </Card>
      </SimpleGrid>

      <ConfigHealthBox />

      <CronRunsBox />

      <SReadDiagnosticsBox />

      <SystemVersionBox />

      <KioskHeartbeatBox />

      <BadgeScanChart />
    </Stack>
  );
}
