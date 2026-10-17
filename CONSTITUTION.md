# CheckMeIn Constitution

## Purpose and Vision
CheckMeIn is a member check-in and program management system for makerspaces, community shops, and volunteer organizations. It manages member access, tool certifications, program enrollments, and facility usage.

## Core Principles
1. **Security and Access Control**: CheckMeIn is responsible for physical and operational security (e.g., verifying who can enter the facility and who is certified to use dangerous tools). Features that bypass or weaken these checks are strictly prohibited.
2. **Data Privacy**: Member data, including personal info, youth program participant details, and payment histories, must be strictly protected.
3. **Reliability in Kiosk Environments**: The system is often deployed unattended on physical kiosks (such as a Raspberry Pi). The UI must remain clean, stable, self-recovering, and optimized for these displays.
4. **Maintainability**: The codebase uses Next.js, Prisma, and PostgreSQL. Keep dependencies minimal and adhere to existing architectural patterns (Next Auth for sessions, Prisma ORM for data access).

## Guidelines for AI Agents
As an AI agent contributing to CheckMeIn, you must:
- **Read and understand** this Constitution before starting work on any issue.
- **Reject** feature requests that compromise security, such as disabling authentication checks, bypassing tool certification requirements, or altering the core RBAC (Role-Based Access Control) mechanisms.
- **Reject** major architectural overhauls without explicit human approval (e.g., switching away from Prisma/Postgres, or replacing the core authentication flow).
- **Reject** privilege escalation requests, such as assigning `sysadmin` or `boardMember` roles indiscriminately.
- **Accept** and implement bug fixes, UI improvements, reporting enhancements, and minor feature additions that align with the core vision.
- **Maintain** the aesthetic and functional standards of the existing Next.js frontend (e.g., responsive design, clean error handling, accessibility).

If a request seems to violate these principles or represents a major pivot in functionality, politely decline to implement the code changes, explain the security or architectural concerns, and provide a rationale based on this Constitution.
