#!/usr/bin/env bash
set -Eeuo pipefail

# Installs the CI-built ARM64 companion and binds it to the signed-in Lain42
# user's device only. The node maintains an outbound WSS connection; no SSH
# listener or shared compute registration is configured.

readonly RELEASE_TAG='lain42-agent-v0.1.0'
readonly RELEASE_BASE="https://github.com/lilyco-42/new-api/releases/download/${RELEASE_TAG}"
API_ORIGIN='https://api.lain42.top'

usage() {
  printf 'Usage: install-radxa.sh [--api-origin https://host]\n'
}

while (($#)); do
  case "$1" in
    --api-origin)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      API_ORIGIN="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EUID" -eq 0 ]]; then
  printf 'Run this installer as your regular Radxa account, not root.\n' >&2
  exit 1
fi

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'aarch64' ]]; then
  printf 'This release is for 64-bit ARM Linux (aarch64).\n' >&2
  exit 1
fi

python3 - "$API_ORIGIN" <<'PY'
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if (
    url.scheme != "https"
    or not url.hostname
    or url.username
    or url.password
    or url.path not in ("", "/")
    or url.query
    or url.fragment
):
    raise SystemExit("Pairing requires an HTTPS site origin without credentials or a path.")
PY

for command in curl sha256sum tar python3 sudo systemctl; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

readonly username="$(id -un)"
readonly service="lain42-agent-companion@${username}.service"
readonly config_dir="$HOME/.config/lain42"
readonly env_file="$config_dir/agent-companion.env"
readonly install_dir='/opt/lain42-agent-companion'
readonly tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# Ask for system installation permission before creating the short-lived web
# pairing, so the five-minute pairing ticket is not wasted on a sudo prompt.
sudo -v

archive="$tmp_dir/lain42-agent-companion-linux-arm64.tar.gz"
checksum="$archive.sha256"
curl --fail --location --silent --show-error --retry 2 \
  --max-time 180 "$RELEASE_BASE/lain42-agent-companion-linux-arm64.tar.gz" \
  --output "$archive"
curl --fail --location --silent --show-error --retry 2 \
  --max-time 30 "$RELEASE_BASE/lain42-agent-companion-linux-arm64.tar.gz.sha256" \
  --output "$checksum"

expected_hash="$(awk 'NR == 1 { print $1 }' "$checksum")"
if [[ ! "$expected_hash" =~ ^[[:xdigit:]]{64}$ ]]; then
  printf 'The companion release checksum file is invalid.\n' >&2
  exit 1
fi
actual_hash="$(sha256sum "$archive" | awk '{ print $1 }')"
if [[ "${actual_hash,,}" != "${expected_hash,,}" ]]; then
  printf 'The companion download failed its SHA-256 check.\n' >&2
  exit 1
fi

mapfile -t archive_files < <(tar -tzf "$archive")
if [[ "${#archive_files[@]}" -ne 2 ]] ||
  [[ "${archive_files[0]}" != 'lain42-agent-companion' ]] ||
  [[ "${archive_files[1]}" != 'lain42-agent-companion@.service' ]]; then
  printf 'The companion archive contains unexpected paths.\n' >&2
  exit 1
fi
tar -xzf "$archive" -C "$tmp_dir" --no-same-owner

sudo install -d -o root -g root -m 0755 "$install_dir"
sudo install -o root -g root -m 0755 \
  "$tmp_dir/lain42-agent-companion" \
  "$install_dir/lain42-agent-companion"
sudo install -o root -g root -m 0644 \
  "$tmp_dir/lain42-agent-companion@.service" \
  '/etc/systemd/system/lain42-agent-companion@.service'
sudo systemctl daemon-reload

mkdir -p "$config_dir"
chmod 0700 "$config_dir"

if [[ ! -s "$env_file" ]] || ! grep -q '^LAIN42_AGENT_CREDENTIAL=' "$env_file"; then
  if [[ ! -r /dev/tty ]]; then
    printf 'A terminal is required to enter the short-lived pairing ticket.\n' >&2
    exit 1
  fi

  read -r -s -p 'Short-lived pairing ticket: ' PAIRING_TICKET </dev/tty
  printf '\n'
  export API_ORIGIN

  pairing_fields="$(python3 - 3<<<"$PAIRING_TICKET" <<'PY'
import json
import os
import urllib.request
from urllib.parse import urlsplit

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

api_origin = os.environ["API_ORIGIN"].rstrip("/")
pairing_ticket = os.read(3, 4096).decode("utf-8").rstrip("\n")
if urlsplit(api_origin).scheme != "https":
    raise SystemExit("Pairing requires HTTPS.")
