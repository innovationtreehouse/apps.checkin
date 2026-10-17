#!/usr/bin/env python3
import sys

try:
    import evdev
except ImportError:
    print("Error: evdev not installed. Run: sudo apt install python3-evdev")
    sys.exit(1)

def test_discovery(pattern):
    print(f"Searching for devices matching: '{pattern}'")
    devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
    found = False
    
    for d in devices:
        match = False
        if d.path == pattern:
            match = True
        elif pattern.lower() in d.name.lower():
            match = True
            
        if match:
            print(f"  [MATCH] Path: {d.path}, Name: {d.name}")
            found = True
        else:
            print(f"  [SKIP ] Path: {d.path}, Name: {d.name}")
            
    if not found:
        print("\nNo devices matched the pattern.")
    else:
        print("\nDiscovery successful!")

if __name__ == "__main__":
    pattern = sys.argv[1] if len(sys.argv) > 1 else "Barcode"
    test_discovery(pattern)
