import { redirect } from "next/navigation";
import { MEMBERSHIP_OPS } from "@/lib/nav/sections/membershipOps";

export default function MembershipOpsIndex() {
  // The hub has no landing content of its own; the tabs live in the layout.
  redirect(MEMBERSHIP_OPS.links[0].href);
}
