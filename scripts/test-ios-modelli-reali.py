#!/usr/bin/env python3 -I
"""Prova dal vivo i modelli della chat di Moony per iPhone (ModelloChat.catalogo, ios/Bottega/Chat/ChatPura.swift) con le
chiavi del vault, con le richieste fatte come le fa l'iPhone (AssistenteTelefono.genera): streaming SSE, un solo
messaggio di sistema in testa, `reasoning_effort` a DeepSeek e Agnes e non a Mistral, lo strumento passa_parola, e
Vision con una piccola immagine in data: URL. Ogni modello riceve una domanda di una parola: costa frazioni di centesimo.
A pagamento: parte solo con BOTTEGA_TEST_REALE=1 (regola della Bottega). Non stampa mai le chiavi.
"""
import base64, json, os, pathlib, re, sys, time, urllib.request, urllib.error, zlib, struct

if os.environ.get("BOTTEGA_TEST_REALE") != "1":
    sys.exit("Chiamate reali a pagamento: lancia con BOTTEGA_TEST_REALE=1.")

def segreto(file, nome):
    if os.environ.get(nome): return os.environ[nome]
    try:
        for riga in (pathlib.Path.home() / ".secrets" / file).read_text().splitlines():
            m = re.match(rf"\s*(?:export\s+)?{nome}\s*=\s*(.*)", riga)
            if m: return m.group(1).strip().strip("\"'")
    except FileNotFoundError: pass
    return None

CHIAVI = {"deepseek": segreto("deepseek-harness.env", "DEEPSEEK_API_KEY"),
          "agnes": segreto("agnes-ai.env", "AGNES_API_KEY"),
          "mistral": segreto("avo-mistral.env", "MISTRAL_API_KEY")}
URL = {"deepseek": "https://api.deepseek.com/chat/completions",
       "agnes": "https://apihub.agnes-ai.com/v1/chat/completions",
       "mistral": "https://api.mistral.ai/v1/chat/completions"}
# lo stesso catalogo di ChatPura.swift: (id, fornitore, modello)
CATALOGO = [("flash", "deepseek", "deepseek-flash"), ("pro", "deepseek", "deepseek-v4-pro"),
            ("vision", "deepseek", "deepseek-flash"), ("agnes-3.0-flash", "agnes", "agnes-3.0-flash"),
            ("agnes-2.5-flash", "agnes", "agnes-2.5-flash"), ("mistral-small", "mistral", "mistral-small-latest"),
            ("mistral-medium", "mistral", "mistral-medium-latest"), ("mistral-large", "mistral", "mistral-large-latest"),
            ("codestral", "mistral", "codestral-latest")]

def png(lato=16):
    """Un quadrato rosso, PNG valido, in data: URL."""
    riga = b"\x00" + b"\xff\x00\x00" * lato
    dati = zlib.compress(riga * lato)
    def pezzo(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    p = b"\x89PNG\r\n\x1a\n" + pezzo(b"IHDR", struct.pack(">IIBBBBB", lato, lato, 8, 2, 0, 0, 0)) + pezzo(b"IDAT", dati) + pezzo(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(p).decode()

STRUMENTO = {"type": "function", "function": {"name": "passa_parola", "description": "Dai la parola a un altro.",
             "parameters": {"type": "object", "properties": {"a": {"type": "string", "enum": ["elliot"]}}, "required": ["a"]}}}

def prova(id_, fornitore, modello):
    chiave = CHIAVI[fornitore]
    if not chiave: return "manca la chiave nel vault"
    vede = id_ == "vision"
    domanda = "Di che colore e' l'immagine? Una parola." if vede else "Rispondi solo con la parola: ok"
    contenuto = [{"type": "text", "text": domanda}, {"type": "image_url", "image_url": {"url": png()}}] if vede else domanda
    corpo = {"model": modello, "stream": True, "max_tokens": 60,
             "messages": [{"role": "system", "content": "Sei Moony, in italiano.\n\nAdesso e' giovedi'."},
                          {"role": "user", "content": contenuto}]}
    if fornitore != "mistral": corpo["reasoning_effort"] = "none" if vede else "low"
    if not vede:
        corpo["tools"] = [STRUMENTO]; corpo["tool_choice"] = "auto"
    req = urllib.request.Request(URL[fornitore], json.dumps(corpo).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {chiave}", "Content-Type": "application/json"})
    inizio = time.time(); testo = ""
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            for riga in r:
                riga = riga.decode().strip()
                if not riga.startswith("data:"): continue
                p = riga[5:].strip()
                if p == "[DONE]": break
                try: d = json.loads(p)["choices"][0].get("delta", {})
                except (ValueError, KeyError, IndexError): continue
                testo += d.get("content") or ""
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read()[:160].decode(errors='replace')}"
    except Exception as e:
        return f"errore: {e}"
    return f"ok in {time.time() - inizio:.1f} s: {testo.strip()[:60]!r}" if testo.strip() else "risposta vuota"

def saldo():
    k = CHIAVI["deepseek"]
    if not k: return "manca la chiave"
    req = urllib.request.Request("https://api.deepseek.com/user/balance", headers={"Authorization": f"Bearer {k}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        info = json.load(r)["balance_infos"]
    i = next((x for x in info if x.get("currency") == "USD"), info[0])
    return f"${float(i['total_balance']):.2f} {i['currency']}"

falliti = 0
print(f"{'saldo DeepSeek':18} {saldo()}")
for id_, f, m in CATALOGO:
    esito = prova(id_, f, m)
    if not esito.startswith("ok"): falliti += 1
    print(f"{id_:18} {esito}")
sys.exit(1 if falliti else 0)
