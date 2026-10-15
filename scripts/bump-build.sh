#!/bin/zsh
# Alza il numero di build della Bottega (e della Bottega per iPhone). Va lanciato in ogni commit che cambia l'app.
#   scripts/bump-build.sh                  build +1
#   scripts/bump-build.sh 0.2.0            build +1 e nuova versione di Moony IDE
#   scripts/bump-build.sh --moony 4.0.2    build +1 e nuova versione di Moony AI per iPhone
# Dal 16/10/2026 Moony AI per iPhone ha la versione di Moony AI per Mac (`moonyAI` in bottega.json, Andrea: «da oggi
# andate di pari passo»), Moony IDE la sua (`version`). La build resta una sola per IDE e iPhone.
set -euo pipefail
ROOT=${0:A:h:h}
VERSIONE="" MOONY=""
if [[ ${1:-} == --moony ]]; then MOONY=${2:?"Uso: scripts/bump-build.sh --moony 4.0.2"}; else VERSIONE=${1:-}; fi
python3 - "$ROOT/bottega.json" "$VERSIONE" "$MOONY" <<'PY'
import json, re, sys
from pathlib import Path
p, v, moony = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
# Un hotfix mobile può essere più avanti del Mac: il prossimo rilascio non deve
# mai abbassare CFBundleVersion su una delle piattaforme.
mobile = Path(p).parent / "ios/Version.xcconfig"
match = re.search(r"^CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*$", mobile.read_text(), re.MULTILINE) if mobile.exists() else None
d["build"] = max(d["build"], int(match.group(1)) if match else 0) + 1
if v: d["version"] = v
if moony: d["moonyAI"] = moony
for e in ("extensions/bottega-home/package.json", "extensions/bottega-theme/package.json"):
    q = p.rsplit("/", 1)[0] + "/" + e; x = json.load(open(q)); x["version"] = d["version"]
    json.dump(x, open(q, "w"), indent=2, ensure_ascii=False); open(q, "a").write("\n")
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
# Moony AI per iPhone: la versione di Moony AI (per Mac), la build della Bottega
ios = d.get("moonyAI", d["version"])
x = p.rsplit("/", 1)[0] + "/ios/Version.xcconfig"
open(x, "w").write("// Scritto da scripts/bump-build.sh: Moony AI per iPhone ha la versione di Moony AI per Mac (moonyAI in\n"
                   "// bottega.json) e la build della Bottega.\n"
                   f"MARKETING_VERSION = {ios}\nCURRENT_PROJECT_VERSION = {d['build']}\n")
print(f"Bottega {d['version']} build {d['build']}, Moony AI per iPhone {ios}")
PY
