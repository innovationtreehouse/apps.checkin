# Run the door kiosk in a container

Plan being built. Decisions marked with a date are the owner's.

## Problem

The kiosk at the door updates itself by moving a source checkout on the Raspberry
Pi and restarting. When that goes wrong, the checkout is left broken, the Python
packages on the Pi differ from the ones CI tested, and nothing offers one safe way
to go back. Fixing it means getting onto the Pi by hand, which is painful today.

The update logic also lives inside the program it updates, which adds to a client
already large enough to be hard to keep stable.

There is a second problem. If the kiosk restarts while the network is down, it
forgets who is inside. A person inside who badges out is then recorded as
checking in, and a keyholder leaving is not offered the close.

## Objective

- An update replaces one complete, tested image. It cannot leave a half-updated
  kiosk, and a failed start goes back to the previous image by itself.
- Updates stay automatic and need no VPN. A bad release can be withdrawn from
  GitHub, and the door follows.
- A restart, planned or not, keeps what the kiosk knows, including scans not yet
  sent to the server.
- The container holds no host privileges beyond reading the badge scanner.
- Nothing here blocks adding more kiosks later.

## Executive summary

| Area | Decision |
| --- | --- |
| In the container | The Python client only |
| On the host | Chromium, Openbox, Docker, and a few small systemd units |
| Database | SQLite stays, in a host directory. Add one state row beside the scan queue |
| Update trigger | A timer on the Pi pulls a moved release tag overnight; a forced update from GitHub applies within five minutes at any hour |
| Failed update | Automatic rollback when the new container fails its local health check |
| Install | In place on the current OS, in one SSH session at night |
| Order | Container first, then saved state, then the kiosk half of the presence work |
| TypeScript | Not now. Decide after the kiosk has shrunk, using the measurements below |

Cost: the host layer cannot update itself, so changing it takes an SSH session.
It is kept small for that reason.

## What runs today

| Piece | Where it goes |
| --- | --- |
| Signing proxy, bound to localhost | Container, on host network so the bind stays localhost-only |
| Badge reader | Container, with read access to input devices |
| Scan queue and drain | Container code, data on host |
| Roster and version polling, health checks | Container |
| Self-update through Git | Deleted; replaced by the host timer |
| Wi-Fi bounce, reboot escalation | Deleted (K7 in the presence design) |
| Nightly reboot | Host systemd timer |
| Chromium and its restart | Host |

Chromium stays on the host because a container would gain nothing: it would need
the display, GPU and fonts passed through, and it holds no state worth isolating.

## Can it save state, update, and read it back?

Yes. Most of the work already exists. The scan queue already survives a kill: a
row is written before it is sent, and the server drops a duplicate by its scan id.
Only the kiosk's view of the building is missing.

### What a restart loses today

| State | Today | Plan |
| --- | --- | --- |
| Unsent scans | Kept | No change |
| Scan being sent when killed | Sent again, server dedups | No change |
| Who is inside, online | Rebuilt from server plus queue | No change |
| Who is inside, offline | **Lost, except queued scans** | Save |
| Last roster and names | **Lost**; screen shows "unknown" | Save |
| Known keyholders | **Lost**; close not offered offline | Save |
| Last two-deep state | **Lost**; offline caution not shown | Save |
| Arrival times | Lost for anyone not in the queue | Save |
| Server's protocol version | Resets; scans queue until it answers | Leave: this fails safe |
| "Known empty" flag | Resets until a real roster | Leave: "unknown" must never read as empty |
| 15-second close prompt | Lost | Leave; updates avoid it (below) |
| 3-second repeat filter | Lost | Leave; updates avoid it (below) |

The loss is live today. Any restart during an outage triggers it, including the
reboot escalation, which fires because of the outage. This phase is worth doing
even without containers.

### Design

- One new table in the same SQLite file, holding one row: a versioned JSON
  snapshot of the "Save" rows above.
- A badge writes the snapshot and its queue row in **one transaction**, so the
  two cannot disagree after a power cut.
- A roster fetch writes the snapshot only if it changed, which limits SD card
  wear. A resting kiosk writes nothing.
