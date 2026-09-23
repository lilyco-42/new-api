/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function createRadxaPairingScript(apiOrigin: string): string {
  return `set -eu
command -v python3 >/dev/null 2>&1 || { printf 'Python 3 is required on the Radxa node.\\n' >&2; exit 1; }
export LAIN42_API_URL=${shellQuote(apiOrigin)}
read -r -s -p 'Short-lived pairing ticket: ' LAIN42_PAIRING_TICKET
printf '\\n'
export LAIN42_PAIRING_TICKET

PAIRING_FIELDS=$(python3 - <<'PY'
import json
import os
import urllib.request
from urllib.parse import urlsplit

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

api_url = os.environ["LAIN42_API_URL"]
if urlsplit(api_url).scheme != "https":
    raise ValueError("Pairing requires an HTTPS site URL.")

request_body = json.dumps({
    "pairing_ticket": os.environ["LAIN42_PAIRING_TICKET"],
    "device_name": "radxa-a7a",
    "device_public_key": "radxa-a7a-" + os.uname().nodename,
}).encode()
request = urllib.request.Request(
    os.environ["LAIN42_API_URL"] + "/api/agent/pairings/claim",
    data=request_body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
opener = urllib.request.build_opener(NoRedirectHandler)
with opener.open(request, timeout=15) as response:
    payload = json.load(response)
data = payload.get("data", payload)
print(data["id"], data["confirmation_ticket"], data["redeem_ticket"], sep="\\t")
PY
)
unset LAIN42_PAIRING_TICKET
IFS="$(printf '\\t')" read -r PAIRING_ID CONFIRMATION_TICKET REDEEM_TICKET <<EOF
$PAIRING_FIELDS
EOF
unset PAIRING_FIELDS
export PAIRING_ID REDEEM_TICKET
printf 'Pairing ID: %s\\nConfirmation ticket: %s\\n' "$PAIRING_ID" "$CONFIRMATION_TICKET"
unset CONFIRMATION_TICKET
printf '\\nConfirm this pairing in the browser, then return here.\\n'
read -r -p 'Press Enter after the web page confirms: ' PAIRING_CONFIRM_INPUT

python3 - <<'PY'
import json
import os
import pathlib
import urllib.request
from urllib.parse import urlsplit

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

api_url = os.environ["LAIN42_API_URL"]
if urlsplit(api_url).scheme != "https":
    raise ValueError("Pairing requires an HTTPS site URL.")

request_body = json.dumps({
    "pairing_id": int(os.environ["PAIRING_ID"]),
    "redeem_ticket": os.environ["REDEEM_TICKET"],
}).encode()
request = urllib.request.Request(
    os.environ["LAIN42_API_URL"] + "/api/agent/pairings/redeem",
    data=request_body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
opener = urllib.request.build_opener(NoRedirectHandler)
with opener.open(request, timeout=15) as response:
    payload = json.load(response)
data = payload.get("data", payload)
device_id = data.get("device", {}).get("id")
credential = data["credential"]
config_dir = pathlib.Path.home() / ".config" / "lain42"
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(config_dir, 0o700)
env_file = config_dir / "agent-companion.env"
contents = (
    f"LAIN42_AGENT_DEVICE_ID={device_id}\\n"
    f"LAIN42_AGENT_CREDENTIAL={credential}\\n"
    "LAIN42_AGENT_PROFILE=radxa-a7a\\n"
    f"LAIN42_GH_CONFIG_DIR={pathlib.Path.home()}/.config/lain42/gh/radxa-a7a\\n"
)
fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(contents)
os.chmod(env_file, 0o600)
print(f"Credential saved with owner-only access: {env_file}")
PY
unset PAIRING_ID REDEEM_TICKET
`
}
