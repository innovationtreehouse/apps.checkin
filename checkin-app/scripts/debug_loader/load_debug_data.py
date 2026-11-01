#!/usr/bin/env python3
"""
Local debug/test data loader.

Reads a JSON file describing one of five entity kinds and POSTs it to the running
dev app's public API (NOT the DB). Auth is the local NextAuth "persona-mint" flow:
on CHECKIN_ENV=local an anonymous caller may mint a session as any seeded
@example.com persona, so this script just logs in as one and reuses the cookie.

Kinds (top-level "type" field selects the loader):
  program        -> POST /api/programs, then POST /api/events per session
  event          -> POST /api/events (one-time)
  tools          -> POST /api/shop/tools per tool
  certifications -> POST /api/shop/certifications per row
  visits         -> POST /api/attendance/manual per visit (recorded for the persona)

Usage:
  python3 load_debug_data.py samples/program.json
  python3 load_debug_data.py samples/tools.json --base-url http://localhost:3010
  python3 load_debug_data.py samples/visits.json --persona-email lead.mentor@example.com

Stdlib only. No deps.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

PERSONA_MINT_PROVIDER_ID = "persona-mint"  # keep in sync with auth-options.ts


class Api:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )

    def _req(self, method, path, *, data=None, form=None, soft=False):
        url = self.base + path
        headers = {"Accept": "application/json"}
        body = None
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=30) as resp:
                raw = resp.read().decode() or "{}"
        except urllib.error.HTTPError as e:
            detail = e.read().decode()
            if soft:  # expected 4xx (e.g. already-enrolled) -> return parsed body
                try:
                    return json.loads(detail)
                except json.JSONDecodeError:
                    return {"error": detail, "_status": e.code}
            raise SystemExit(f"{method} {path} -> HTTP {e.code}: {detail}")
        except urllib.error.URLError as e:
            raise SystemExit(f"{method} {path} -> cannot reach {self.base}: {e.reason}")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}

    def get(self, path):
        return self._req("GET", path)

    def post_json(self, path, data, soft=False):
        return self._req("POST", path, data=data, soft=soft)

    def patch_json(self, path, data):
        return self._req("PATCH", path, data=data)

    def post_form(self, path, form):
        return self._req("POST", path, form=form)

    # --- auth ---------------------------------------------------------------
    def login_as_persona(self, persona_id):
        csrf = self.get("/api/auth/csrf").get("csrfToken")
        if not csrf:
            raise SystemExit("No csrfToken — is the app running with CHECKIN_ENV=local?")
        self.post_form(
            f"/api/auth/callback/{PERSONA_MINT_PROVIDER_ID}",
            {
                "csrfToken": csrf,
                "personaId": str(persona_id),
                "mode": "impersonate",
                "json": "true",
                "callbackUrl": self.base,
            },
        )
        session = self.get("/api/auth/session")
        if not session.get("user", {}).get("id"):
            raise SystemExit(f"Login as persona {persona_id} failed (empty session).")
        return session["user"]

    def pick_persona(self, persona_id=None, persona_email=None):
        personas = self.get("/api/auth/dev-personas").get("personas", [])
        if not personas:
            raise SystemExit("No @example.com personas — seed the DB (npx tsx prisma/seed.ts).")
        if persona_id is not None:
            match = next((p for p in personas if p["id"] == persona_id), None)
        elif persona_email is not None:
            match = next((p for p in personas if p["email"] == persona_email), None)
        else:
            # Default: a sysadmin (can create programs/tools/certs).
            match = next((p for p in personas if p.get("isSysadmin")), personas[0])
        if not match:
            raise SystemExit("Persona not found. Available: "
                             + ", ".join(f'{p["id"]}:{p["email"]}' for p in personas))
        return match


# --- per-kind loaders -------------------------------------------------------
def _load_one_program(api, entry, actor):
    prog = dict(entry["program"])
    name = prog.pop("leadMentorName", None)
    if not prog.get("leadMentorId"):
        prog["leadMentorId"] = _participant_id_by_name(api, name) if name else actor["id"]
    res = api.post_json("/api/programs", prog)
    program = res.get("program", {})
    pid = program.get("id")
    # POST /api/programs ignores phase/enrollmentStatus (defaults PLANNING/CLOSED);
    # apply them with a follow-up PATCH when the doc set either.
    lifecycle = {k: prog[k] for k in ("phase", "enrollmentStatus") if prog.get(k)}
    if pid and lifecycle:
        api.patch_json(f"/api/programs/{pid}", lifecycle)
    tag = f" [{prog.get('phase','')}/{prog.get('enrollmentStatus','')}]" if lifecycle else ""
    print(f"  program #{pid} '{program.get('name')}'{tag}"
          + (f"  (warning: {res['warning']})" if res.get("warning") else ""))
    total = 0
    for s in entry.get("sessions", []):
        body = dict(s)
        body["programId"] = pid
        r = api.post_json("/api/events", body)
        c = r.get("count", 0)
        total += c if isinstance(c, int) else 0
        print(f"    session '{s.get('name')}' -> {c} event(s)")
    print(f"    ({total} sessions total)")


def load_program(api, doc, actor):
    _load_one_program(api, doc, actor)


def load_programs(api, doc, actor):
    for entry in doc["programs"]:
        _load_one_program(api, entry, actor)


def load_event(api, doc, actor):
    r = api.post_json("/api/events", doc["event"])
    count = r.get("count", r.get("created", "?"))
    print(f"  event '{doc['event'].get('name')}' -> {count} event(s)")


def load_tools(api, doc, actor):
    for t in doc["tools"]:
        r = api.post_json("/api/shop/tools", t)
        tool = r.get("tool", {})
        print(f"  tool #{tool.get('id')} '{tool.get('name')}'")


def _resolve_tool_id(api, row, cache):
    if row.get("toolId"):
        return row["toolId"]
    name = row.get("toolName")
    if not name:
        raise SystemExit("cert row needs toolId or toolName")
    if cache["tools"] is None:
        cache["tools"] = api.get("/api/shop/tools")  # array of {id,name,...}
    hits = [t for t in cache["tools"] if t.get("name", "").lower() == name.lower()]
    if not hits:
        avail = ", ".join(t.get("name", "") for t in cache["tools"]) or "(none)"
        raise SystemExit(f"No tool named {name!r}. Available: {avail}")
    if len(hits) > 1:
        raise SystemExit(f"Tool name {name!r} is ambiguous ({len(hits)} matches).")
    return hits[0]["id"]


def _participant_id_by_ref(api, ref):
    """Resolve a participant by exact name OR exact email."""
    found = api.get("/api/people/search?q=" + urllib.parse.quote(ref))
    people = found.get("people", [])
    r = ref.lower()
    exact = [p for p in people
             if p.get("name", "").lower() == r or p.get("email", "").lower() == r]
    if not exact:
        near = ", ".join(f'{p["name"]} ({p["email"]})' for p in people) or "(none)"
        raise SystemExit(f"No participant matching {ref!r}. Near matches: {near}")
    if len(exact) > 1:
        dupes = ", ".join(f'#{p["id"]} {p["email"]}' for p in exact)
        raise SystemExit(f"{ref!r} is ambiguous: {dupes}. Use the id instead.")
    return exact[0]["id"]


def _participant_id_by_name(api, name):
    return _participant_id_by_ref(api, name)


def _resolve_participant_id(api, row):
    if row.get("participantId"):
        return row["participantId"]
    name = row.get("participantName")
    if not name:
        raise SystemExit("cert row needs participantId or participantName")
    return _participant_id_by_name(api, name)


def load_certifications(api, doc, actor):
    cache = {"tools": None}
    for c in doc["certifications"]:
        body = {
            # Certifications take personId; enrollments take participantId.
            "personId": _resolve_participant_id(api, c),
            "toolId": _resolve_tool_id(api, c, cache),
            "level": c["level"],
        }
        r = api.post_json("/api/shop/certifications", body)
        cert = r.get("certification", {})
        print(f"  cert person {cert.get('personId')} tool {cert.get('toolId')}"
              f" -> {cert.get('level')}")


def _post_visits(api, email, visits):
    ok = 0
    for v in visits:
        r = api.post_json("/api/attendance/manual", v)
        if r.get("visit"):
            ok += 1
    print(f"  {email}: {ok}/{len(visits)} visits")


def load_visits(api, doc, actor):
    # byPersona: /api/attendance/manual records for the logged-in user only, so
    # seed each person's history under their own session (re-login per group).
    if "byPersona" in doc:
        for group in doc["byPersona"]:
            email = group["personaEmail"]
            persona = api.pick_persona(persona_email=email)
            api.login_as_persona(persona["id"])
            _post_visits(api, email, group["visits"])
        return
    _post_visits(api, actor["email"], doc["visits"])


def _program_id_by_name(api, name, cache):
    if cache["programs"] is None:
        cache["programs"] = api.get("/api/programs")  # array of programs
    hits = [p for p in cache["programs"] if p.get("name", "").lower() == name.lower()]
    if not hits:
        raise SystemExit(f"No program named {name!r}. Load the program first.")
    # Reruns create duplicate names; enroll into the most recent (highest id).
    return max(hits, key=lambda p: p["id"])["id"]


def load_enrollments(api, doc, actor):
    # override:true — a sysadmin/board comp enrollment that bypasses payment,
    # closed enrollment, age, and capacity (status ACTIVE). Login must be sysadmin.
    cache = {"programs": None}
    for e in doc["enrollments"]:
        pid = _program_id_by_name(api, e["programName"], cache)
        ok = 0
        for ref in e["attendees"]:
            part_id = ref if isinstance(ref, int) else _participant_id_by_ref(api, ref)
            r = api.post_json(f"/api/programs/{pid}/participants",
                              {"participantId": part_id, "override": True}, soft=True)
            if r.get("error") and "already enrolled" not in r["error"]:
                print(f"    {ref}: {r['error']}")
            else:
                ok += 1
        print(f"  {e['programName']} (#{pid}): {ok}/{len(e['attendees'])} enrolled")


LOADERS = {
    "enrollments": load_enrollments,
    "program": load_program,
    "programs": load_programs,
    "event": load_event,
    "tools": load_tools,
    "certifications": load_certifications,
    "visits": load_visits,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="JSON file to load")
    ap.add_argument("--base-url", default="http://localhost:3010")
    ap.add_argument("--persona-id", type=int, help="Seeded persona id to act as")
    ap.add_argument("--persona-email", help="Seeded persona email to act as")
    args = ap.parse_args()

    with open(args.file) as f:
        doc = json.load(f)
    kind = doc.get("type")
    if kind not in LOADERS:
        raise SystemExit(f"Unknown 'type': {kind!r}. Expected one of {list(LOADERS)}.")

    api = Api(args.base_url)
    persona = api.pick_persona(args.persona_id, args.persona_email)
    actor = api.login_as_persona(persona["id"])
    print(f"Logged in as {actor.get('email')} (id {actor.get('id')})")
    print(f"Loading '{kind}' from {args.file}:")
    LOADERS[kind](api, doc, actor)
    print("Done.")


if __name__ == "__main__":
    main()
