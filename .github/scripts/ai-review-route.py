#!/usr/bin/env python3
"""Route one PR's AI review with TypeSafe Jev 1.14, a structured decision model.

`route` (before the review) makes two Jev calls: the first decides which review
profiles apply (one yes/no per profile; file-path matches are a hint), the second
picks the review model from LADDER given those profiles. Each falls back on its
own: path matches for profiles, a fixed ladder for the model.

`adjudicate` (after the review) asks Jev whether the posted review is complete and,
if not, which stronger model on LADDER should rerun it.
"""
import json, os, re, subprocess, sys, urllib.request

CFG = ".github/ai-review"
JEV = "typesafe/jev-1.14"
# Ordered cheapest to strongest; a rerun only moves up.
LADDER = [
    ("free", "nvidia/nemotron-3.5-super-vl:free", "50", "300",
     "Costs nothing. Routine changes: docs, tests, small refactors, config, renames."),
    ("mid", "z-ai/glm-5.3", "30", "300",
     "About $0.30 a review. Real logic changes, one risky area, or a large diff. The default for anything beyond routine."),
    # ponytail: per-review spend caps via tool rounds and diff size; roughly $1 here and $2 below.
    ("high", "google/gemini-4-argon", "12", "150",
     "About $1 a review, three times the mid tier. Only when the mid reviewer is likely to miss something serious: security-boundary or migration changes, two or more risky areas, concurrency or authorization logic."),
    ("top", "anthropic/claude-opus-5.5", "8", "120",
     "About $2 a review and reserved for the rare case. Only when a missed bug would mean lost money, leaked personal data or a broken production deploy, AND the logic is subtle enough that the high tier would likely miss it. Choose this almost never."),
]
# Escalation bars: move to a rung only when P(this rung or higher) clears its bar.
# Odds 1:1, 4:1, 39:1, so reaching Opus takes about ten times the concern of Argon.
BARS = {"free": 0.0, "mid": 0.5, "high": 0.8, "top": 0.975}
RUNG = {r[0]: r for r in LADDER}
ORDER = [r[0] for r in LADDER]
PROFILE_THRESHOLD = 0.5
COMPLETE_THRESHOLD = 0.5
LARGE_LINES, LARGE_FILES, VERY_LARGE_LINES = 800, 25, 2500
# Shared by both repos: the last two are infra.aws profile names.
HIGH_PROFILES = {"migrations", "security-boundary", "iam-and-secrets", "state-safety"}
DIFF_BYTES = 200_000  # over ~32 KB Jev uses its slower long-context mode


def glob_re(pattern):
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


def matched_profiles(profiles, files):
    return [p["name"] for p in profiles
            if any(glob_re(g).match(f) for g in p["paths"] for f in files)]


def ladder(chosen, lines, nfiles):
    if HIGH_PROFILES & set(chosen) or len(chosen) >= 2 or lines > VERY_LARGE_LINES:
        return "high"
    if chosen or lines > LARGE_LINES or nfiles > LARGE_FILES:
        return "mid"
    return "free"


def jev(state, questions):
    body = json.dumps({"model": JEV, "state": state, "questions": questions}).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/systemone", data=body, headers={
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.load(r)
    cost = resp.get("usage", {}).get("cost")
    print(f"jev {resp.get('model')} cost={cost}")
    return resp["answers"]


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def pr_state(pr, repo):
    meta = json.loads(gh("pr", "view", pr, "-R", repo, "--json", "title,files,additions,deletions"))
    files = [f["path"] for f in meta["files"]]
    try:
        diff = gh("pr", "diff", pr, "-R", repo)[:DIFF_BYTES]
    except Exception as e:
        print(f"::warning::could not read the diff ({e}); deciding on the file list", file=sys.stderr)
        diff = ""
    # PR text is untrusted; it only ever appears here as data, never as instructions.
    return files, {"untrusted_pr_title": meta["title"], "changed_files": files,
                   "changed_lines": meta["additions"] + meta["deletions"], "file_count": len(files),
                   "untrusted_diff": diff}


def pick(probs, rungs):
    """Highest rung whose cumulative probability (it or any stronger rung) clears its bar."""
    chosen = rungs[0]
    for i, name in enumerate(rungs):
        if sum(probs.get(r, 0) for r in rungs[i:]) >= BARS[name]:
            chosen = name
    return chosen


def rung_choice(rungs):
    return {name: f"{RUNG[name][1]}. {RUNG[name][4]}" for name in rungs}