- On start: load the snapshot, overlay pending scans above the snapshot's "cleared
  through queue id N", leave "known empty" false, then let the first good roster
  replace it all as today.
- A snapshot version the code does not know is ignored. The kiosk then behaves as
  it does today after a restart.
- A corrupt database is moved aside as today, which also loses the snapshot.
- **Restoring after a missed close.** The snapshot keeps the server-time sample, the
  boot id, and its own write time on server-based time. The sample is also saved at
  most every ten minutes between snapshot writes, to limit card wear; an older
  sample only widens its uncertainty. If the boot id matches, monotonic time is still
  valid, so the kiosk clears on restore only when the latest 23:00 falls after the
  snapshot's write time. A badge saved after that night's clear is therefore kept.
  After a reboot the sample cannot be aged, so the kiosk does nothing, as S1 states.
  A clear already applied is in the snapshot, so the nightly reboot does not undo it.
  The model holds this rule with the fixes in S1, though the all-fixes run is not
  complete.

**Personal data.** The Pi now keeps names on disk, not only badge numbers. The
register already limits what the kiosk receives: no whole last names, emails,
birth dates or phone numbers. The file is readable only by the kiosk user, on the
same card as the signing key, which is the more sensitive item.

**What stays on the Pi (owner, 2026-11-01).** A scan is deleted once the server
acknowledges it. With a clean uplink and the building empty, the active data is empty
after the 23:00 clear; not losing scans comes first, so an unsent scan stays queued
through an outage. Only a directory persists: ID, limited display name and keyholder
flag for everyone allowed to badge, with no email or other contact data. The server
versions it by content hash, roster replies and acknowledgements carry the hash, and
on a difference the kiosk replaces its whole copy in one transaction. So nothing ages:
someone removed is gone at the next contact. This replaces the snapshot's `knownPeople`
and `knownKeyholders`, needs a registry PR then a route PR, and lands after cutover.
The list is everyone active in the system, leaving out any DENIED household and any
archived household.

**Schema rule.** Queue and state changes are additive and nullable, so an older
image can run against a newer file. Without this, rollback is unsafe.

**Register change.** At merge, add to Kiosk resilience: a restart keeps the
kiosk's view of who is inside.

**Model.** The formal model needs a restart action that keeps this state. The
Checkin session owns that model.

## Updates

```
GitHub release → prod deploy succeeds → build arm64 image → push by digest
                                                                   ↓
                              tests pass on that digest → move kiosk-release tag
                                                                   ↓
Pi: hourly timer, 23:00–06:00 → digest differs? → pull → swap → health check
                                                                   ↓ fails
                                                     previous digest restarts
```

- **Overnight by default.** The kiosk cannot read a badge while restarting, so a
  badge in that gap gets no acknowledgement and is not recorded. The closed window
  already exists for this kind of work. A release waits at most a day.
- **Queue stays put.** Unsent scans wait in the file, so no drain is needed first.
- **The tag moves only after the image passes (owner, 2026-11-01).** After the prod
  deploy, the image is pushed by digest with no tag, and the flow and Playwright
  tiers run against that digest with the same release's server code. A failure
  leaves the tag where it is and fails the run visibly. A forced update skips this:
  it is for a door already wrong, and two people approve it.
- **Publishing is its own job, with its own approval (owner, 2026-11-01).** It runs
  after the deploy job in the `production` environment, and pushes, tests and moves
  the tag as one job, so each release takes one extra approval. Publishing needs an
  approved environment because the role trusts only approved environments. Keeping
  it apart from the deploy job means a kiosk failure does not fail the server deploy,
  and a retry reruns only this job. Folding it into the deploy job would save the
  approval and lose both of those.
- **The tag moves after the prod deploy.** The existing protocol hold still
  protects any skew. The server must keep accepting the protocol of a kiosk up to
  a day behind, which the presence rollout already requires.
- **Health means local health only:** the database opens, the proxy answers and
  the scanner is held. It must not check the server, or an outage would roll back
  good images.
- **Withdrawing a release:** move the tag back to the earlier digest. No VPN is
  needed, and the door follows that night, or within five minutes if forced.
