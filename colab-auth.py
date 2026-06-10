#!/usr/bin/env python3.13
"""
ScrapeSuite Engine — Google Colab CLI Authentication
=====================================================
2-step auth from your phone:
  1. Visit the URL → sign in → the redirect will FAIL (that's OK!)
  2. Copy the code from the URL bar and tell me

Then: python3.13 /home/z/my-project/colab-auth.py --complete
"""

import json
import os
import sys
import urllib.parse
import urllib.request

# From colab-cli's bundled oauth_config.json
CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com"
CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty"
# This client is registered with http://localhost as the redirect URI
REDIRECT_URI = "http://localhost"

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/colaboratory",
]


def get_auth_url():
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"https://accounts.google.com/o/oauth2/auth?{urllib.parse.urlencode(params)}"


def exchange_code(code):
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def save_credentials(token_resp):
    # ADC format
    adc_creds = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": token_resp.get("refresh_token", ""),
        "type": "authorized_user",
    }
    adc_path = os.path.expanduser("~/.config/gcloud/application_default_credentials.json")
    os.makedirs(os.path.dirname(adc_path), exist_ok=True)
    with open(adc_path, "w") as f:
        json.dump(adc_creds, f, indent=2)
    os.chmod(adc_path, 0o600)
    print(f"  Saved ADC: {adc_path}")

    # Colab CLI token format
    token_data = {
        "token": token_resp.get("access_token", ""),
        "refresh_token": token_resp.get("refresh_token", ""),
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scopes": " ".join(SCOPES),
        "expiry": "",
    }
    token_path = os.path.expanduser("~/.config/colab-cli/token.json")
    os.makedirs(os.path.dirname(token_path), exist_ok=True)
    with open(token_path, "w") as f:
        json.dump(token_data, f, indent=2)
    print(f"  Saved token: {token_path}")


def step1():
    url = get_auth_url()
    print("=" * 60)
    print("  STEP 1: Tap this URL on your phone")
    print("=" * 60)
    print()
    print(url)
    print()
    print("=" * 60)
    print("  STEP 2: After signing in, your browser will try to")
    print("  redirect to localhost and FAIL. That's EXPECTED!")
    print()
    print("  Look at your browser's ADDRESS BAR. It will look like:")
    print("    http://localhost/?code=4/0AXXXX...&scope=...")
    print()
    print("  Copy the 'code' part (everything between 'code=' and '&')")
    print("  Then tell me the code.")
    print("=" * 60)


def step2(code):
    code = code.strip()
    print(f"  Exchanging code for tokens...")
    try:
        token_resp = exchange_code(code)
    except Exception as e:
        print(f"  Token exchange failed: {e}")
        return 1

    if "refresh_token" not in token_resp:
        print(f"  No refresh token. Response: {json.dumps(token_resp)[:300]}")
        return 1

    save_credentials(token_resp)

    print("\n  Verifying...")
    os.environ["PATH"] = f"/home/z/google-cloud-sdk/bin:/home/z/.local/bin:{os.environ.get('PATH', '')}"
    verify = os.popen("gcloud auth application-default print-access-token 2>&1").read().strip()
    if len(verify) > 20:
        print(f"  Access token: {verify[:20]}...")
        print()
        print("=" * 60)
        print("  SUCCESS! Colab CLI is ready.")
        print("=" * 60)
        print()
        print("  Test:  colab sessions")
        print("  Run:   colab run colab-test.py")
        return 0
    else:
        print(f"  Result: {verify}")
        print("  Credentials saved - try: colab sessions")
        return 1


def main():
    if len(sys.argv) > 1:
        code = sys.argv[1]
        if code == "--complete":
            # Read code from file
            try:
                with open("/tmp/auth_code.txt") as f:
                    code = f.read().strip()
                os.remove("/tmp/auth_code.txt")
            except FileNotFoundError:
                print("  No code file. Usage: colab-auth.py YOUR_CODE")
                return 1
        elif code == "--url":
            print(get_auth_url())
            return 0
        return step2(code)
    else:
        step1()
        return 0


if __name__ == "__main__":
    sys.exit(main())
