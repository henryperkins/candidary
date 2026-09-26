"""Build-time only. Each archive is pinned and checked before extraction/execution."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = Path(__file__).resolve().parent
PREFIX = Path('/opt/decoder')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def identity():
    files = [path for path in NATIVE.iterdir() if path.is_file()
             and (path.name == 'Dockerfile' or path.suffix in ('.py', '.cpp', '.h', '.txt', '.xml', '.json'))
             and path.name != 'build-identity.json']
    files += [ROOT / 'shared' / name for name in ('image-decoder-contract.ts', 'image-formats.ts', 'mobile-image-cases.json')]
    hashes = {}
    for path in sorted(files):
        content = canonical(json.loads(path.read_bytes())) if path.suffix == '.json' else path.read_bytes()
        hashes[path.relative_to(ROOT).as_posix()] = hashlib.sha256(content).hexdigest()
    return {'protocolVersion': 1, 'decoderVersion': 'candidary-native-1',
            'buildFingerprint': hashlib.sha256(canonical(hashes)).hexdigest(), 'inputs': hashes}


def run(argv, cwd):
    subprocess.run(argv, cwd=cwd, check=True, env=os.environ.copy())


def main():
    lock = json.loads((NATIVE / 'dependencies.lock.json').read_bytes())
    if lock['version'] != 1 or lock['baseImage']['platform'] != 'linux/amd64':
        raise RuntimeError('Unsupported build lock.')
    if sys.argv[1:] not in ([], ['--identity-only'], ['--dependencies-only'], ['--raw-helper-only']):
        raise RuntimeError('Unknown build operation.')
    if sys.argv[1:] == ['--raw-helper-only']:
        sources = Path('/build/native-sources')
        sdk = next((sources / 'dng-sdk').iterdir()) / 'dng_sdk' / 'source'
        raw = next((sources / 'libraw').iterdir())
        os.environ.update({'PATH': f'{PREFIX}/bin:' + os.environ['PATH'],
                           'PKG_CONFIG_PATH': f'{PREFIX}/lib/pkgconfig', 'LD_LIBRARY_PATH': f'{PREFIX}/lib'})
        build = Path('/build/raw-helper')
        run(['cmake', '-S', str(NATIVE), '-B', str(build), '-DCMAKE_BUILD_TYPE=Release',
             f'-DCMAKE_INSTALL_PREFIX={PREFIX}', f'-DCMAKE_PREFIX_PATH={PREFIX}',
             f'-DDNG_SOURCE={sdk}', f'-DLIBRAW_SOURCE={raw}'], NATIVE)
        run(['cmake', '--build', str(build), '--parallel', '2'], NATIVE)
        run(['cmake', '--install', str(build)], NATIVE)
        return
    # The identity stage runs before the dependency stage and includes all native inputs.
    if sys.argv[1:] != ['--dependencies-only']:
        (NATIVE / 'build-identity.json').write_text(json.dumps(identity(), sort_keys=True) + '\n')
    if sys.argv[1:] == ['--identity-only']:
        return
    PREFIX.mkdir(parents=True, exist_ok=True)
    work = Path('/build/native-sources')
    work.mkdir()
    os.environ.update({
        'PATH': f'{PREFIX}/bin:' + os.environ['PATH'],
        'PKG_CONFIG_PATH': f'{PREFIX}/lib/pkgconfig', 'CMAKE_PREFIX_PATH': str(PREFIX),
        'LD_LIBRARY_PATH': f'{PREFIX}/lib', 'CPPFLAGS': f'-I{PREFIX}/include',
        'LDFLAGS': f'-L{PREFIX}/lib -Wl,-rpath,{PREFIX}/lib',
    })
    for entry in lock['dependencies']:
        archive_path = work / (entry['name'] + '.archive')
        digest = hashlib.sha256()
        with urllib.request.urlopen(entry['url'], timeout=120) as response, archive_path.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
                if output.tell() > 256 * 1024 * 1024:
                    raise RuntimeError('Oversized dependency archive.')
        if digest.hexdigest() != entry['sha256']:
            raise RuntimeError('Dependency checksum mismatch: ' + entry['name'])
        destination = work / entry['name']
        destination.mkdir()
        if zipfile.is_zipfile(archive_path):
            with zipfile.ZipFile(archive_path) as archive:
                for member in archive.infolist():
                    if not (destination / member.filename).resolve().is_relative_to(destination.resolve()) \
                            or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise RuntimeError('Unsafe dependency ZIP member.')
                archive.extractall(destination)
        else:
            with tarfile.open(archive_path) as archive:
                archive.extractall(destination, filter='data')
        roots = list(destination.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise RuntimeError('Unexpected dependency archive layout.')
        source = roots[0]
        licenses = PREFIX / 'licenses' / entry['name']
        licenses.mkdir(parents=True)
        for path in source.iterdir():
            if path.is_file() and (path.name.lower().startswith(('license', 'copying', 'copyright', 'patents')) or path.name == 'README.ijg'):
                shutil.copy2(path, licenses / path.name)
        if entry['buildSystem'] == 'source':
            if entry['name'] not in ('dng-sdk', 'libraw'):
                raise RuntimeError('Unknown source-only dependency.')
            if entry['name'] == 'dng-sdk':
                (licenses / 'NOTICE').write_text('This product includes DNG technology under license by Adobe.\n')
        elif entry['buildSystem'] == 'tool':
            shutil.copytree(source / 'bin', PREFIX / 'bin', dirs_exist_ok=True)
            shutil.copytree(source / 'share', PREFIX / 'share', dirs_exist_ok=True)
            shutil.copytree(source / 'doc', licenses / 'doc', dirs_exist_ok=True)
        elif entry['buildSystem'] == 'python-tool' and entry['name'] == 'meson':
            shutil.copytree(source / 'mesonbuild', PREFIX / 'bin' / 'mesonbuild')
            shutil.copy2(source / 'meson.py', PREFIX / 'bin' / 'meson')
            (PREFIX / 'bin' / 'meson').chmod(0o755)
        elif entry['buildSystem'] == 'meson':
            build = source / '_build'
            run(['meson', 'setup', str(build), str(source), '--buildtype=release',
                 '--prefix=' + str(PREFIX), '--libdir=lib', '--wrap-mode=nodownload', *entry['flags']], source)
            run(['meson', 'compile', '-C', str(build), '-j', '2'], source)
            run(['meson', 'install', '-C', str(build)], source)
        elif entry['buildSystem'] == 'cmake':
            build = source / '_build'
            run(['cmake', '-S', str(source), '-B', str(build), '-DCMAKE_BUILD_TYPE=Release',
                 f'-DCMAKE_INSTALL_PREFIX={PREFIX}', '-DCMAKE_INSTALL_LIBDIR=lib', *entry['flags']], source)
            run(['cmake', '--build', str(build), '--parallel', '2'], source)
            run(['cmake', '--install', str(build)], source)
        elif entry['buildSystem'] == 'configure':
            flags = [f'--prefix={PREFIX}', f'--libdir={PREFIX}/lib', *entry['flags']]
            if entry['name'] != 'zlib':
                flags.append('--enable-option-checking=fatal')
            run(['/bin/sh', './configure', *flags], source)
            run(['make', '-j2'], source)
            run(['make', 'install'], source)
        else:
            raise RuntimeError('Unknown locked build system.')
    # Generate the display profile from the pinned lcms build; no runtime profile download.
    lcms = ctypes.CDLL(str(PREFIX / 'lib' / 'liblcms2.so'))
    lcms.cmsCreate_sRGBProfile.restype = ctypes.c_void_p
    lcms.cmsSaveProfileToFile.argtypes = (ctypes.c_void_p, ctypes.c_char_p)
    lcms.cmsCloseProfile.argtypes = (ctypes.c_void_p,)
    profile = lcms.cmsCreate_sRGBProfile()
    if not profile or not lcms.cmsSaveProfileToFile(profile, str(PREFIX / 'srgb.icc').encode()):
        raise RuntimeError('Display profile creation failed.')
    lcms.cmsCloseProfile(profile)
    shutil.copy2(NATIVE / 'dependencies.lock.json', PREFIX / 'licenses' / 'dependencies.lock.json')


if __name__ == '__main__':
    main()
