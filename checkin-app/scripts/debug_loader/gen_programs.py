#!/usr/bin/env python3
"""
Generate data/programs.json: 12 debug programs across the coming 4 months, each
seeded with 3-8 sessions, mostly (not always) weekly, with varied adult lead
mentors drawn from the baseline dev seed (seed-helpers.ts).

Run:  python3 gen_programs.py   ->  writes data/programs.json
Self-checks that every program's generated event count matches its target.
"""
import json
import os
from datetime import date, timedelta

# JS getDay(): Sun=0..Sat=6 (the /api/events recurrence contract).
SUN, MON, TUE, WED, THU, FRI, SAT = range(7)


def js_dow(d):
    return (d.weekday() + 1) % 7  # python Mon=0..Sun=6 -> JS Sun=0..Sat=6


def match_dates(start, days, count):
    """Mirror /api/events recurrence: walk forward from `start`, collect the
    first `count` dates whose weekday is in `days`. Returns the list of dates."""
    out, cur, guard = [], start, 0
    while len(out) < count and guard < 365:
        if js_dow(cur) in days:
            out.append(cur)
        cur += timedelta(days=1)
        guard += 1
    return out


def weekly(start, days, count):
    """One recurring session-spec that yields exactly `count` events."""
    dates = match_dates(start, days, count)
    until = dates[-1]
    return {"kind": "recurring", "days": days, "start": dates[0], "until": until,
            "dates": dates}


def explicit(dates):
    return {"kind": "explicit", "dates": sorted(dates)}


# --- program specs ----------------------------------------------------------
# Each program stays inside one membership year (boundary 1 September): a program
# that crosses it needs a Board-stated year, which this sysadmin loader cannot give.
# (title, leadMentorName, session-plan, startTime, endTime, minAge, maxAge,
#  memberPrice, nonMemberPrice)
Y = 2026
SPECS = [
    ("Intro to Woodworking",   "Board Member",   weekly(date(Y, 7, 7),  [TUE], 6),        "16:00", "18:00", 13, 18, "25.00", "40.00"),
    ("Welding Basics",         "Certified Adult", weekly(date(Y, 7, 6),  [MON], 4),        "17:00", "19:30", 16, None, "35.00", "55.00"),
    ("3D Printing Studio",     "Tool Certifier",  weekly(date(Y, 7, 8),  [WED], 8),        "15:00", "17:00", 12, 18, None,    None),
    ("Robotics Club",          "Keyholder One",   weekly(date(Y, 7, 14), [TUE, THU], 6),   "16:00", "18:00", 11, 17, "20.00", "30.00"),
    ("Summer Art Camp",        "Parent Family",   explicit([date(Y, 7, 18), date(Y, 7, 19), date(Y, 7, 25), date(Y, 7, 26)]), "10:00", "14:00", 8, 14, "15.00", "25.00"),
    ("Leatherworking",         "Keyholder Two",   weekly(date(Y, 8, 6),  [THU], 4),        "18:00", "20:00", 15, None, "30.00", "45.00"),
    ("Electronics 101",        "BG Reviewer",     weekly(date(Y, 7, 13), [MON], 7),        "16:30", "18:30", 12, 18, None,    None),
    ("Sewing & Textiles",      "Parent2 Family",  explicit([date(Y, 8, 7), date(Y, 8, 14), date(Y, 8, 21)]),                     "13:00", "15:00", 10, 16, "18.00", "28.00"),
    ("CNC Fundamentals",       "Parent Family2",  weekly(date(Y, 9, 2),  [WED], 6),        "17:00", "19:00", 16, None, "40.00", "60.00"),
    ("Blacksmithing",          "Board Member",    weekly(date(Y, 9, 5),  [SAT], 5),        "09:00", "12:00", 16, None, "50.00", "75.00"),
    ("Screen Printing",        "Certified Adult", weekly(date(Y, 9, 14), [MON, WED], 8),   "16:00", "18:00", 13, 18, "22.00", "32.00"),
    ("Ceramics Workshop",      "Tool Certifier",  weekly(date(Y, 10, 1), [THU], 4),        "18:00", "20:00", 12, 18, "28.00", "42.00"),
]


# Lifecycle. ProgramPhase: PLANNING|UPCOMING|RUNNING|FINISHED.
# EnrollmentStatus: OPEN|CLOSED. Defaults are derived from the dates below;
# override either explicitly per program by title.
TODAY = date(Y, 7, 1)
PHASE_OVERRIDE = {
    "Intro to Woodworking": "RUNNING",   # example explicit override
}
ENROLLMENT_OVERRIDE = {
    "3D Printing Studio": "CLOSED",      # full/closed even though upcoming
}


def default_phase(start, end):
    if end < TODAY:
        return "FINISHED"
    if start <= TODAY <= end:
        return "RUNNING"
    return "UPCOMING"


def program_entry(title, mentor, plan, st, et, minA, maxA, mprice, nmprice,
                  phase=None, enrollment=None):
    """Build one {program, sessions} entry. phase/enrollment default from dates."""
    all_dates = plan["dates"]
    phase = phase or PHASE_OVERRIDE.get(title, default_phase(all_dates[0], all_dates[-1]))
    enrollment = enrollment or ENROLLMENT_OVERRIDE.get(
        title, "OPEN" if phase in ("UPCOMING", "RUNNING") else "CLOSED")
    prog = {
        "name": title,
        "leadMentorName": mentor,
        "startAt": all_dates[0].isoformat(),
        "endAt": all_dates[-1].isoformat(),
        "phase": phase,
        "enrollmentStatus": enrollment,
        "memberOnly": False,
        "minAge": minA,
        "maxAge": maxA,
        "memberPrice": mprice,
        "nonMemberPrice": nmprice,
    }
    sessions = []
    if plan["kind"] == "recurring":
        sessions.append({
            "name": f"{title} — Session",
            "startDate": plan["start"].isoformat(),
            "startTime": st,
            "endTime": et,
            "recurrence": {"daysOfWeek": plan["days"], "until": plan["until"].isoformat()},
        })
    else:  # explicit: one single-event spec per date
        for i, d in enumerate(all_dates, 1):
            sessions.append({
                "name": f"{title} — Session {i}",
                "startDate": d.isoformat(),
                "startTime": st,
                "endTime": et,
            })
    return {"program": prog, "sessions": sessions, "_expectedSessions": len(all_dates)}


def build():
    return {"type": "programs", "programs": [program_entry(*spec) for spec in SPECS]}


def check(doc):
    assert len(doc["programs"]) == 12, "want 12 programs"
    names = [p["program"]["name"] for p in doc["programs"]]
    assert len(set(names)) == 12, "program names must be distinct"
    for p in doc["programs"]:
        n = p["_expectedSessions"]
        assert 3 <= n <= 8, f'{p["program"]["name"]}: {n} sessions out of 3..8'
    # mentors: varied (>= 5 distinct), all adults handled by seed choice
    mentors = {p["program"]["leadMentorName"] for p in doc["programs"]}
    assert len(mentors) >= 5, "want varied lead mentors"
    print(f"check ok: 12 programs, sessions {[p['_expectedSessions'] for p in doc['programs']]}, "
          f"{len(mentors)} distinct mentors")


if __name__ == "__main__":
    doc = build()
    check(doc)
    out = os.path.join(os.path.dirname(__file__), "data", "programs.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"wrote {out}")
