"""Install project-local Node.js 24 LTS and print shell activation commands."""

import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import sys
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".tools"


def download(url, destination):
    print(f"Downloading {url}", file=sys.stderr)
    with urlopen(url, timeout=120) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def main():
    system = {"Windows": "win", "Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    if not system or not arch:
        raise RuntimeError("Bootstrap supports Windows, macOS, and Linux on x64 or arm64.")

    install = TOOLS / "node"
    binary_dir = install if system == "win" else install / "bin"
    node = binary_dir / ("node.exe" if system == "win" else "node")
    if not node.is_file():
        TOOLS.mkdir(exist_ok=True)
        with urlopen("https://nodejs.org/dist/index.json", timeout=30) as response:
            releases = json.load(response)
        version = next(release["version"] for release in releases if release["version"].startswith("v24.") and release["lts"])
        name = f"node-{version}-{system}-{arch}"
        filename = name + (".zip" if system == "win" else ".tar.gz")
        base = f"https://nodejs.org/dist/{version}"
        with urlopen(f"{base}/SHASUMS256.txt", timeout=30) as response:
            checksums = dict(line.split()[::-1] for line in response.read().decode().splitlines())
        with tempfile.TemporaryDirectory(dir=TOOLS) as temporary:
            directory = Path(temporary)
            archive = directory / filename
            download(f"{base}/{filename}", archive)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != checksums[filename]:
                raise RuntimeError("Node.js archive checksum did not match.")
            if system == "win":
                with zipfile.ZipFile(archive) as bundle:
                    bundle.extractall(directory)
            else:
                with tarfile.open(archive) as bundle:
                    bundle.extractall(directory, filter="data")
            (directory / name).rename(install)

    # Keep npm's cache and any explicit npm --global installs inside this project.
    paths = {
        "npm_config_cache": str(TOOLS / "npm-cache"),
        "npm_config_prefix": str(TOOLS / "npm-global"),
    }
    if os.name == "nt":
        quote = lambda value: "'" + value.replace("'", "''") + "'"
        print(f"$env:Path = {quote(str(binary_dir))} + [IO.Path]::PathSeparator + $env:Path")
        for key, value in paths.items():
            print(f"$env:{key} = {quote(value)}")
    else:
        print(f"export PATH={shlex.quote(str(binary_dir))}:\"$PATH\"")
        for key, value in paths.items():
            print(f"export {key}={shlex.quote(value)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Bootstrap failed: {error}", file=sys.stderr)
        sys.exit(1)
