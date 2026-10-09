import Foundation

@main
enum BenchmarkWorkerMain {
    static func main() {
        do {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("--help") {
                print("benchmark-worker.sh [--operation all|embeddings|ocr] [--repetitions 5] [--sustained-seconds 0...1200] [--dataset-in file] [--dataset-out file] [--out file]")
                return
            }
            func value(_ flag: String) throws -> String? {
                guard let i = args.firstIndex(of: flag) else { return nil }
                guard i + 1 < args.count, !args[i + 1].hasPrefix("--") else {
                    throw WorkerBenchmark.Failure("Manca il valore di \(flag).")
                }
                return args[i + 1]
            }
            let allowed = Set(["--operation", "--repetitions", "--sustained-seconds", "--dataset-in", "--dataset-out", "--out"])
            for flag in args.dropFirst() where flag.hasPrefix("--") && !allowed.contains(flag) {
                throw WorkerBenchmark.Failure("Opzione sconosciuta: \(flag).")
            }
            var config = WorkerBenchmark.Configuration()
            if let operation = try value("--operation") { config.operation = operation }
            if let raw = try value("--repetitions") {
                guard let repetitions = Int(raw) else { throw WorkerBenchmark.Failure("Ripetizioni non valide.") }
                config.repetitions = repetitions
            }
            if let raw = try value("--sustained-seconds") {
                guard let seconds = Double(raw) else { throw WorkerBenchmark.Failure("Durata non valida.") }
                config.sustainedSeconds = seconds
            }
            try config.validate()
            let dataset: WorkerBenchmark.Dataset
            if let path = try value("--dataset-in") {
                let url = URL(fileURLWithPath: path)
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                guard ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 6_000_000 else {
                    throw WorkerBenchmark.Failure("Dataset oltre il limite di 6 MB.")
                }
                dataset = try JSONDecoder().decode(WorkerBenchmark.Dataset.self, from: Data(contentsOf: url))
            } else { dataset = try WorkerBenchmark.syntheticDataset() }
            try dataset.validate()
            if let path = try value("--dataset-out") {
                try WorkerBenchmark.encode(dataset).write(to: URL(fileURLWithPath: path), options: .atomic)
            }
            let source = try value("--dataset-in") == nil ? "generated-on-mac" : "provided-identical-bytes"
            let report = try WorkerBenchmark.run(config, dataset: dataset, datasetSource: source) { message in
                FileHandle.standardError.write(Data((message + "\n").utf8))
            }
            let data = try WorkerBenchmark.encode(report)
            if let path = try value("--out") {
                try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            } else { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
            if report.stoppedReason != nil || report.samples.contains(where: { !$0.qualityPassed }) { exit(2) }
        } catch {
            FileHandle.standardError.write(Data(("benchmark-worker: \(error.localizedDescription)\n").utf8))
            exit(1)
        }
    }
}