- **Worst case by hand:** one host command deploys a named digest or goes back to
  the previous one. It works over SSH today and over VPN later.
- **The updater runs on the host.** A container that could update itself would
  need the Docker socket, which equals root. The image also never installs host
  files, for the same reason.

### Forcing an update during the day

For a real problem at the door, with no VPN or SSH needed.

- **Trigger.** A manual GitHub Actions workflow, "Force kiosk update", takes a
  release tag or image digest, forward or back. It moves `kiosk-release` and a
  second tag, `kiosk-urgent`, to that digest. It runs behind an approval
  environment set like production (owner, 2026-11-01): one person starts it, another
  approves, with self-review blocked. The run records who started and who approved.
- **On the Pi.** A second timer checks `kiosk-urgent` every five minutes, all day.
  If its digest differs from the last urgent digest recorded on the Pi, the Pi
  records it and then swaps at once, skipping the window. The check goes to the
  registry only, so it cannot wake the server or defer its curfew.
- **No loop.** The digest is recorded before the swap, so a forced image that fails
  its health check rolls back once and is not retried. Each force run publishes its
  own digest for the chosen image, so forcing the same image again still applies. Because `kiosk-release` moves too, the nightly check does
  not undo the force, or retry a failed one.
- **What it costs.** Badges during the restart are missed, and a live close prompt
  is lost. The queue and saved state are safe. A forced update does not wait for a
  quiet moment: it is for when the kiosk is already wrong. Whoever forces it should
  expect those few seconds of downtime at the door.
- **Limits.** A Pi with no network applies the force when it reconnects. If the
  update timer or Docker itself is broken, this cannot help, and SSH or VPN is the
  remaining route.

### Where the image is published

**Amazon ECR Public (owner, 2026-11-01).** The Pi runs this image with its signing
key mounted, so publishing must take the same approval as a release. A required
reviewer on a GitHub environment does not do that alone: it protects only what the
environment holds. Publishing to GHCR with the repo's `GITHUB_TOKEN` needs no
environment, so a workflow on a committer's branch could move the tag and skip the
approval.

| | Amazon ECR Public (chosen) | GHCR with a token held in the environment |
| --- | --- | --- |
| Publish credential | Short-lived OIDC login; nothing stored | Classic personal access token, stored and expiring |
| Stops a branch workflow | Yes: the role trusts only the `production` and `kiosk-force` environments, by exact subject | Only if the repo's own token also loses write access, which we could not verify |
| Reach | One role, one repository | Every package the token's user can write |
| Failure to expect | None from expiry | An expired token blocks a force when the door is already broken; one such token stopped ECS pulls on 2026-09-19 |
| Pi pull | Anonymous | Anonymous, once visibility is set by hand |
| Cost of choosing it | One infra PR; a registry apart from the fleet's GHCR images | A machine account and token rotation |

Published prices put this at no cost: 50 GB of storage is always free, and anonymous
transfer is free to 500 GB a month. A release adds about one image. Old images are
pruned by hand if storage ever nears that limit. The repository and role live in the
infra repo (`live/mgmt/kiosk-image.tf`).

**Still true with this choice:** code merged to `main` reaches the door through the
next release, behind that release's approval. Repo admins can change environment
settings. Whoever can create the `kiosk-force` environment can assume the role, so
it is created with its reviewers before the role exists.

### Running the container

```
docker run --name kiosk-client --rm --network host \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --device-cgroup-rule 'c 13:* rm' -v /dev/input:/dev/input:ro \
  --group-add <input gid> --user <kiosk uid> \
  -v /var/lib/kiosk:/data \
  -v /etc/kiosk/client.key:/data/client.key:ro \
  -v /etc/kiosk/config.json:/data/config.json:ro \
  -v /etc/localtime:/etc/localtime:ro \
  --log-driver journald \
  public.ecr.aws/<alias>/kiosk@sha256:<digest>
```

To confirm on the Pi: scanner replug, and whether holding the scanner needs write
access to the device (the flags above may need `rw`).

### Traps the image must handle

