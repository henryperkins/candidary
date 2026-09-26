# Run local decoder work through Docker Engine in WSL, independent of Docker Desktop.
[CmdletBinding()]
param(
    [ValidateSet('check', 'build', 'verify', 'boundary', 'serve', 'stop')]
    [string]$Action = 'check',
    [string]$Distribution = 'Ubuntu-26.04',
    [string]$Image = 'candidary-image-decoder:verification',
    [ValidateSet('baseline-raster', 'heif-avif', 'jxl-jp2', 'raw', 'rendering')]
    [string]$Group = 'baseline-raster',
    # Only a disposable bridge container started by 'serve' can be stopped.
    [string]$Container = ''
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$previousWslEncoding = $env:WSL_UTF8
try {
    $env:WSL_UTF8 = '1'
    $linuxRoot = & wsl.exe --distribution $Distribution --exec wslpath -a -u $repositoryRoot
    if ($LASTEXITCODE -ne 0) { throw 'The WSL distribution or repository path is unavailable.' }
    $linuxRoot = ($linuxRoot -join "`n").Trim()
    $bridgeName = 'candidary-image-bridge-' + [guid]::NewGuid().ToString('N')
    if ($Action -eq 'stop' -and $Container -notmatch '^candidary-image-bridge-[0-9a-f]{32}$') {
        throw 'Only a disposable candidary-image-bridge container can be stopped.'
    }

    $commandArgs = switch ($Action) {
        'check' { @('docker', 'version') }
        'build' {
            @('docker', 'build', '--progress', 'plain', '--platform', 'linux/amd64',
              '-t', $Image, '-f', 'services/image-decoder/native/Dockerfile', '.')
        }
        'verify' {
            @('python3', 'services/image-decoder/native/verify_service.py', '--image', $Image,
              '--manifest', 'tests/fixtures/mobile-images/manifest.json', '--group', $Group,
              '--report', "output/verification/mobile-images/$Group-wsl.json")
        }
        'boundary' {
            @('python3', '-m', 'unittest', 'discover', '-s',
              'services/image-decoder/native', '-p', 'test_boundary.py')
        }
        # Same isolation as verify_service.py's disposable qualification container.
        'serve' {
            @('docker', 'run', '-d', '--pull', 'never', '--name', $bridgeName, '--network', 'none', '--read-only', '--memory', '4g',
              '--cpus', '2', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
              '--tmpfs', '/tmp:rw,size=2147483648,uid=10001,gid=10001', $Image)
        }
        'stop' { @('docker', 'rm', '-f', $Container) }
    }

    # Use the distro's Unix socket even if another Docker context is selected.
    # No Docker API TCP listener or global context change is needed.
    $docker = @('--distribution', $Distribution, '--cd', $linuxRoot, '--exec', 'env', '-u', 'DOCKER_CONTEXT',
                'DOCKER_HOST=unix:///var/run/docker.sock')
    if ($Action -eq 'serve') {
        $null = & wsl.exe @docker @commandArgs
        $commandExit = $LASTEXITCODE
        if ($commandExit -eq 0) {
            # Wait for the private health route inside the container, then print only its name.
            $probe = "import http.client as h;c=h.HTTPConnection('127.0.0.1',8080,timeout=2);c.request('GET','/health');r=c.getresponse();r.read();raise SystemExit(r.status!=200)"
            $commandExit = 1
            for ($attempt = 0; $attempt -lt 60 -and $commandExit -ne 0; $attempt++) {
                if ($attempt) { Start-Sleep -Milliseconds 500 }
                $null = & wsl.exe @docker docker exec $bridgeName python -c $probe 2>$null
                $commandExit = $LASTEXITCODE
            }
            if ($commandExit -eq 0) { Write-Output $bridgeName }
            else { $null = & wsl.exe @docker docker rm -f $bridgeName 2>$null }
        }
    } else {
        & wsl.exe @docker @commandArgs
        $commandExit = $LASTEXITCODE
    }
} finally {
    $env:WSL_UTF8 = $previousWslEncoding
}
exit $commandExit