def route():
    pr, repo = os.environ["PR_NUMBER"], os.environ["GITHUB_REPOSITORY"]
    profiles = json.load(open(f"{CFG}/profiles.json"))
    files, state = pr_state(pr, repo)
    hits = matched_profiles(profiles, files)

    try:
        answers = jev(dict(state, profiles_matching_by_path=hits), {
            p["name"]: {"type": "noul",
                        "instructions": f"Does this change do the kind of work the '{p['name']}' review checklist covers? Judge by what the change does, not only where its files live.",
                        "criteria": {"true": p["instructions"],
                                     "false": "The change does none of this work, for example it only edits comments or unrelated files."}}
            for p in profiles})
        probs = {n: a["noul"] for n, a in answers.items()}
        chosen = [n for n, v in probs.items() if v >= PROFILE_THRESHOLD]
        p_by = f"{JEV} " + ", ".join(f"{n}={v:.2f}" for n, v in probs.items())
        applied = [dict(p, paths=["**"]) for p in profiles if p["name"] in chosen]
    except Exception as e:
        print(f"::warning::Jev profile call failed ({e}); using path matches", file=sys.stderr)
        chosen, p_by, applied = hits, "fallback: path matches", profiles

    suggested = ladder(chosen, state["changed_lines"], state["file_count"])
    try:
        a = jev(dict(state, review_profiles_that_apply=chosen, guidance_ladder_suggests=suggested), {
            "reviewer": {"type": "choice",
                         "instructions": "Which reviewer should review this pull request? Cost matters: pick the cheapest reviewer that will reliably catch real bugs in this change. Moving up a tier needs strong evidence that the cheaper reviewer would miss something serious.",
                         "criteria": rung_choice(ORDER)}})["reviewer"]
        tier = pick(a["probabilities"], ORDER)
        t_by = f"{JEV} top choice {a['choice']}, " + ", ".join(f"{k}={v:.2f}" for k, v in a["probabilities"].items())
    except Exception as e:
        print(f"::warning::Jev model call failed ({e}); using the fixed ladder", file=sys.stderr)
        tier, t_by = suggested, "fallback: fixed ladder"

    _, model, turns, diff_kb, _ = RUNG[tier]
    summary = (f"profiles={chosen} (path hint {hits}; {p_by})\n"
               f"tier={tier} model={model} (ladder suggested {suggested}; {t_by})")
    print(summary)
    with open(os.environ["GITHUB_OUTPUT"], "a") as o:
        o.write(f"tier={tier}\nmodel={model}\nmax_tool_turns={turns}\nmax_diff_kb={diff_kb}\n")
        o.write(f"profiles={json.dumps(chosen)}\n")
        o.write(f"path_profiles<<EOF_PP\n{json.dumps(applied)}\nEOF_PP\n")
        o.write(f"instructions<<EOF_CI\n{open(f'{CFG}/instructions.md').read()}\nEOF_CI\n")
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as s:
        s.write(f"### AI review routing\n{summary}\n")


def posted_review(repo, pr, url):
    m = re.search(r"pullrequestreview-(\d+)", url or "")
    if not m:
        return ""
    rid = m.group(1)
    body = gh("api", f"repos/{repo}/pulls/{pr}/reviews/{rid}", "--jq", ".body")
    comments = gh("api", f"repos/{repo}/pulls/{pr}/reviews/{rid}/comments", "--jq",
                  r'.[] | "\(.path):\(.line // .original_line) \(.body)"')
    return body + "\n\nInline comments:\n" + comments


def adjudicate():
    pr, repo = os.environ["PR_NUMBER"], os.environ["GITHUB_REPOSITORY"]
    tier, verdict = os.environ["TIER"], os.environ.get("VERDICT", "")
    chosen = json.loads(os.environ.get("PROFILES") or "[]")
    higher = ORDER[ORDER.index(tier) + 1:]
    nxt, by = "none", "fallback"
    if higher:
        try:
            _, state = pr_state(pr, repo)
            state = dict(state, reviewer_tier=tier, reviewer_model=RUNG[tier][1], review_checklists=chosen,
                         review_verdict=verdict or "missing (the review failed)",
                         untrusted_review_output=posted_review(repo, pr, os.environ.get("REVIEW_URL"))[:60_000])
            qs = {"complete": {"type": "noul",
                               "instructions": "Is the posted review complete enough to rely on? It should cover every changed file that matters, address each applicable checklist, and support findings with file:line evidence. A short review of a trivial change can be complete.",
                               "criteria": {"true": "The review is thorough for this change and its findings are evidenced.",
                                            "false": "The review is missing, failed, partial, skipped risky files, stopped early, or only restates the diff."}},
                  "rerun_on": {"type": "choice",
                               "instructions": "If the review must be redone, which stronger reviewer should redo it? Cost matters: pick the cheapest one that would fix what the review missed.",
                               "criteria": rung_choice(higher)}}
            a = jev(state, qs)
            p = a["complete"]["noul"]
            rerun = pick(a["rerun_on"]["probabilities"], higher)
            # A rerun on a costlier rung also needs that rung's bar of confidence that the review is incomplete.
            while rerun != "none" and 1 - p < BARS[rerun]:
                i = higher.index(rerun)
                rerun = higher[i - 1] if i else "none"
            nxt = "none" if p >= COMPLETE_THRESHOLD else rerun
            by = f"{JEV} complete={p:.2f}, rerun " + ", ".join(f"{k}={v:.2f}" for k, v in a["rerun_on"]["probabilities"].items())
        except Exception as e:
            print(f"::warning::Jev completeness call failed ({e}); using the review verdict", file=sys.stderr)
            if verdict in ("", "partial", "error") and tier != "high":  # fallback never escalates to the top rung
                nxt = higher[0]
            by = f"fallback: verdict {verdict or 'missing'}"
    summary = f"completeness: tier={tier} verdict={verdict or 'none'} rerun={nxt} ({by})"
    print(summary)
    with open(os.environ["GITHUB_OUTPUT"], "a") as o:
        o.write(f"rerun_tier={nxt}\n")
        if nxt != "none":
            _, model, turns, diff_kb, _ = RUNG[nxt]
            o.write(f"model={model}\nmax_tool_turns={turns}\nmax_diff_kb={diff_kb}\n")
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as s:
        s.write(f"{summary}\n")


if __name__ == "__main__":
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("::error::OPENROUTER_API_KEY is empty: add the org or repository Actions secret. No AI review ran.")
        sys.exit(1)
    adjudicate() if sys.argv[1:] == ["adjudicate"] else route()