- **Timezone.** The closed window uses local time. A container defaults to UTC,
  so the mounted `/etc/localtime` is required.
- **`evdev`.** It is missing from `requirements.txt`, and a failed import only
  logs a warning. An image built from that file runs fine and ignores badges. Add
  it, and make the health check require the scanner.
- **Working directory.** The database and marker files use relative paths. The
  container runs from `/data`.
- **Chromium restart.** The client asks for it through a marker file. The file
  moves to the shared directory, and a small host loop acts on it.
- **Architecture.** Build arm64 only if Q1 confirms a 64-bit OS.

## Clock disagreement

The server refuses a signed kiosk request when its timestamp is more than 60
seconds off. A kiosk clock wrong by more than that fails today: every scan queues
and shows "will sync" until the clock is fixed. The only warning is a banner on the
browser-wedge path, so a working screen can hide a stuck queue.

- **Warn at 30 seconds**, half the signature window, so the warning comes before
  the failure. The kiosk compares its clock with the server's `Date` on each
  exchange and logs it, counting only skew beyond the sample's uncertainty so a slow
  network does not raise it. The public version route answers even when signatures
  fail.
- **Show it where someone can act.** The server notes the skew of each
  correctly signed kiosk request, even one refused as stale, in memory beside the
  last-seen stamp, with no database write. The kiosk status panel shows it. Checking
  the signature first stops strangers from raising a false warning.
- **Show it at the door too, from 30 seconds.** Keyholders see the door every day
  and can raise the alarm. It is a small corner notice beside the queue badge: "Kiosk
  clock is off. Please tell staff." It stays until a later exchange shows the clocks
  agree, and it never stops anything: badges, queueing, closes and the
  acknowledgement all work as usual, and scan banners appear over it unchanged.
- **Sign with the server-time sample,** so a wrong Pi clock no longer stops scans.
  Replay protection is unchanged: the nonce and the 60-second window still apply.
  With no sample yet, the public version route supplies one.
- **Limit:** offline or resting, nothing can compare clocks, so the warning waits
  for the next exchange. The panel reads "can't confirm", as it does for last-seen.

Signing and the comparison ship with protocol 8's sample. The panel is a separate
server PR.

## Host layer

| File | Job |
| --- | --- |
| `kiosk-client.service` | Runs the container at the recorded digest; always restarts |
| `kiosk-update.timer` and script | Check, pull, swap, health check, roll back |
| `kiosk-urgent.timer` | Every five minutes, runs the same script for a forced digest |
| `kiosk-reboot.timer` | Nightly reboot |
| Browser loop in Openbox autostart | Starts Chromium, restarts it on request or exit |
| `kioskctl` | Status, deploy a digest, go back |

LightDM and Openbox stay as they are. An install script sets all of this up.

## Keeping many kiosks possible

| Choice | Why it scales |
| --- | --- |
| Pull, not push | Each Pi updates itself; nothing needs a device list |
| Identity outside the image | Key and config are per device; the image is shared |
| Per-kiosk key | The server already accepts several public keys |
| Tag name in host config | A later test-first kiosk can follow another tag |
| State per kiosk | Each file holds only its own device's data |

Two existing behaviours assume one door. Neither is added here, but both need a
decision before a second door exists:

- Resting while "known empty" assumes every arrival badges at this kiosk.
- The presence design makes the kiosk the owner of who is inside. Two kiosks would
  each hold a partial view of offline scans.

## Order of work

**Changed from my earlier suggestion.** I suggested the presence work first, to
avoid porting code it deletes. Reading the code reversed that: the container work
deletes the update code (K6) and drops the recovery code (K7) anyway, so nothing
gets ported. Going first also means the presence kiosk release arrives through the
safer channel rather than the one breaking today.

1. **Facts.** Run the Q1 command on the Pi.
2. **Image and CI.** Dockerfile, arm64 build on release, moving tag, the force
   workflow. Touches no device.
3. **Host layer.** Install script and units, tested on any spare 64-bit Pi if one
   is available.
   - **Container tests, required before cutover (owner, 2026-11-01).** The shipped
     image runs in the flow stack with a throwaway signing key, on an arm64 runner.
     A fake `evdev` mounted at test time feeds badges, so the image is unchanged.
     Flow tests cover records, offline, restart, upgrade and rollback; Playwright
     covers the kiosk's own page.
