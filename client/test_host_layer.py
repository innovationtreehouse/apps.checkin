"""Decisions of client/host/kioskctl, driven through fakes on PATH."""
import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KIOSKCTL = os.path.join(HERE, "host", "kioskctl")

A = "sha256:" + "a" * 64
B = "sha256:" + "b" * 64
C = "sha256:" + "c" * 64

FAKES = {
    "docker": r"""#!/usr/bin/env bash
echo "docker $*" >>"$FAKE/log"
case "$1" in
  buildx) tag=${4##*:}; cat "$FAKE/tags/$tag" 2>/dev/null || exit 1 ;;
  pull) [ ! -e "$FAKE/pull_fails" ] ;;
  exec)
    [ "$3" = touch ] && exit 0
    digest=$(sed -n 's/^KIOSK_DIGEST=//p' "$KIOSK_STATE_DIR/current.env")
    ! grep -qs "$digest" "$FAKE/bad"
    ;;
  images) cat "$FAKE/images" 2>/dev/null ;;
esac
""",
    "systemctl": r"""#!/usr/bin/env bash
echo "systemctl $* urgent=$(cat "$KIOSK_STATE_DIR/urgent" 2>/dev/null)" >>"$FAKE/log"
""",
    "date": 'cat "$FAKE/hour"\n',
    "sleep": "",
    "flock": 'echo "flock $*" >>"$FAKE/log"\n[ ! -e "$FAKE/lock_held" ]\n',
}


class KioskctlTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.fake = tmp.name
        self.state = os.path.join(self.fake, "state")
        os.mkdir(self.state)
        os.mkdir(os.path.join(self.fake, "tags"))
        self.bin = os.path.join(self.fake, "bin")
        os.mkdir(self.bin)
        for name, body in FAKES.items():
            path = os.path.join(self.bin, name)
            with open(path, "w") as f:
                f.write(body if body.startswith("#!") else "#!/usr/bin/env bash\n" + body)
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        self.conf = os.path.join(self.fake, "host.conf")
        self.write_conf()
        self.write(self.state, "current.env", f"KIOSK_DIGEST={A}\n")
        self.set_hour("23")

    def write(self, directory, name, text):
        with open(os.path.join(directory, name), "w") as f:
            f.write(text)

    def write_conf(self, health="healthcheck --local", release_tag="kiosk-release"):
        self.write(self.fake, "host.conf", (
            "KIOSK_IMAGE=ghcr.io/example/kiosk\n"
            f"KIOSK_RELEASE_TAG={release_tag}\n"
            "KIOSK_URGENT_TAG=kiosk-urgent\n"
            f'KIOSK_HEALTH_CMD="{health}"\n'
            "KIOSK_HEALTH_TIMEOUT=9\n"
        ))

    def set_hour(self, hour):
        self.write(self.fake, "hour", hour + "\n")

    def set_tag(self, tag, digest):
        self.write(os.path.join(self.fake, "tags"), tag, digest + "\n")

    def mark_bad(self, digest):
        self.write(self.fake, "bad", digest + "\n")

    def run_ctl(self, *args):
        env = dict(os.environ, FAKE=self.fake, KIOSK_CONF=self.conf, KIOSK_STATE_DIR=self.state,
                   PATH=self.bin + os.pathsep + os.environ["PATH"])
        return subprocess.run([KIOSKCTL, *args], env=env, capture_output=True, text=True).returncode

    def state_of(self, name):
        try:
            with open(os.path.join(self.state, name)) as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""

    def current(self):
        return self.state_of("current.env").removeprefix("KIOSK_DIGEST=")

    def log(self):
        try:
            with open(os.path.join(self.fake, "log")) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def restarts(self):
        return [line for line in self.log() if line.startswith("systemctl restart")]

    def test_good_image_swaps_inside_window(self):
        self.set_tag("kiosk-release", B)
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.current(), B)
        self.assertEqual(self.state_of("previous"), A)
        self.assertEqual(len(self.restarts()), 1)
        self.assertIn(f"docker pull ghcr.io/example/kiosk@{B}", self.log())
        self.assertIn("docker exec kiosk-client touch /data/.chromium-bounce", self.log())

    def test_same_digest_does_nothing(self):
        self.set_tag("kiosk-release", A)
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.restarts(), [])

    def test_bad_image_rolls_back_and_is_not_retried(self):
        self.set_tag("kiosk-release", B)
        self.mark_bad(B)
        self.assertEqual(self.run_ctl("check-release"), 1)
        self.assertEqual(self.current(), A)
        self.assertEqual(self.state_of("failed"), B)
        self.assertEqual(len(self.restarts()), 2)
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(len(self.restarts()), 2)

    def test_offline_moves_nothing(self):
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.current(), A)
        self.assertEqual(self.restarts(), [])
        self.assertEqual(self.state_of("failed"), "")

    def test_failed_pull_moves_nothing(self):
        self.set_tag("kiosk-release", B)
        self.write(self.fake, "pull_fails", "")
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.current(), A)
        self.assertEqual(self.restarts(), [])

    def test_window_edges(self):
        self.set_tag("kiosk-release", B)
        for hour in ("22", "06", "14"):
            self.set_hour(hour)
            self.assertEqual(self.run_ctl("check-release"), 0)
            self.assertEqual(self.current(), A, hour)
        for hour, digest in (("05", B), ("00", C)):
            self.set_hour(hour)
            self.set_tag("kiosk-release", digest)
            self.assertEqual(self.run_ctl("check-release"), 0)
            self.assertEqual(self.current(), digest, hour)

    def test_force_applies_outside_window(self):
        self.set_hour("14")
        self.set_tag("kiosk-urgent", B)
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.current(), B)
        self.assertEqual(self.state_of("urgent"), B)

    def test_failed_force_rolls_back_once_and_newer_force_applies(self):
        self.set_hour("14")
        self.set_tag("kiosk-urgent", B)
        self.set_tag("kiosk-release", B)
        self.mark_bad(B)
        self.assertEqual(self.run_ctl("check-urgent"), 1)
        self.assertEqual(self.current(), A)
        self.assertEqual(len(self.restarts()), 2)
        self.assertIn(f"urgent={B}", self.restarts()[0])

        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.set_hour("23")
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(len(self.restarts()), 2)
        self.assertEqual(self.current(), A)

        self.set_tag("kiosk-urgent", C)
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.current(), C)

    def test_force_during_outage_applies_on_reconnect(self):
        self.set_tag("kiosk-urgent", B)
        self.write(self.fake, "pull_fails", "")
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.state_of("urgent"), "")
        self.assertEqual(self.current(), A)
        os.remove(os.path.join(self.fake, "pull_fails"))
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.current(), B)

    def test_force_of_running_digest_records_without_restart(self):
        self.set_tag("kiosk-urgent", A)
        self.assertEqual(self.run_ctl("check-urgent"), 0)
        self.assertEqual(self.state_of("urgent"), A)
        self.assertEqual(self.restarts(), [])

    def test_going_back_sticks_through_the_nightly_check(self):
        self.set_tag("kiosk-release", B)
        self.run_ctl("check-release")
        self.assertEqual(self.run_ctl("back"), 0)
        self.assertEqual(self.current(), A)
        self.assertEqual(self.state_of("previous"), B)
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.current(), A)

    def test_deploy_rolls_back_a_bad_digest(self):
        self.mark_bad(B)
        self.assertEqual(self.run_ctl("deploy", B), 1)
        self.assertEqual(self.current(), A)

    def test_deploy_rejects_anything_but_a_digest(self):
        self.assertEqual(self.run_ctl("deploy", "latest"), 1)
        self.assertEqual(self.log(), [])

    def test_unset_health_command_moves_nothing(self):
        self.write_conf(health="")
        self.set_tag("kiosk-release", B)
        self.assertEqual(self.run_ctl("check-release"), 1)
        self.assertEqual(self.log(), [])

    def test_tag_name_comes_from_host_config(self):
        self.write_conf(release_tag="kiosk-canary")
        self.set_tag("kiosk-release", B)
        self.set_tag("kiosk-canary", C)
        self.assertEqual(self.run_ctl("check-release"), 0)
        self.assertEqual(self.current(), C)

    def test_prune_keeps_current_and_previous(self):
        self.write(self.fake, "images", "".join(
            f"ghcr.io/example/kiosk@{d}\n" for d in (A, B, C)))
        self.set_tag("kiosk-release", B)
        self.run_ctl("check-release")
        rmis = [line for line in self.log() if line.startswith("docker rmi")]
        self.assertEqual(rmis, [f"docker rmi ghcr.io/example/kiosk@{C}"])

    def reboot_steps(self):
        return [line.split(" urgent=")[0] for line in self.log()]

    def test_reboot_waits_for_the_update_lock_first(self):
        self.assertEqual(self.run_ctl("reboot"), 0)
        self.assertEqual(self.reboot_steps(), ["flock -w 1800 9", "systemctl reboot"])
        self.assertTrue(os.path.exists(os.path.join(self.state, "lock")))

    def test_reboot_still_happens_when_the_lock_stays_held(self):
        self.write(self.fake, "lock_held", "")
        self.assertEqual(self.run_ctl("reboot"), 0)
        self.assertEqual(self.reboot_steps(), ["flock -w 1800 9", "systemctl reboot"])

    def test_reboot_does_not_need_a_health_command(self):
        self.write_conf(health="")
        self.assertEqual(self.run_ctl("reboot"), 0)
        self.assertIn("systemctl reboot", self.reboot_steps())

    def test_reboot_unit_goes_through_kioskctl(self):
        with open(os.path.join(HERE, "host", "kiosk-reboot.service")) as f:
            self.assertIn("ExecStart=/usr/local/bin/kioskctl reboot\n", f.read())

    def test_state_stays_outside_the_containers_data_mount(self):
        with open(KIOSKCTL) as f:
            self.assertIn("STATE=${KIOSK_STATE_DIR:-/var/lib/kiosk-host}\n", f.read())
        with open(os.path.join(HERE, "host", "kiosk-client.service")) as f:
            unit = f.read()
        self.assertIn("EnvironmentFile=/var/lib/kiosk-host/current.env\n", unit)
        self.assertIn("-v /var/lib/kiosk:/data \\\n", unit)

    def test_example_health_command_runs_the_script_in_the_image(self):
        with open(os.path.join(HERE, "host", "host.conf.example")) as f:
            self.assertIn('KIOSK_HEALTH_CMD="python /app/healthcheck.py"\n', f.read())
        with open(os.path.join(HERE, "Dockerfile")) as f:
            copies = [line for line in f if line.startswith("COPY") and "healthcheck.py" in line]
        self.assertEqual(len(copies), 1)
        self.assertTrue(copies[0].rstrip().endswith(" /app/"))


if __name__ == "__main__":
    unittest.main()
