import { Button, Card, Group, Text, Title } from "@mantine/core";

export function MergeSuccess({ onMergeMore, onBack }: {
  onMergeMore: () => void;
  onBack: () => void;
}) {
  return (
    <Card withBorder radius="md" padding="xl" ta="center" style={{ borderColor: "var(--mantine-color-green-6)" }} maw={1000} mx="auto">
      <Title order={2} c="green" mb="md">Merge Successful!</Title>
      <Text mb="lg">The participants have been successfully merged.</Text>
      <Group justify="center">
        <Button variant="default" onClick={onMergeMore}>Merge More</Button>
        <Button onClick={onBack}>Back to Participants</Button>
      </Group>
    </Card>
  );
}
