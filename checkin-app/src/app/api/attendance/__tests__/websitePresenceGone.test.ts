/**
 * @jest-environment node
 *
 * Only the kiosk starts or ends a visit, and only the kiosk closes the building
 * (docs/rules/attendance-checkin.md). The attendance route is a read; a verb it
 * does not export answers 405.
 */
import * as attendanceRoute from "../route";

it("/api/attendance exports GET and no write verb", () => {
    const verbs = Object.keys(attendanceRoute).filter(k => /^[A-Z]+$/.test(k));
    expect(verbs).toEqual(["GET"]);
});
