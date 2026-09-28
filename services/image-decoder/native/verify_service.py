"""External native qualification. Owns its disposable container; never publishes an image."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

from PIL import Image, ImageChops, ImageCms, __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[3]
MAX_HEADER = 8192
MAX_BODY = 20 * 1024 * 1024
CLIENT = """
import http.client,json,sys
connection=http.client.HTTPConnection('127.0.0.1',8080,timeout=135)
headers=json.loads(sys.argv[2])
connection.request(sys.argv[1],sys.argv[3],body=sys.stdin.buffer if sys.argv[1]=='POST' else None,headers=headers)
response=connection.getresponse()
sys.stdout.buffer.write((json.dumps({'status':response.status,'headers':dict(response.getheaders())})+'\\n').encode())
while chunk:=response.read(65536): sys.stdout.buffer.write(chunk)
connection.close()
"""


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def docker(*args, timeout=30):
    return subprocess.run(['docker', *args], check=True, capture_output=True, timeout=timeout)


def request(container, path, headers=None, source=None):
    with tempfile.TemporaryFile() as output, (source.open('rb') if source else open(__file__, 'rb')) as input_file:
        process = subprocess.Popen(['docker', 'exec', '-i', container, 'python', '-c', CLIENT,
                                    'POST' if source else 'GET', json.dumps(headers or {}), path],
                                   stdin=input_file if source else subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 140
        try:
            while process.poll() is None:
                if time.monotonic() > deadline or output.tell() > MAX_HEADER + MAX_BODY:
                    raise RuntimeError('Native response exceeded time/byte budget.')
                time.sleep(0.05)
            if process.returncode:
                raise RuntimeError('Private native request was unavailable.')
            output.seek(0)
            header = output.readline(MAX_HEADER + 1)
            if len(header) > MAX_HEADER:
                raise RuntimeError('Oversized private response header.')
            response = json.loads(header)
            body = output.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise RuntimeError('Oversized private response body.')
            return response, body
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def safe_file(root, path):
    target = (root / path).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        raise RuntimeError('Missing or unsafe fixture/reference path.')
    return target


def pixel_error(output, reference):
    output, reference = output.convert('RGBA'), reference.convert('RGBA')
    difference = ImageChops.difference(output, reference)
    # Animation disposal and WebP muxing may discard RGB where both alphas are
    # zero. Compare alpha everywhere and full RGB wherever either alpha is >0.
    visible = ImageChops.lighter(output.getchannel('A'), reference.getchannel('A')).point(lambda value: 255 if value else 0)
    rgb = ImageChops.multiply(difference.convert('RGB'), visible.convert('RGB'))
    return max(difference.getchannel('A').getextrema()[1], *(high for _low, high in rgb.getextrema()))


def compare_output(body, fixture, reference):
    with Image.open(io.BytesIO(body)) as output, Image.open(reference) as expected:
        output.load()
        if not output.info.get('icc_profile'):
            raise RuntimeError('Preview is missing its display color profile.')
        profile = ImageCms.ImageCmsProfile(io.BytesIO(output.info['icc_profile']))
        if 'srgb' not in ImageCms.getProfileDescription(profile).lower():
            raise RuntimeError('Preview display profile is not sRGB.')
        if output.getexif() or output.info.get('exif') or output.info.get('xmp'):
            raise RuntimeError('Preview retained source metadata.')
        frames = getattr(output, 'n_frames', 1)
        if frames != fixture['encoded']['frames'] or frames != getattr(expected, 'n_frames', 1):
            raise RuntimeError('Preview frame count differs from the reference.')
        tolerance = fixture['reference'].get('maxChannelError', 0)
        if not isinstance(tolerance, int) or not 0 <= tolerance <= 16:
            raise RuntimeError('Invalid pixel comparison tolerance.')
        for index in range(frames):
            output.seek(index)
            expected.seek(index)
            output.load()
            expected.load()
            if output.size != expected.size or max(output.size) > 1600:
                raise RuntimeError('Preview dimensions differ from the reference.')
            if pixel_error(output, expected) > tolerance:
                raise RuntimeError('Decoded preview pixels differ from the reference.')
            if abs(output.info.get('duration', 0) - expected.info.get('duration', 0)) > 1:
                raise RuntimeError('Preview frame timing differs from the reference.')
        return {'sha256': hashlib.sha256(body).hexdigest(), 'independentlyDecoded': True,
                'pixelsCompared': True, 'comparison': 'full-alpha-and-rgb-at-nonzero-alpha', 'decoder': 'Pillow', 'decoderVersion': pillow_version,
                'width': output.width, 'height': output.height, 'frames': frames,
                'referenceSha256': sha(reference), 'metadataStripped': True, 'orientationVerified': True, 'colorVerified': True}


METRIC_KEYS = ('nativeMs', 'peakRssBytes', 'peakScratchBytes', 'sourceBytes')


def observed_metrics(headers):
    """Private per-job X-Decoder-Metrics as observed; informational, never pass/fail.
    Anything absent, ambiguous, oversized or not exactly four non-negative integers is null."""
    values = [value for key, value in headers.items() if key.lower() == 'x-decoder-metrics']
    if len(values) != 1 or not isinstance(values[0], str) or len(values[0].encode()) > 512:
        return None
    try:
        metrics = json.loads(values[0])
    except ValueError:
        return None
    if not isinstance(metrics, dict) or set(metrics) != set(METRIC_KEYS) \
            or any(type(metrics[key]) is not int or metrics[key] < 0 for key in METRIC_KEYS):
        return None
    return {key: metrics[key] for key in METRIC_KEYS}


def validate_inspection(inspection, fixture, build, byte_size):
    encoded = fixture['encoded']
    width, height = encoded['width'], encoded['height']
    if encoded['orientation'] in (5, 6, 7, 8):
        width, height = height, width
    expected = {'family': 'heic' if encoded['codec'] == 'heif' else encoded['codec'],
                'width': width, 'height': height, 'frameCount': encoded['frames'],
                'primaryIndex': encoded.get('primaryIndex', 0),
                'isSequence': encoded.get('isSequence', encoded['frames'] > 1),
                'sourceSha256': fixture['sha256'], 'byteSize': byte_size,
                'buildFingerprint': build['buildFingerprint'], 'decoderVersion': build['decoderVersion'],
                'previewProfile': 'mobile-preview-v1'}
    if not isinstance(inspection, dict) or set(inspection) != set(expected) \
            or any(type(inspection[key]) is not type(value) or inspection[key] != value for key, value in expected.items()):
        raise RuntimeError('Native family/primary/display/sequence/source/build proof mismatch.')


def group_ids(group):
    catalog = json.loads((ROOT / 'shared/mobile-image-cases.json').read_bytes())
    groups = {'baseline-raster': ('jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'),
              'heif-avif': ('heic', 'heif', 'avif'), 'jxl-jp2': ('jxl', 'jp2'), 'raw': ('dng',)}
    families = groups.get(group, tuple(catalog['families']))
    return list(dict.fromkeys(case for family in families for category in ('still', 'sequence')
                              for case in catalog['families'][family][category]))


def verify_boundary(container, source, family):
    # Execute actual HTTP failure/busy/cancel probes and the shipped process
    # wrapper in Linux. These small probes do not certify peak RSS or event load.
    probe = r'''
import errno, http.client, json, os, pathlib, resource, socket, subprocess, sys, tempfile, time
sys.path.insert(0, '/srv')
import server
root = pathlib.Path('/tmp/candidary-decoder')
headers = {'X-Decoder-Protocol':'1','Content-Type':'application/octet-stream',
           'X-Decoder-Lane':'upload','X-Image-Family':sys.argv[1],'X-Image-Sequence':'0',
           'X-Source-Length':sys.argv[2],'Content-Length':sys.argv[2]}
def clear():
    end = time.monotonic()+10
    while root.exists() and list(root.iterdir()):
        if time.monotonic()>end: raise RuntimeError('Scratch did not settle.')
        time.sleep(.02)
def call(body, values):
    c=http.client.HTTPConnection('127.0.0.1',8080,timeout=5)
    c.request('POST','/v1/preview',body=body,headers=values)
    r=c.getresponse(); status=r.status; value=json.loads(r.read()); c.close()
    return status,value
clear()
bad={**headers,'X-Image-Family':'jpeg','Content-Length':'4','X-Source-Length':'4'}
assert call(b'nope',bad)==(422,{'code':'malformed'})
clear()
oversize={**headers,'Content-Length':'536870913','X-Source-Length':'536870913'}
assert call(b'',oversize)==(413,{'code':'resource_limit'})
clear()
hold=http.client.HTTPConnection('127.0.0.1',8080,timeout=5)
hold.putrequest('POST','/v1/preview')
for k,v in headers.items(): hold.putheader(k,v)
hold.endheaders(); hold.send(b'x')
end=time.monotonic()+5
while not list(root.iterdir()):
    if time.monotonic()>end: raise RuntimeError('Upload did not start.')
    time.sleep(.01)
assert call(b'nope',bad)==(429,{'code':'busy'})
hold.close(); clear()
active=http.client.HTTPConnection('127.0.0.1',8080,timeout=10)
active.request('POST','/v1/preview',body=sys.stdin.buffer,headers=headers)
def native_pids():
    found=[]
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            args=(p/'cmdline').read_bytes().split(b'\0')
            if args[0] in (b'/opt/decoder/bin/decode_raw',b'/opt/decoder/bin/magick'):
                found.append(int(p.name))
        except OSError: pass
    return found
end=time.monotonic()+5
while not native_pids():
    if time.monotonic()>end: raise RuntimeError('Decode cancellation had no active child.')
    time.sleep(.01)
active.close(); clear()
assert not native_pids()
network=socket.socket(); network.settimeout(.5)
try:
    network.connect(('203.0.113.1',443))
    raise RuntimeError('Unexpected runtime egress.')
except OSError as error:
    assert error.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH,errno.EACCES)
finally: network.close()
try:
    pathlib.Path('/srv/verification-write').write_bytes(b'blocked')
    raise RuntimeError('Unexpected writable runtime root.')
except OSError as error: assert error.errno in (errno.EROFS,errno.EACCES)
with tempfile.TemporaryDirectory(dir='/tmp') as directory:
    job=pathlib.Path(directory); output=job/'limits.json'
    code='import json,resource; print(json.dumps([resource.getrlimit(k) for k in (resource.RLIMIT_AS,resource.RLIMIT_FSIZE,resource.RLIMIT_CPU)]))'
    server.run_native(['/usr/local/bin/python','-c',code],job,time.monotonic()+5,stdout_path=output)
    limits=json.loads(output.read_bytes())
    assert limits==[[3221225472]*2,[2147483648]*2,[120]*2]
    child="import pathlib,subprocess,os,time; p=subprocess.Popen(['/usr/local/bin/python','-c','import time; time.sleep(10)']); pathlib.Path('pids').write_text(str(os.getpid())+','+str(p.pid)); time.sleep(10)"
    try: server.run_native(['/usr/local/bin/python','-c',child],job,time.monotonic()+.3)
    except server.DecodeFailure as error: assert error.code=='resource_limit'
    else: raise RuntimeError('Native deadline failed.')
    for pid in (job/'pids').read_text().split(','):
        status=pathlib.Path('/proc')/pid/'stat'
        assert not status.exists() or status.read_text().split()[2]=='Z'
clear()
print(json.dumps({'malformedSanitized':True,'oversizeRefused':True,'busyIsolated':True,
                  'uploadCancelCleaned':True,'decodeCancelKilled':True,'runtimeEgressDenied':True,
                  'rootWriteDenied':True,'kernelLimits':limits,'deadlineKillsProcessGroup':True,
                  'scratchEmpty':True,'peakResourceLoadQualified':False}))
'''
    with source.open('rb') as input_file:
        result = subprocess.run(['docker', 'exec', '-i', container, 'python', '-c', probe,
                                 family, str(source.stat().st_size)], stdin=input_file,
                                capture_output=True, timeout=60)
    if result.returncode or result.stderr or len(result.stdout) > 4096:
        raise RuntimeError('Native failure/cancel/isolation probe failed.')
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--fixture-root', type=Path)
    parser.add_argument('--group', required=True, choices=('baseline-raster', 'heif-avif', 'jxl-jp2', 'raw', 'rendering'))
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_bytes())
    fixture_root = args.fixture_root or args.manifest.resolve().parent
    required = group_ids(args.group)
    records = {record['id']: record for record in manifest['cases']}
    report = {'kind': 'native-service', 'harnessVersion': 1, 'group': args.group, 'buildFingerprint': None,
              'image': None, 'complete': False, 'results': [], 'runtime': {'pillow': pillow_version, 'python': sys.version.split()[0]}}
    container = 'candidary-image-verification-' + uuid.uuid4().hex
    created = False
    engine_failure = None
    try:
        image = json.loads(docker('image', 'inspect', args.image).stdout)[0]
        report['image'] = {'source': 'docker-inspect', 'id': image['Id'], 'registryDigests': image.get('RepoDigests', [])}
        docker('run', '-d', '--name', container, '--network', 'none', '--read-only', '--memory', '4g', '--cpus', '2',
               '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--tmpfs', '/tmp:rw,size=2147483648,uid=10001,gid=10001', args.image)
        created = True
        configuration = json.loads(docker('inspect', container).stdout)[0]
        host = configuration['HostConfig']
        isolation = {'network': host['NetworkMode'], 'readOnlyRoot': host['ReadonlyRootfs'],
                     'user': configuration['Config']['User'], 'memoryBytes': host['Memory'],
                     'pidsLimit': host['PidsLimit'], 'capDrop': host['CapDrop'],
                     'securityOptions': host['SecurityOpt'], 'tmpfs': host['Tmpfs']}
        if isolation['network'] != 'none' or isolation['readOnlyRoot'] is not True \
                or isolation['user'] != '10001:10001' or isolation['memoryBytes'] != 4 * 1024**3 \
                or isolation['pidsLimit'] != 64 or 'ALL' not in isolation['capDrop'] \
                or not any(value.startswith('no-new-privileges') for value in isolation['securityOptions']):
            raise RuntimeError('Native container isolation differs from the reviewed harness.')
        report['runtime']['isolation'] = isolation
        deadline = time.monotonic() + 30
        while True:
            try:
                response, body = request(container, '/health')
                if response['status'] != 200:
                    raise RuntimeError('Native health failed.')
                health = json.loads(body)
                if set(health) != {'protocolVersion', 'buildFingerprint', 'decoderVersion'} or health['protocolVersion'] != 1:
                    raise RuntimeError('Unexpected native identity schema.')
                report['buildFingerprint'] = health['buildFingerprint']
                report['decoderVersion'] = health['decoderVersion']
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)
        for case_id in required:
            fixtures = records.get(case_id, {}).get('fixtures', [])
            if not fixtures:
                report['results'].append({'caseId': case_id, 'status': 'missing', 'reason': 'Missing real-file fixture.'})
            for fixture in fixtures:
                result = {'caseId': case_id, 'fixtureId': fixture['id'], 'sourceSha256': fixture['sha256'], 'status': 'fail', 'metrics': None}
                try:
                    if fixture['synthetic'] or not fixture['provenance'].get('license') or fixture['provenance'].get('consent') is not True:
                        raise RuntimeError('Fixture provenance is not qualified.')
                    source = safe_file(fixture_root, fixture['path'])
                    if sha(source) != fixture['sha256']:
                        raise RuntimeError('Fixture source hash mismatch.')
                    if not fixture.get('reference'):
                        raise RuntimeError('Missing independent reference rendering.')
                    reference = safe_file(fixture_root, fixture['reference']['path'])
                    if sha(reference) != fixture['reference']['sha256']:
                        raise RuntimeError('Reference hash mismatch.')
                    family = fixture['encoded']['codec']
                    start = time.monotonic()
                    response, body = request(container, '/v1/preview', {
                        'Content-Type': 'application/octet-stream', 'Content-Length': str(source.stat().st_size),
                        'X-Decoder-Protocol': '1', 'X-Image-Family': family,
                        'X-Image-Sequence': '1' if fixture['encoded']['frames'] > 1 else '0',
                        'X-Source-Length': str(source.stat().st_size), 'X-Decoder-Lane': 'upload'}, source)
                    result['decodeSeconds'] = time.monotonic() - start
                    # Observed private job resources (success or closed failure); never gating.
                    result['metrics'] = observed_metrics(response['headers'])
                    if response['status'] != 200:
                        error = json.loads(body)
                        result['failureCode'] = error.get('code') if error.get('code') in ('unsupported', 'malformed', 'resource_limit', 'busy', 'unavailable') else 'unavailable'
                        raise RuntimeError('Native service refused this required case.')
                    headers = {key.lower(): value for key, value in response['headers'].items()}
                    inspection = json.loads(headers['x-decoder-inspection'])
                    validate_inspection(inspection, fixture, report, source.stat().st_size)
                    if not body or len(body) != int(headers['content-length']):
                        raise RuntimeError('Empty or incomplete native preview.')
                    result['inspection'] = inspection
                    result['preview'] = compare_output(body, fixture, reference)
                    result['sourceUnchanged'] = sha(source) == fixture['sha256']
                    if not result['sourceUnchanged']:
                        raise RuntimeError('Original source changed.')
                    scratch = docker('exec', container, 'python', '-c', "import os,json; print(json.dumps(os.listdir('/tmp/candidary-decoder')))").stdout
                    if json.loads(scratch):
                        raise RuntimeError('Native scratch retained source/output bytes.')
                    result['status'] = 'pass'
                except Exception as error:
                    result['reason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
                report['results'].append(result)
        if args.group == 'rendering':
            candidate = next((fixture for record in manifest['cases'] for fixture in record.get('fixtures', [])
                              if fixture['encoded']['codec'] == 'dng' and any(
                                  result.get('fixtureId') == fixture['id'] and result['status'] == 'pass' for result in report['results'])), None)
            report['runtime']['boundary'] = verify_boundary(container, safe_file(fixture_root, candidate['path']), 'dng') if candidate else {'status': 'missing', 'reason': 'Needs a verified long-running source for active cancellation.'}
        logs = docker('logs', container)
        report['runtime']['privateLogsEmpty'] = not logs.stdout and not logs.stderr
        if not report['runtime']['privateLogsEmpty']:
            raise RuntimeError('Native service emitted unexpected logs.')
    except (subprocess.SubprocessError, FileNotFoundError) as error:
        engine_failure = 'Docker engine/image unavailable: ' + type(error).__name__
    except Exception as error:
        engine_failure = 'Native service setup failed: ' + type(error).__name__
    finally:
        if created:
            try:
                docker('rm', '-f', container)
            except subprocess.SubprocessError:
                report['cleanupFailure'] = True
        if engine_failure:
            report['runtimeFailure'] = engine_failure
            for case_id in required:
                if not any(result['caseId'] == case_id for result in report['results']):
                    report['results'].append({'caseId': case_id, 'status': 'missing', 'reason': engine_failure})
        report['complete'] = not engine_failure and not report.get('cleanupFailure') and bool(report['results']) \
            and all(result['status'] == 'pass' for result in report['results'])
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'report': str(args.report), 'complete': report['complete'], 'results': len(report['results']), 'runtimeFailure': engine_failure}))
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    sys.exit(main())
