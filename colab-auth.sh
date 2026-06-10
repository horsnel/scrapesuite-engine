#!/bin/bash
# ScrapeSuite Engine — Google Colab CLI Authentication Helper
# Run this script and follow the prompts to authenticate with Google.
#
# Usage: bash colab-auth.sh
#
# After successful auth, the colab CLI will be able to provision Colab VMs.

set -e

export PATH="/home/z/google-cloud-sdk/bin:$HOME/.local/bin:$PATH"

SCOPES="openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory"

echo "=============================================="
echo "  ScrapeSuite — Colab CLI Auth Setup"
echo "=============================================="
echo ""
echo "This will authenticate you with Google so the"
echo "Colab CLI can provision VMs for testing."
echo ""

# Check if already authenticated
if gcloud auth application-default print-access-token &>/dev/null; then
    echo "You're already authenticated!"
    echo ""
    colab whoami 2>/dev/null || echo "(colab whoami failed — may need re-auth)"
    exit 0
fi

echo "Step 1: Visit this URL on your phone/browser:"
echo ""
gcloud auth application-default login --no-launch-browser --scopes="$SCOPES" 2>&1 | head -5 | grep "https://" || true

echo ""
echo "Step 2: After signing in, you'll be redirected to a page with a code."
echo "        Copy that code and paste it below."
echo ""

# Alternative: use a file-based approach
echo "If you can't paste interactively, put the code in /tmp/auth_code.txt"
echo "Then run: bash colab-auth.sh --from-file"
echo ""

if [ "$1" = "--from-file" ]; then
    CODE=$(cat /tmp/auth_code.txt 2>/dev/null || true)
    if [ -z "$CODE" ]; then
        echo "ERROR: No code found in /tmp/auth_code.txt"
        exit 1
    fi
    echo "$CODE" | gcloud auth application-default login --no-launch-browser --scopes="$SCOPES"
else
    gcloud auth application-default login --no-launch-browser --scopes="$SCOPES"
fi

echo ""
echo "Step 3: Verify authentication"
colab whoami 2>/dev/null && echo "Auth successful!" || echo "Auth may have failed. Check above for errors."
