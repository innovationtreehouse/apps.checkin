"""Stands in for python-evdev in the kiosk flow tests, put first on PYTHONPATH at
run time so the image stays unchanged. One scanner whose badge reads are lines
written to a FIFO in /data."""

import os

FIFO = "/data/badges"
DEVICE_PATH = "/dev/input/fake0"
ENTER = 28
SCANCODES = {"1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11}


class ecodes:
    EV_KEY = 1


class _KeyDown:
    type = ecodes.EV_KEY
    keystate = 1

    def __init__(self, scancode):
        self.scancode = scancode


def categorize(event):
    return event


def list_devices():
    return [DEVICE_PATH]


class InputDevice:
    def __init__(self, path):
        self.path = path
        self.name = "Fake scanner"
        if not os.path.exists(FIFO):
            os.mkfifo(FIFO)
        # Opened read-write and before grab(): a test writes only once the kiosk
        # reports the scanner held, so its write never blocks, and no writer
        # closing ever reads as end of file.
        self._reads = os.fdopen(os.open(FIFO, os.O_RDWR), "r")

    def grab(self):
        pass

    def ungrab(self):
        pass

    def close(self):
        self._reads.close()

    def read_loop(self):
        for line in self._reads:
            for digit in line.strip():
                yield _KeyDown(SCANCODES[digit])
            yield _KeyDown(ENTER)
