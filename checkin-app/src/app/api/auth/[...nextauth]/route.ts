import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth-options";

const handler = NextAuth(authOptions);

// Export for App Router API routes
export { handler as GET, handler as POST };