4. **Cutover**, in one SSH session at night:
   1. Install Docker and the host layer, and pull the image.
   2. Stop the old loop cleanly, so the WAL file settles.
   3. Move `outbox.db*`, the key and the config to their new locations.
   4. Start the new units, and test a real badge.
   5. Leave the old checkout in place, with autostart lines commented out.
5. **Saved state** (above), delivered by image.
6. **Soak two weeks, then delete** `kiosk.sh`, `migrate.sh`, the Git update code
   and its guard test, and the old checkout on the Pi.
7. **Presence kiosk release** (PR 4 of that design), minus what steps 4–6 removed.
   The server's kiosk contract PR (queue depth, protocol-8 time uncertainty) must be
   deployed first.
8. **TypeScript decision.**

Presence server PRs do not depend on this and can run alongside.

**Website check-in removal has landed** (#2806). It changed no kiosk client code,
and the kiosk's signed scan and roster calls keep working, so this order stands.
Three things follow:

- **Saved state matters more.** Staff cannot edit, end or remove an
  open visit on the website, and nobody can close the building there. A wrong
  direction from an offline restart then stays until the person badges again or
  the 23:00 close, and a keyholder denied the close has no web fallback. Step 5
  therefore follows cutover directly and is not deferred.
- **Protocol check.** The door's protocol is unconfirmed, and the status page
  reports only the server's. Read it on the Pi during step 1, since the presence
  rollout needs it too.
- **Contract fixtures** start from the scan route as it stands now.

**Going back during the soak:** restore the autostart lines and move the files
back. Scans queued in the meantime move with them. This route is why the old
checkout stays until step 6.

## TypeScript

**Recommendation: not now. Probably yes later, as its own step, if the checks
below pass.** It does not address what is breaking at the door; the container and
the presence cuts do. Porting while changing the deployment also makes any new
failure harder to place, on a device that is hard to reach.

### What could be shared

| Item | Size | Shared how today |
| --- | --- | --- |
| Signing format | One line | Golden test vector, both sides |
| Protocol version | One number | Advertised at runtime; duplicated in source |
| Scan request | About 12 fields | Hand-checked on both sides |
| Scan response, roster | Read loosely by the kiosk | Nothing |

Zod is common in `packages/`, but the scan route does not use it, so sharing
schemas also means changing a live route. The kiosk's hard logic (close decision,
queue overlay, offline view) has no server twin to share with. The gain is real
but small: typed contracts, and no separate Python runtime and CI lane to keep.

### Cost and risk

| Item | Finding |
| --- | --- |
| Port size | About 2,400 lines of client and 2,200 of tests, less after K1–K8 |
| Scanner | The main risk. Node has no built-in way to take exclusive hold of the device. Needs a native addon or an ignore rule on the host, or Chromium may receive the digits |
| Concurrency | Threads and locks become one event loop. Simpler, but the queue and presence ordering must be re-proved, including spec-trace tests |
| Crypto, HTTP, SQLite | Node built-ins cover them, so few or no runtime packages |
| Pi resources | Node uses more memory and a larger image. Measure on the door's model |
| Runtime version | The repo uses Node 24. Check it supports the Pi's architecture |

### Do now, in either language

Extend the golden-vector idea to scan requests and responses, and the roster:
JSON fixtures that both test suites read, following `receipt-contract-fixtures`.
This gets most of the drift protection without a port, and those fixtures would
then guard a port too.

### Port when all are true

- The presence release has shipped and the client is smaller.
- A spike reads and holds the scanner from Node on the real Pi.
- Memory fits on the door's model.

With the container in place, a port is one more image: same database file, same
rollback.

## Tests

- Restart: kill the client, offline, with people inside; the same badge still
  shows OUT, and a keyholder still gets the close.
- Atomic write: fail between snapshot and queue row; neither lands.
- Empty never invented: a restored empty snapshot does not rest until a real
  roster arrives.
