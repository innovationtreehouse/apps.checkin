"use client";

import { Alert, type AlertProps, Text } from "@mantine/core";
import { IconUsersGroup } from "@tabler/icons-react";

/**
 * The single place the "not someone in your own family" rule is stated to users.
 *
 * The rule is enforced server-side (EmergencyContactError, code "is_member"), but
 * nothing on the way in said so — applicants only discovered it by being rejected
 * after filling the form out. Every surface that *collects* an emergency contact
 * renders this up front instead.
 *
 * Keep the copy here and nowhere else so the collection surfaces can't drift apart.
 * Accepts any AlertProps (mt/mb/color/...) for spacing at each call site.
 */
export default function EmergencyContactNotice(props: Omit<AlertProps, "children" | "icon">) {
  return (
    <Alert variant="light" color="blue" icon={<IconUsersGroup size={20} />} {...props}>
      <Text fw={700}>Must be someone outside of your family.</Text>
      <Text size="sm" mt={2}>
        Pick an adult who doesn&apos;t live in your household — a neighbor, a friend, or a
        relative in another home — so we can always reach someone if your family can&apos;t
        be found.
      </Text>
    </Alert>
  );
}
