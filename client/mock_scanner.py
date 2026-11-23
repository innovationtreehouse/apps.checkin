import requests
import json
import time
import argparse

API_URL = "http://localhost:3002/api/scan"

def scan_badge(person_id: int):
    print(f"Pinging scanner API for Person ID: {person_id}")
    payload = {"personId": person_id}
    headers = {"Content-Type": "application/json"}
    
    try:
        response = requests.post(API_URL, json=payload, headers=headers)
        
        if response.status_code == 200:
            data = response.json()
            message = data.get("message")
            action_type = data.get("type")
            participant = data.get("participant", {}).get("email", "Unknown")
            print(f"[{action_type.upper()}] Success! {message} for {participant}")
        else:
            print(f"Failed! Status Code: {response.status_code}")
            print(response.text)
    except Exception as e:
        print(f"Error connecting to the API: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mock a Raspberry Pi Badge Scanner for CheckMeIn-next")
    parser.add_argument("--id", type=int, required=True, help="The Person ID to scan")
    args = parser.parse_args()
    
    scan_badge(args.id)
