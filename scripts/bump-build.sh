#!/bin/zsh
# Alza il numero di build della Bottega (e della Bottega per iPhone). Va lanciato in ogni commit che cambia l'app.
#   scripts/bump-build.sh            build +1
#   scripts/bump-build.sh 0.2.0      build +1 e nuova versione
set -euo pipefail
ROOT=${0:A:h:h}
python3 - "$ROOT/bottega.json" "${1:-}" <<'PY'
import json, re, sys
from pathlib import Path
p, v = sys.argv[1], sys.argv[2]
d = json.load(open(p))
# Un hotfix mobile può essere più avanti del Mac: il prossimo rilascio non deve
# mai abbassare CFBundleVersion su una delle piattaforme.
mobile = Path(p).parent / "ios/Version.xcconfig"
match = re.search(r"^CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*$", mobile.read_text(), re.MULTILINE) if mobile.exists() else None
d["build"] = max(d["build"], int(match.group(1)) if match else 0) + 1
if v: d["version"] = v
for e in ("extensions/bottega-home/package.json", "extensions/bottega-theme/package.json"):
    q = p.rsplit("/", 1)[0] + "/" + e; x = json.load(open(q)); x["version"] = d["version"]
    json.dump(x, open(q, "w"), indent=2, ensure_ascii=False); open(q, "a").write("\n")
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
# la Bottega per iPhone ha la stessa versione e la stessa build
x = p.rsplit("/", 1)[0] + "/ios/Version.xcconfig"
open(x, "w").write("// Scritto da scripts/bump-build.sh: la Bottega per iPhone ha sempre la versione e la build della Bottega.\n"
                   f"MARKETING_VERSION = {d['version']}\nCURRENT_PROJECT_VERSION = {d['build']}\n")
print(f"Bottega {d['version']} build {d['build']}")
PY
