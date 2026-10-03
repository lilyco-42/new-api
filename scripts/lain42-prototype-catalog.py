"""Actions-only, bounded metadata read. Catalog presence is not inference proof."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

key = os.environ.get("LAIN42_PROTOTYPE_NVIDIA_KEY", "")
if not key.startswith("nvapi-"):
    raise SystemExit("Missing authorized prototype credential")

result = {"scope": "Provider catalog metadata only; no inference or entitlement proof"}
request = urllib.request.Request("https://integrate.api.nvidia.com/v1/models",
                                 headers={"Authorization": "Bearer " + key})
try:
    # Never follow redirects with the credential. Request only the fixed host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise ValueError("oversized catalog")
        catalog = json.loads(payload)
        ids = {row.get("id") for row in catalog.get("data", []) if isinstance(row, dict)}
        candidates = ["deepseek-ai/deepseek-v4-flash-0731", "nvidia/deepseek-v4.1-flash",
                      "nvidia/nemotron-3-super-120b-a12b",
                      "nvidia/nemotron-3.5-lightning-30b-a3b", "moonshotai/kimi-k3"]
        result.update(status=response.status, candidates={model: model in ids for model in candidates})
except urllib.error.HTTPError as error:
    result["status"] = error.code
except (OSError, ValueError, TypeError):
    result["status"] = "unavailable"

directory = Path(os.environ["LAIN42_PROTOTYPE_EVIDENCE_DIR"])
directory.mkdir(parents=True, exist_ok=True)
(directory / "catalog.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
if result["status"] != 200:
    raise SystemExit("Catalog read failed; do not infer that missing data means no usable models")
