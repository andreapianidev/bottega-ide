#!/bin/zsh
# Alza il numero di build della Bottega. Va lanciato in ogni commit che cambia l'app.
#   scripts/bump-build.sh            build +1
#   scripts/bump-build.sh 0.2.0      build +1 e nuova versione
set -euo pipefail
ROOT=${0:A:h:h}
python3 - "$ROOT/bottega.json" "${1:-}" <<'PY'
import json, sys
p, v = sys.argv[1], sys.argv[2]
d = json.load(open(p)); d["build"] += 1
if v: d["version"] = v
for e in ("extensions/bottega-home/package.json", "extensions/bottega-theme/package.json"):
    q = p.rsplit("/", 1)[0] + "/" + e; x = json.load(open(q)); x["version"] = d["version"]
    json.dump(x, open(q, "w"), indent=2, ensure_ascii=False); open(q, "a").write("\n")
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
print(f"Bottega {d['version']} build {d['build']}")
PY
