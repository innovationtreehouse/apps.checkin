import { escapeHtml, baseEmailLayout } from "./base";

/**
 * Welcome email sent to a program lead when their program is created/approved
 * (#1220). Replaces the generic "System Action: PROGRAM_ASSIGNMENT" copy with a
 * congratulatory message and a link to the program-management page.
 */
export function programAssignmentTemplate(args: { programName: string; manageUrl: string }): string {
    const name = escapeHtml(args.programName);
    // manageUrl is server-built from config.baseUrl() + a numeric id — not user input.
    const url = escapeHtml(args.manageUrl);
    return baseEmailLayout(`
        <h2 style="color: #0f172a;">Your Innovation Treehouse Program has been Created!</h2>
        <p>Congrats! Your program <strong>${name}</strong> has been approved and initialized by Innovation Treehouse.</p>
        <p>You can manage it <a href="${url}">here</a>.</p>
        <p>We recommend adding the first couple of events to the program, and then marking it open
        for enrollment as soon as you can so our community can start signing up!</p>
        <p>Thank you again for your commitment to teaching and fostering community with this upcoming program,</p>
        <p>Sincerely,<br />Innovation Treehouse</p>
    `);
}
