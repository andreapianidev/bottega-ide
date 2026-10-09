#!/usr/bin/env python3
"""Short paired Mac/iPhone measurement through the production shared-worker queue.

No LLM calls, sustained load, fallback, credentials or private endpoints in reports.
The local JSONL CLI stays alive across samples. RUSAGE_CHILDREN is collected after
it exits; per-task local compute CPU comes from the production executor itself.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import ipaddress
import json
import math
import os
from pathlib import Path
import resource
import selectors
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid


class Failure(Exception):
    """Only safe, authored descriptions may be exposed to the console/report."""


def normalized(text):
    return ' '.join(unicodedata.normalize('NFC', text).split())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def cpu_ms():
    values = [resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)]
    return 1000 * sum(v.ru_utime + v.ru_stime for v in values)


def read_private(path):
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Failure('private_configuration_permissions')
    return json.loads(path.read_text())


def validate_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname
        address = ipaddress.ip_address(host) if host != 'localhost' else None
        permitted = host == 'localhost' or address.is_loopback or address in ipaddress.ip_network('100.64.0.0/10')
        port = parsed.port
        if parsed.scheme not in ('http', 'https') or not permitted or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/') or (port is not None and not 1 <= port <= 65535):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise Failure('private_endpoint_invalid') from None
    return value.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Remote:
    def __init__(self, directory=None, timeout=40):
        directory = directory or Path.home() / '.bottega'
        config = read_private(directory / 'workerconnection.json')
        credentials = read_private(directory / 'ponte.json')
        if config.get('version') != 1 or not isinstance(credentials.get('token'), str) or len(credentials['token']) < 32:
            raise Failure('private_configuration_invalid')
        self.base = validate_url(config.get('url'))
        self.token = credentials['token']
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None, remaining=8):
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
        try:
            with self.opener.open(request, timeout=max(.05, min(8, remaining))) as response:
                result = response.read(8 * 1024 * 1024 + 1)
                if len(result) > 8 * 1024 * 1024:
                    raise Failure('remote_response_too_large')
                return json.loads(result)
        except urllib.error.HTTPError as error:
            raise Failure('remote_http_' + str(error.code)) from None
        except (OSError, ValueError, urllib.error.URLError):
            raise Failure('remote_transport_unavailable') from None

    def ready(self):
        status = self.request('/v1/worker/status')
        workers = [worker for worker in status.get('workers', []) if worker.get('online') and worker.get('available', True)]
        supported = set()
        for worker in workers:
            for cap in worker.get('capabilities', []):
                if cap.get('operation') == 'ocr' and cap.get('implementation') == 'apple-vision' and cap.get('revision') == 3:
                    supported.add('ocr')
                if cap.get('operation') == 'embeddings' and cap.get('implementation') == 'apple-nl-it' and cap.get('revision') == 1 and cap.get('dimension') == 640:
                    supported.add('embeddings')
        if supported != {'embeddings', 'ocr'}:
            raise Failure('iphone_unavailable_or_capabilities_mismatch')
        if status.get('active'):
            raise Failure('shared_queue_busy_run_after_existing_jobs')
        # No identifiers, hosts or raw status are persisted.
        return {'online_workers': len(workers), 'capabilities': sorted(supported)}

    def execute(self, operation, payload, origin):
        job_id = str(uuid.uuid4())
        body = {'id': job_id, 'origin': origin, 'operation': operation, 'input': payload}
        started = time.perf_counter()
        deadline = started + self.timeout
        try:
            # A lost submit ACK retries the exact same id/payload once.
            try:
                reply = self.request('/v1/worker/jobs', body, deadline - time.perf_counter())
            except Failure as error:
                if str(error) != 'remote_transport_unavailable':
                    raise
                reply = self.request('/v1/worker/jobs', body, deadline - time.perf_counter())
            while True:
                job = reply.get('job')
                if not isinstance(job, dict):
                    raise Failure('remote_job_contract_invalid')
                if job.get('state') == 'completed':
                    if job.get('id') != job_id or job.get('operation') != operation:
                        raise Failure('remote_job_identity_mismatch')
                    return measured(job, started, 'iphone')
                if job.get('state') in ('failed', 'cancelled'):
                    raise Failure('iphone_job_' + job['state'])
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    raise Failure('iphone_job_timeout')
                time.sleep(min(.05, remaining))
                reply = self.request('/v1/worker/jobs/' + job_id, remaining=deadline - time.perf_counter())
        except BaseException:
            # Only this harness's job is cancelled; never affect another app's work.
            try:
                self.request('/v1/worker/jobs/' + job_id + '/cancel', {}, remaining=2)
            except Failure:
                pass
            raise


def measured(reply, started, device):
    metrics, result = reply.get('metrics'), reply.get('result')
    if not isinstance(metrics, dict) or not isinstance(result, dict):
        raise Failure(device + '_result_contract_invalid')
    for key in ('cpuMs', 'elapsedMs'):
        if not isinstance(metrics.get(key), (float, int)) or not math.isfinite(metrics[key]) or metrics[key] < 0:
            raise Failure(device + '_metrics_invalid')
    optional = {}
    peak = metrics.get('peakResidentBytes')
    if isinstance(peak, (int, float)) and math.isfinite(peak) and peak >= 0:
        optional['peak_resident_bytes'] = peak
    for field in ('thermalStart', 'thermalEnd'):
        if metrics.get(field) in ('nominal', 'fair', 'serious', 'critical', 'unknown'):
            optional[field] = metrics[field]
    return {**optional, 'result': result, 'compute_ms': metrics['elapsedMs'], 'compute_cpu_ms': metrics['cpuMs'],
            'e2e_ms': (time.perf_counter() - started) * 1000,
            'input_bytes': metrics.get('inputBytes', reply.get('inputBytes')),
            'output_bytes': metrics.get('outputBytes', reply.get('outputBytes')),
            'queue_e2e_ms': (reply['completedAt'] - reply['createdAt']) if 'completedAt' in reply and 'createdAt' in reply else None}


class Local:
    def __init__(self, executable, timeout=40):
        self.timeout = timeout
        self.process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = bytearray()

    def execute(self, operation, payload, origin):
        started = time.perf_counter()
        job = {'id': str(uuid.uuid4()), 'origin': origin, 'operation': operation, 'input': payload,
               'implementation': 'apple-nl-it' if operation == 'embeddings' else 'apple-vision',
               'revision': 1 if operation == 'embeddings' else 3, 'leaseToken': 'synthetic-local-lease',
               'attempt': 1, 'leaseExpiresAt': time.time() * 1000 + 120000}
        if operation == 'embeddings':
            job['dimension'] = 640
        try:
            self.process.stdin.write(json.dumps({'job': job}, separators=(',', ':')).encode() + b'\n')
            self.process.stdin.flush()
            deadline = started + self.timeout
            while b'\n' not in self.buffer:
                remaining = deadline - time.perf_counter()
                if remaining <= 0 or not self.selector.select(remaining):
                    raise Failure('mac_local_job_timeout')
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise Failure('mac_local_cli_stopped')
                self.buffer.extend(chunk)
                if len(self.buffer) > 8 * 1024 * 1024:
                    raise Failure('mac_local_response_too_large')
            line, _, remainder = self.buffer.partition(b'\n')
            self.buffer = bytearray(remainder)
            reply = json.loads(line)
            if 'error' in reply:
                raise Failure('mac_local_compute_failed')
            return measured(reply, started, 'mac')
        except (OSError, ValueError):
            raise Failure('mac_local_cli_contract_invalid') from None

    def close(self):
        self.selector.close()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()


def flow(executor, profile, texts, image):
    started, cpu_started = time.perf_counter(), cpu_ms()
    stages, payload_hashes = [], []
    def step(operation, payload):
        payload_hashes.append(digest({'operation': operation, 'input': payload}))
        reply = executor.execute(operation, payload, 'bottega' if profile == 'bottega' else 'avo')
        observations = getattr(executor, '_observations', {})
        observations[operation] = observations.get(operation, 0) + 1
        executor._observations = observations
        stages.append(dict(reply, operation=operation, canonical_payload_json_bytes=len(json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()), operation_observation_index=observations[operation],
                           warm_state='first_observed' if observations[operation] == 1 else 'warm_followup'))
        return reply['result']
    if profile == 'bottega':
        step('embeddings', {'texts': texts[:6]})
    else:
        result = step('ocr', {'imageBase64': image['png'], 'mimeType': 'image/png'})
        if profile == 'melissa':
            extracted = normalized(result.get('text', ''))
            if not extracted or len(extracted.encode('utf-16-le')) // 2 > 2000:
                raise Failure('ocr_output_not_valid_for_embedding_batch')
            step('embeddings', {'texts': [extracted]})
    return {'stages': stages, 'payload_hashes': payload_hashes,
            'e2e_ms': (time.perf_counter() - started) * 1000,
            'compute_ms': sum(stage['compute_ms'] for stage in stages),
            'compute_cpu_ms': sum(stage['compute_cpu_ms'] for stage in stages),
            'orchestration_resource_cpu_ms': cpu_ms() - cpu_started}


def quality(local, remote, expected=None):
    output = {'identical_payloads': local['payload_hashes'] == remote['payload_hashes'],
              'ocr_exact': None, 'ocr_raw_exact_pair': None, 'vector_max_abs_error': None, 'passed': True}
    if not output['identical_payloads']:
        output['passed'] = False
    for left, right in zip(local['stages'], remote['stages']):
        a, b = left['result'], right['result']
        operation = left['operation']
        implementation, revision = ('apple-nl-it', 1) if operation == 'embeddings' else ('apple-vision', 3)
        if any(result.get('implementation') != implementation or result.get('revision') != revision for result in (a, b)):
            output['passed'] = False
        if operation == 'ocr':
            output['ocr_raw_exact_pair'] = a.get('text') == b.get('text')
            output['ocr_exact'] = normalized(a.get('text', '')) == normalized(b.get('text', '')) == normalized(expected or '')
            output['passed'] &= output['ocr_exact']
        else:
            va, vb = a.get('vectors', []), b.get('vectors', [])
            valid = a.get('dimension') == b.get('dimension') == 640 and len(va) == len(vb) > 0
            valid = valid and all(len(x) == len(y) == 640 for x, y in zip(va, vb))
            if valid:
                values = [abs(x - y) for xs, ys in zip(va, vb) for x, y in zip(xs, ys)]
                valid = all(math.isfinite(value) for value in values) and any(value != 0 for vector in va for value in vector) and any(value != 0 for vector in vb for value in vector)
                output['vector_max_abs_error'] = max(values) if valid else None
                valid = valid and output['vector_max_abs_error'] <= 1e-5
            output['passed'] &= valid
    return output


def ratio(left, right):
    return left / right if right > 0 else None


def summarize(samples):
    summaries = {}
    for profile in ('bottega', 'avo', 'melissa'):
        good = [sample for sample in samples if sample['profile'] == profile and sample['quality']['passed']]
        summary = {'n': len(good), 'rejected_quality': sum(sample['profile'] == profile and not sample['quality']['passed'] for sample in samples)}
        for metric in ('compute_ms', 'compute_cpu_ms', 'e2e_ms'):
            if not good:
                continue
            local, remote = [sample['mac'][metric] for sample in good], [sample['iphone'][metric] for sample in good]
            summary[metric] = {'mac_median': statistics.median(local), 'iphone_median': statistics.median(remote),
                'ratio_of_medians_mac_over_iphone': ratio(statistics.median(local), statistics.median(remote)),
                'median_paired_ratio_mac_over_iphone': statistics.median([x / y for x, y in zip(local, remote) if y > 0]) if any(y > 0 for y in remote) else None}
        if good and all('orchestration_resource_cpu_ms' in sample['iphone'] for sample in good):
            local_cpu = statistics.median(sample['mac']['compute_cpu_ms'] for sample in good)
            remote_orchestration = statistics.median(sample['iphone']['orchestration_resource_cpu_ms'] for sample in good)
            summary['mac_cpu_scope_comparison'] = {'local_compute_cpu_median_ms': local_cpu,
                'remote_python_orchestration_cpu_median_ms': remote_orchestration,
                'reduction_percent': (1 - remote_orchestration / local_cpu) * 100 if local_cpu > 0 else None,
                'excludes': 'VS Code/bridge server, UI, other Mac processes; not whole-Mac CPU reduction'}
        summaries[profile] = summary
    return summaries


def strip_results(run):
    result = {key: value for key, value in run.items() if key != 'stages'}
    result['stages'] = [{key: value for key, value in stage.items() if key != 'result'} for stage in run['stages']]
    result['models'] = [{'implementation': stage['result'].get('implementation'), 'revision': stage['result'].get('revision'),
                         'dimension': stage['result'].get('dimension')} for stage in run['stages']]
    return result


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='') as file:
        file.write(content)
    path.chmod(0o600)


def reports(directory, report):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    private_write(directory / 'shared-worker.json', json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    buffer = io.StringIO()
    columns = ['profile', 'repetition', 'phase', 'quality_passed', 'identical_payloads', 'ocr_exact', 'vector_max_abs_error',
               'mac_compute_ms', 'iphone_compute_ms', 'mac_e2e_ms', 'iphone_e2e_ms', 'mac_compute_cpu_ms', 'iphone_compute_cpu_ms', 'remote_mac_orchestration_resource_cpu_ms']
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    for sample in report['samples']:
        row = {key: sample[key] for key in ('profile', 'repetition', 'phase')}
        row.update({key: sample['quality'][key] for key in ('identical_payloads', 'ocr_exact', 'vector_max_abs_error')})
        row['quality_passed'] = sample['quality']['passed']
        for device in ('mac', 'iphone'):
            for metric in ('compute_ms', 'e2e_ms', 'compute_cpu_ms'):
                row[device + '_' + metric] = sample[device][metric]
        row['remote_mac_orchestration_resource_cpu_ms'] = sample['iphone']['orchestration_resource_cpu_ms']
        writer.writerow(row)
    private_write(directory / 'shared-worker.csv', buffer.getvalue())
    lines = ['Calcolo condiviso: confronto breve Mac / iPhone', 'Rapporti Mac/iPhone: oltre 1 significa iPhone più rapido.',
             'Calcolo e durata totale sono misure diverse; nessuna misura riguarda accelerazione di un LLM.',
             'Primo campione per profilo e ripetizioni; ogni fase registra anche primo campione/successivi per operazione e dispositivo. Lo stato davvero freddo dell’app iPhone non è noto.',
             'CPU Mac durante le richieste remote: sola orchestrazione Python, non CPU dell’estensione Bottega.',
             'CPU totale Mac via resource: harness + figlio CLI locale, raccolta dopo la chiusura del figlio.',
             'Memoria: peakResidentBytes, se disponibile, è del processo worker; nessuna somma RAM fra dispositivi. Stato termico osservato per fase.',
             'Bytes canonici del payload riportati separatamente: i contatori interni del coordinatore e del compute possono includere involucri JSON differenti.',
             'Qualità OCR: uguaglianza dopo NFC e spazi normalizzati; anche confronto grezzo della coppia. Vettori: errore massimo ≤ 1e-5.', '']
    for profile, summary in report['summary'].items():
        lines.append(profile + ': n=' + str(summary['n']) + ', campioni qualità respinti=' + str(summary['rejected_quality']))
        cpu = summary.get('mac_cpu_scope_comparison')
        if cpu and cpu['reduction_percent'] is not None:
            lines.append(f"  CPU Mac perimetro dichiarato: calcolo locale {cpu['local_compute_cpu_median_ms']:.3f} ms vs orchestrazione remota Python {cpu['remote_python_orchestration_cpu_median_ms']:.3f} ms; riduzione {cpu['reduction_percent']:.1f}% (esclusi VS Code, ponte e altri processi).")
        for metric, label in (('compute_ms', 'Calcolo'), ('e2e_ms', 'Durata totale')):
            if metric in summary:
                value = summary[metric]
                pair = value['median_paired_ratio_mac_over_iphone']
                lines.append(f"  {label}: Mac {value['mac_median']:.3f} ms, iPhone {value['iphone_median']:.3f} ms; rapporto mediane {value['ratio_of_medians_mac_over_iphone']:.3f}; mediana rapporti accoppiati {pair:.3f}" if pair is not None and value['ratio_of_medians_mac_over_iphone'] is not None else f'  {label}: rapporto non calcolabile')
    if report.get('stopped_reason'):
        lines.append('Interrotto: ' + report['stopped_reason'])
    private_write(directory / 'shared-worker.txt', '\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, help='Existing synthetic benchmark-worker-dataset.json; required for real measurements.')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--local', type=Path, help='Production worker JSONL executable; otherwise compile it in a private temporary directory.')
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--timeout', type=float, default=40)
    parser.add_argument('--self-test', action='store_true', help='Offline synthetic contract checks only.')
    args = parser.parse_args()
    if args.self_test:
        return 0 if unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OfflineTests)).wasSuccessful() else 1
    if args.output_dir is None or args.dataset is None or not 1 <= args.repetitions <= 6 or not 1 <= args.timeout <= 60:
        parser.error('--dataset and --output-dir required; repetitions 1...6, per-job timeout 1...60 seconds')
    report = {'version': 1, 'repetitions': args.repetitions, 'samples': [], 'summary': {}, 'stopped_reason': None,
              'scope': 'Production Apple OCR/embedding only; no LLM acceleration claim.',
              'cold_state': {'mac': 'first observed task in fresh persistent CLI', 'iphone': 'unknown; existing foreground app, first observed then warm followups'},
              'cpu_scope': 'Per-job compute CPU from production executor; remote Mac CPU from resource self+children delta (Python orchestration only). Aggregate Mac resource CPU includes reaped local CLI.'}
    local = None
    cpu_started = None
    with tempfile.TemporaryDirectory(prefix='shared-worker-local-') as scratch:
        try:
            if args.dataset.stat().st_size > 6_000_000:
                raise Failure('dataset_too_large')
            dataset = json.loads(args.dataset.read_text())
            texts, images = dataset['texts'], dataset['images']
            if len(texts) < 6 or len(images) < 2 or any(not isinstance(text, str) or not text or len(text.encode('utf-16-le')) // 2 > 2000 for text in texts[:6]):
                raise Failure('dataset_invalid')
            for image in images[:2]:
                binary = base64.b64decode(image['png'], validate=True)
                if not binary.startswith(b'\x89PNG\r\n\x1a\n') or len(binary) > 4 * 1024 * 1024 or not image.get('expected'):
                    raise Failure('dataset_image_invalid')
            report['dataset'] = {'version': dataset.get('version'), 'sha256': hashlib.sha256(args.dataset.read_bytes()).hexdigest(), 'image_ids': [image.get('id') for image in images[:2]]}
            remote = Remote(timeout=args.timeout)
            report['worker'] = remote.ready()  # Abort before compiling/local load if phone is absent.
            executable = args.local
            if executable is None:
                root = Path(__file__).resolve().parent.parent
                executable = Path(scratch) / 'worker-local'
                command = ['xcrun', 'swiftc', '-O', str(root / 'ios/Bottega/Worker/MacWorkerCompute.swift'), str(root / 'scripts/worker-local-main.swift'), '-o', str(executable)]
                if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                    raise Failure('local_cli_compile_failed')
            cpu_started = cpu_ms()  # Compilation CPU deliberately excluded.
            local = Local(executable, args.timeout)
            for profile, image in (('bottega', images[0]), ('avo', images[0]), ('melissa', images[1])):
                for repetition in range(args.repetitions):
                    remote.ready()
                    runs = {}
                    for name, executor in ([('mac', local), ('iphone', remote)] if repetition % 2 == 0 else [('iphone', remote), ('mac', local)]):
                        runs[name] = flow(executor, profile, texts, image)
                    check = quality(runs['mac'], runs['iphone'], image['expected'] if profile != 'bottega' else None)
                    report['samples'].append({'profile': profile, 'repetition': repetition + 1,
                        'phase': 'first_profile_pair' if repetition == 0 else 'profile_repeat', 'order': 'mac_first' if repetition % 2 == 0 else 'iphone_first',
                        'quality': check, 'mac': strip_results(runs['mac']), 'iphone': strip_results(runs['iphone'])})
                    print(profile + ' ' + str(repetition + 1) + '/' + str(args.repetitions) + ': ' + ('quality_pass' if check['passed'] else 'quality_failed'))
                    if not check['passed']:
                        raise Failure('paired_output_quality_failed')
        except Failure as error:
            report['stopped_reason'] = str(error)
        except (OSError, ValueError, KeyError, TypeError):
            report['stopped_reason'] = 'configuration_or_dataset_invalid'
        except KeyboardInterrupt:
            report['stopped_reason'] = 'interrupted_by_user'
        finally:
            if local is not None:
                local.close()
            if cpu_started is not None:
                report['aggregate_mac_resource_cpu_ms'] = cpu_ms() - cpu_started
    report['summary'] = summarize(report['samples'])
    reports(args.output_dir, report)
    print('Reports written: shared-worker.json, shared-worker.csv, shared-worker.txt')
    return 2 if report['stopped_reason'] else 0


class OfflineTests(unittest.TestCase):
    def test_private_endpoint_rejects_external_redirect_targets_and_malformed_urls(self):
        self.assertEqual(validate_url('http://127.0.0.1:7790/'), 'http://127.0.0.1:7790')
        self.assertEqual(validate_url('http://100.64.0.1:7790'), 'http://100.64.0.1:7790')
        for url in ('https://example.com', 'http://100.63.0.1', 'http://127.0.0.1/path', 'http://user@127.0.0.1', 'http://127.0.0.1?token=x', None):
            with self.assertRaises(Failure):
                validate_url(url)

    def test_same_normalized_ocr_produces_identical_melissa_embedding_payloads(self):
        class Fake:
            def __init__(self, text): self.text, self.inputs = text, []
            def execute(self, op, payload, origin):
                self.inputs.append(payload)
                result = {'text': self.text, 'implementation': 'apple-vision', 'revision': 3} if op == 'ocr' else {'vectors': [[1.0] + [0.0] * 639], 'implementation': 'apple-nl-it', 'revision': 1, 'dimension': 640}
                return {'result': result, 'compute_ms': 1, 'compute_cpu_ms': 1, 'e2e_ms': 2, 'input_bytes': 1, 'output_bytes': 1}
        a, b = Fake('Testo\n sintetico'), Fake('Testo sintetico')
        first, second = flow(a, 'melissa', [], {'png': 'synthetic'}), flow(b, 'melissa', [], {'png': 'synthetic'})
        self.assertEqual(a.inputs, b.inputs)
        self.assertTrue(quality(first, second, 'Testo sintetico')['passed'])
        b = Fake('Testo diverso')
        self.assertFalse(quality(first, flow(b, 'melissa', [], {'png': 'synthetic'}), 'Testo sintetico')['passed'])

    def test_paired_summary_does_not_confuse_compute_gain_with_end_to_end_loss(self):
        samples = [{'profile': 'bottega', 'quality': {'passed': True}, 'mac': {'compute_ms': 10, 'compute_cpu_ms': 9, 'e2e_ms': 12}, 'iphone': {'compute_ms': 5, 'compute_cpu_ms': 4, 'e2e_ms': 30}}]
        summary = summarize(samples)['bottega']
        self.assertEqual(summary['compute_ms']['ratio_of_medians_mac_over_iphone'], 2)
        self.assertEqual(summary['e2e_ms']['median_paired_ratio_mac_over_iphone'], .4)

    def test_report_excludes_raw_inputs_and_results_and_uses_private_permissions(self):
        run = {'stages': [{'operation': 'ocr', 'result': {'text': 'synthetic-private-content', 'implementation': 'apple-vision', 'revision': 3}, 'compute_ms': 2}], 'e2e_ms': 3}
        self.assertNotIn('synthetic-private-content', json.dumps(strip_results(run)))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'reports'
            reports(root, {'samples': [], 'summary': {}, 'stopped_reason': None})
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in root.iterdir()))

    def test_timeout_cancels_only_own_remote_job_without_local_fallback(self):
        remote = Remote.__new__(Remote)
        remote.timeout = 0
        calls = []
        def request(path, body=None, remaining=8):
            calls.append((path, body))
            return {'job': {'id': body.get('id'), 'state': 'queued'}}
        remote.request = request
        with self.assertRaisesRegex(Failure, 'iphone_job_timeout'):
            remote.execute('embeddings', {'texts': ['synthetic']}, 'bottega')
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], '/v1/worker/jobs/' + calls[0][1]['id'] + '/cancel')

    def test_lost_submit_ack_retries_same_identity(self):
        remote = Remote.__new__(Remote)
        remote.timeout = 1
        calls = []
        def request(path, body=None, remaining=8):
            calls.append(body)
            if len(calls) == 1:
                raise Failure('remote_transport_unavailable')
            return {'job': {'id': body['id'], 'operation': body['operation'], 'state': 'completed',
                'result': {}, 'metrics': {'cpuMs': 1, 'elapsedMs': 2}}}
        remote.request = request
        remote.execute('embeddings', {'texts': ['synthetic']}, 'bottega')
        self.assertEqual(calls[0], calls[1])

    def test_vector_mismatch_is_rejected_and_not_summarized_as_speedup(self):
        left = {'payload_hashes': ['same'], 'stages': [{'operation': 'embeddings', 'result': {'vectors': [[1.] * 640], 'implementation': 'apple-nl-it', 'revision': 1, 'dimension': 640}}]}
        right = {'payload_hashes': ['same'], 'stages': [{'operation': 'embeddings', 'result': {'vectors': [[1.1] * 640], 'implementation': 'apple-nl-it', 'revision': 1, 'dimension': 640}}]}
        self.assertFalse(quality(left, right)['passed'])
        summary = summarize([{'profile': 'bottega', 'quality': quality(left, right)}])['bottega']
        self.assertEqual(summary['n'], 0)
        self.assertNotIn('compute_ms', summary)


if __name__ == '__main__':
    sys.exit(main())