- Rollback schema: older code runs against a newer database file.
- Updater: bad image rolls back; offline server does not; outside the window
  nothing moves unless forced.
- Force: applies outside the window; a failing forced image rolls back once and is
  not retried, by either timer; a newer force still applies.
- Image: starting without `evdev` or a scanner fails the health check.
- Clock: a kiosk 10 minutes off still signs and delivers scans, and the panel and
  door notice show the skew; a badge during the notice behaves normally; the notice
  clears when the clocks agree; a stale request with a bad signature changes nothing on the panel.
- Clear: a pre-23:00 queued check-in stays out of the view after a clear and an
  offline restart, and still sends. A reply with `lastNightlyCloseAt` before 23:00
  changes neither view nor snapshot until the wait cap. A badge at 23:00 with the
  timer not yet run clears first. A clock-suspect row stays out of the overlay once
  the reply says the close ran.
- Reboot: a fallback stamp is never earlier than the snapshot's write time.
- Bench or door, by hand: scanner replug, power pull during a scan, reboot.

## Open questions

- **Q1. Pi hardware and OS.** Still needed; the architecture and TypeScript checks
  depend on it.
- **S1. Stale view after an overnight outage. Decided by the owner: the kiosk clears
  at 23:00.** With the state saved, a reboot no longer clears yesterday's view while
  offline, so someone auto-closed at 23:00 could read as inside the next morning
  until the server answers. So at 23:00, a kiosk that has not heard from the server
  since before 23:00 applies the close to its own view only. Q4 of the presence
  design records the same ruling.
  - **Time source:** the presence design's server-time sample plus elapsed
    monotonic time, and the organisation's timezone from config, never the Pi's
    clock. With no sample since boot, it does nothing and the view stays stale.
  - **Sends nothing:** the server's 23:00 run stays the one close of record, and
    the backstop when the kiosk is dead or unplugged. A second close from the
    kiosk would add a competing record.
  - **Depends on** protocol 8's server-time stamps, so it ships with or after the
    presence kiosk release. One offset mechanism serves scan stamps, signing, the
    skew warning and this clear. The saved view must keep the sample.
  - **Queued rows:** a clear drops every row already queued from the view and saves
    "cleared through queue id N" in the snapshot; the overlay uses only rows above
    N. The rows still send. Queue position is used because no clock can upset it. A
    roster reply saying tonight's close has run also advances N over rows queued by
    then, so a restart before they drain does not add those people back. That
    advance is proposed and not yet modelled.
  - **Hearing tonight:** the roster reply and scan acknowledgement carry
    `lastNightlyCloseAt`. A reply counts as hearing tonight only when that is at or
    after the latest 23:00 by kiosk time. Otherwise it is a clock sample and leaves
    view and snapshot alone. The wait is capped, then the kiosk believes the roster.
    The cap is 10 minutes past 23:00, proposed and not yet modelled.
  - **After the close:** once a reply says the close ran, the overlay uses only rows
    stamped after it, and treats clock-suspect rows as before it. The second half is
    not yet modelled. Those rows are hidden only until the queue drains.
  - **Reboot stamps:** a fallback stamp is never earlier than the snapshot's write
    time, which passed at model bounds. A clock-suspect close flags any visit it
    leaves open, which is not yet modelled.
  - **Scan path:** a badge checks for a due clear before it reads the view, as well
    as the timer, since the model assumes the clear comes first.
  - **Model:** a fast Pi clock gives no wrong "Welcome" to anyone not inside at 23:00
    (complete run). Findings: `checkin-analysis/kiosk-design/findings-2026-10-31.md`.
    Not reached: the all-fixes run, a second night, a late or failed server run,
    real times, timezone and daylight saving.
- **S2. The door empties just before the web each night. Accepted by the owner
  (2026-10-31).** An online kiosk's timer clears at 23:00, before the server's run
  lands and the next poll arrives, so door and web briefly disagree. The clear has no
  link condition.

Rejected alternatives: Postgres on the Pi (one writer and a small table; adds a
server); Docker socket in the container (equals root); Balena or a reflash
(you chose in place); Chromium in the container (above).