payload = json.dumps({
    "pairing_ticket": pairing_ticket,
    "device_name": "radxa-a7a",
    "device_public_key": "radxa-a7a-" + os.uname().nodename,
}).encode()
request = urllib.request.Request(
    api_origin + "/api/agent/pairings/claim",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler)
    with opener.open(request, timeout=20) as response:
        result = json.load(response)
except Exception:
    raise SystemExit("Pairing claim failed. Create a fresh ticket and try again.")
if result.get("success") is False:
    raise SystemExit("Pairing claim was rejected. Create a fresh ticket and try again.")
data = result.get("data", result)
fields = (data.get("id"), data.get("confirmation_ticket"), data.get("redeem_ticket"))
if not all(isinstance(field, (str, int)) and str(field) for field in fields):
    raise SystemExit("The pairing service returned an incomplete response.")
print("\t".join(map(str, fields)))
PY
  )"
  unset PAIRING_TICKET
  IFS=$'\t' read -r PAIRING_ID CONFIRMATION_TICKET REDEEM_TICKET <<<"$pairing_fields"
  unset pairing_fields
  if [[ ! "$PAIRING_ID" =~ ^[1-9][0-9]*$ || -z "$CONFIRMATION_TICKET" || -z "$REDEEM_TICKET" ]]; then
    printf 'The pairing service returned invalid tickets.\n' >&2
    exit 1
  fi

  printf 'Pairing ID: %s\nConfirmation ticket: %s\n' "$PAIRING_ID" "$CONFIRMATION_TICKET"
  unset CONFIRMATION_TICKET
  printf '\nConfirm this device in the Agent page, then return here.\n'
  read -r -p 'Press Enter after you confirm the pairing: ' _ </dev/tty

  PAIRING_ID="$PAIRING_ID" API_ORIGIN="$API_ORIGIN" \
    python3 - 3<<<"$REDEEM_TICKET" <<'PY'
import json
import os
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

api_origin = os.environ["API_ORIGIN"].rstrip("/")
redeem_ticket = os.read(3, 4096).decode("utf-8").rstrip("\n")
if urlsplit(api_origin).scheme != "https":
    raise SystemExit("Pairing requires HTTPS.")
payload = json.dumps({
    "pairing_id": int(os.environ["PAIRING_ID"]),
    "redeem_ticket": redeem_ticket,
}).encode()
request = urllib.request.Request(
    api_origin + "/api/agent/pairings/redeem",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler)
    with opener.open(request, timeout=20) as response:
        result = json.load(response)
except Exception:
    raise SystemExit("Pairing redemption failed. Check the website and retry.")
if result.get("success") is False:
    raise SystemExit("Pairing redemption was rejected. Revoke the old device and pair again.")
data = result.get("data", result)
device = data.get("device") or {}
device_id = device.get("id")
credential = data.get("credential")
if not isinstance(device_id, int) or device_id <= 0 or not isinstance(credential, str) or not credential:
    raise SystemExit("The pairing service returned an incomplete device credential.")

config_dir = Path.home() / ".config" / "lain42"
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(config_dir, 0o700)
env_path = config_dir / "agent-companion.env"
gh_config_dir = config_dir / "gh" / "radxa-a7a"
gh_config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(gh_config_dir, 0o700)

def env_value(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SystemExit("The pairing service returned invalid environment data.")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

contents = "\n".join((
    "LAIN42_AGENT_DEVICE_ID=" + env_value(str(device_id)),
    "LAIN42_AGENT_CREDENTIAL=" + env_value(credential),
    "LAIN42_AGENT_PROFILE=" + env_value("radxa-a7a"),
    "LAIN42_GH_CONFIG_DIR=" + env_value(str(gh_config_dir)),
    "",
))
temporary_path = config_dir / ".agent-companion.env.tmp"
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(temporary_path, flags, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as stream:
    stream.write(contents)
os.chmod(temporary_path, 0o600)
os.replace(temporary_path, env_path)
os.chmod(env_path, 0o600)
print("Device credential stored with owner-only permissions.")
PY
  unset PAIRING_ID REDEEM_TICKET
fi

sudo systemctl enable "$service" >/dev/null
if sudo systemctl is-active --quiet "$service"; then
  sudo systemctl restart "$service"
else
  sudo systemctl start "$service"
fi

if ! sudo systemctl is-active --quiet "$service"; then
  printf 'The companion was installed, but the service did not start. Inspect it with:\n  sudo journalctl -u %s -n 50 --no-pager\n' "$service" >&2
  exit 1
fi

printf 'Lain42 Agent companion is installed and active for this account.\n'
printf 'It connects outbound over WSS and remains private to your Lain42 account.\n'
printf 'Service: %s\n' "$service"
