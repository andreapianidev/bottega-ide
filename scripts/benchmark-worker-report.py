#!/usr/bin/env python3
"""Summarize synthetic reports. Compute timings never imply end-to-end benefit."""
import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path


def load(path):
    file = Path(path)
    if file.stat().st_size > 10_000_000:
        raise ValueError("Report oltre 10 MB")
    report = json.loads(file.read_text())
    if report.get("schemaVersion") != 1 or not isinstance(report.get("samples"), list):
        raise ValueError("Schema report non riconosciuto")
    return report


def summarize(report):
    operations = {}
    for operation in ("embeddings", "ocr"):
        samples = [row for row in report["samples"] if row["operation"] == operation]
        if not samples:
            continue
        times = [row["elapsedMs"] for row in samples]
        if any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in times):
            raise ValueError("Timing non valido")
        warm = [row["elapsedMs"] for row in samples if row["iteration"] > 1]
        operations[operation] = {
            "count": len(samples), "first_in_process_ms": times[0],
            "median_ms": statistics.median(times), "min_ms": min(times), "max_ms": max(times),
            "warm_median_ms": statistics.median(warm) if warm else None,
            "quality_passed": all(row["qualityPassed"] for row in samples),
            "peak_resident_bytes": max(row["peakResidentBytes"] for row in samples),
            "median_process_cpu_ms": statistics.median(row["cpuMs"] for row in samples),
            "thermal_states": sorted(set(row["thermal"] for row in samples)),
        }
    return {"environment": report["environment"], "operations": operations,
            "stopped_reason": report.get("stoppedReason"), "dataset_sha256": report["datasetSHA256"]}


def compare(mac, phone):
    same_dataset = mac["datasetSHA256"] == phone["datasetSHA256"]
    output = {"same_dataset": same_dataset, "end_to_end_benefit": "not measured",
              "network_transfer_ms": None,
              "decision": "Production queue remains unjustified until authenticated transfer and representative Mac workload are measured."}
    if not same_dataset:
        output["comparison_rejected"] = "Dataset diversi: copiare lo stesso benchmark-worker-dataset.json sul telefono."
        return output
    if mac.get("implementation") != phone.get("implementation"):
        output["comparison_rejected"] = "Implementazioni del benchmark differenti."
        return output
    a, b = summarize(mac), summarize(phone)
    output["compute_only"] = {}
    for operation in set(a["operations"]) & set(b["operations"]):
        if operation == "ocr" and mac.get("visionRevision") != phone.get("visionRevision"):
            output["compute_only"][operation] = {"comparison_rejected": "Revisioni Vision differenti."}
            continue
        left, right = a["operations"][operation], b["operations"][operation]
        output["compute_only"][operation] = {
            "mac_warm_median_ms": left["warm_median_ms"], "phone_warm_median_ms": right["warm_median_ms"],
            "both_quality_passed": left["quality_passed"] and right["quality_passed"],
        }
    left, right = mac.get("probeVectors"), phone.get("probeVectors")
    if left is not None and right is not None:
        shape_ok = (isinstance(mac.get("embeddingDimension"), int) and mac["embeddingDimension"] > 0
                    and len(left) == len(right) == 12
                    and mac.get("embeddingDimension") == phone.get("embeddingDimension")
                    and mac.get("embeddingRevision") == phone.get("embeddingRevision")
                    and all(len(row) == mac.get("embeddingDimension") for row in left + right))
        if shape_ok:
            values = [(x, y) for row1, row2 in zip(left, right) for x, y in zip(row1, row2)]
            finite = all(math.isfinite(x) and math.isfinite(y) for x, y in values)
            error = max(abs(x - y) for x, y in values) if finite else None
            output["embedding_probe"] = {"same_revision_and_dimension": True, "max_absolute_error": error,
                                         "probe_compatible_at_1e_4": finite and error <= 1e-4,
                                         "index_compatibility_proven": False}
        else:
            output["embedding_probe"] = {"same_revision_and_dimension": False, "index_compatibility_proven": False}
    return output


def verify_dataset(report, path):
    """Verify a persisted real run against its fixture, independently of the Swift encoder."""
    dataset = json.loads(Path(path).read_text())
    canonical = json.dumps(dataset, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    if hashlib.sha256(canonical).hexdigest() != report["datasetSHA256"]:
        raise ValueError("Il rapporto non appartiene al dataset fornito")
    if report.get("stoppedReason") or not report["samples"]:
        raise ValueError("Prova interrotta o senza campioni")
    if any(not sample["qualityPassed"] for sample in report["samples"]):
        raise ValueError("La prova contiene campioni con qualità insufficiente")
    rows = report.get("probeVectors")
    if rows is not None:
        dimension = report.get("embeddingDimension")
        if len(rows) != len(dataset["texts"]) or not dimension:
            raise ValueError("Numero di vettori/dimensione non valido")
        for text, row in zip(dataset["texts"], rows):
            if len(row) != dimension or any(not math.isfinite(value) for value in row):
                raise ValueError("Vettore non finito o dimensione non valida")
            norm = math.sqrt(sum(value * value for value in row))
            expected = 1 if text.strip() else 0
            if abs(norm - expected) > 1e-4:
                raise ValueError("Norma del vettore non conforme al contratto")
    recognized = report.get("recognizedTexts")
    if recognized is not None and len(recognized) != len(dataset["images"]):
        raise ValueError("Numero di risultati OCR non valido")
    return {"dataset_hash_matches": True, "samples_quality_passed": True,
            "vectors_checked": len(rows) if rows is not None else 0,
            "ocr_images_checked": len(recognized) if recognized is not None else 0}


def self_test():
    # These protect the decision boundary: mismatched fixtures/models cannot authorize routing.
    base = {"schemaVersion": 1, "samples": [], "environment": {}, "datasetSHA256": "same",
            "embeddingDimension": 2, "embeddingRevision": 1, "probeVectors": [[1, 0]] * 12}
    different = dict(base, datasetSHA256="other")
    assert "comparison_rejected" in compare(base, different)
    assert compare(base, base)["embedding_probe"]["probe_compatible_at_1e_4"]
    assert not compare(base, dict(base, embeddingRevision=2))["embedding_probe"]["same_revision_and_dimension"]
    assert not compare(base, dict(base, probeVectors=[[float("nan"), 0]] * 12))["embedding_probe"]["probe_compatible_at_1e_4"]
    assert compare(base, base)["end_to_end_benefit"] == "not measured"
    assert not compare(base, base)["embedding_probe"]["index_compatibility_proven"]
    assert "comparison_rejected" in compare(base, dict(base, implementation="different"))
    assert not compare(base, dict(base, embeddingDimension=0))["embedding_probe"]["same_revision_and_dimension"]
    print("8 invarianti del confronto: ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="*")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dataset", help="verifica hash e invarianti dei rapporti reali contro la fixture persistita")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not 1 <= len(args.reports) <= 2:
        parser.error("indicare report Mac e, facoltativamente, report iPhone")
    reports = [load(path) for path in args.reports]
    result = {"mac": summarize(reports[0])}
    if args.dataset:
        result["persisted_report_verification"] = [verify_dataset(report, args.dataset) for report in reports]
    if len(reports) == 2:
        result["phone"] = summarize(reports[1])
        result["comparison"] = compare(*reports)
    print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
