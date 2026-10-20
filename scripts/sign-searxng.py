import base64
import copy
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
import zipfile


MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}
DEVELOPER_ID = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def sign_native(binary, identity, keychain):
    subprocess.run([
        "/usr/bin/codesign", "--force", "--sign", identity, "--timestamp", "--options", "runtime",
        *(["--keychain", keychain] if keychain else []), str(binary),
    ], check=True)
    subprocess.run([
        "/usr/bin/codesign", "--verify", "--strict", "--all-architectures",
        "--test-requirement", "=" + DEVELOPER_ID, str(binary),
    ], check=True)
    architectures = subprocess.check_output(["/usr/bin/lipo", "-archs", str(binary)], text=True).split()
    if not architectures:
        raise ValueError(f"Mach-O has no architectures: {binary.name}")
    for architecture in architectures:
        details = subprocess.run([
            "/usr/bin/codesign", "--display", "--verbose=4", "--arch", architecture, str(binary),
        ], check=True, capture_output=True, text=True)
        lines = (details.stdout + details.stderr).splitlines()
        if not any(line.startswith("Authority=Developer ID Application:") for line in lines) or not any(
            line.startswith("Timestamp=") and line.removeprefix("Timestamp=").strip() not in ("", "none")
            for line in lines
        ):
            raise ValueError(f"Missing Developer ID or secure timestamp: {binary.name} ({architecture})")


def sign_wheel(wheel, identity, keychain):
    with tempfile.TemporaryDirectory(prefix=".searxng-sign-", dir=wheel.parent) as temporary:
        work = Path(temporary)
        with zipfile.ZipFile(wheel) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            records = [name for name in names if name.endswith(".dist-info/RECORD")]
            if len(set(names)) != len(names) or len(records) != 1:
                raise ValueError(f"Invalid wheel inventory or RECORD: {wheel.name}")
            record = records[0]
            if any(name in names for name in (record + ".jws", record + ".p7s")):
                raise ValueError(f"Cannot replace a signed wheel RECORD: {wheel.name}")
            updates = {}
            for index, entry in enumerate(entries):
                if entry.is_dir():
                    continue
                with archive.open(entry) as member:
                    native = member.read(4) in MACHO_MAGICS
                if native:
                    binary = work / f"native-{index}"
                    binary.write_bytes(archive.read(entry))
                    sign_native(binary, identity, keychain)
                    updates[entry.filename] = binary.read_bytes()
            if not updates:
                return 0
            rows = io.StringIO(newline="")
            writer = csv.writer(rows, lineterminator="\n")
            for entry in entries:
                if entry.is_dir():
                    continue
                name = entry.filename
                data = updates.get(name)
                if data is None:
                    data = archive.read(entry)
                digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
                writer.writerow([name, "" if name == record else f"sha256={digest}", "" if name == record else len(data)])
            updates[record] = rows.getvalue().encode("utf-8")
            rebuilt = work / wheel.name
            with zipfile.ZipFile(rebuilt, "w") as output:
                output.comment = archive.comment
                for entry in entries:
                    data = updates.get(entry.filename)
                    output.writestr(copy.copy(entry), archive.read(entry) if data is None else data)
        rebuilt.replace(wheel)
        print(f"[searxng-sign] {wheel.name}: signed and verified {len(updates) - 1} Mach-O members", flush=True)
        return len(updates) - 1


def sign_bundle(root, identity, keychain):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    lock_bytes = (root / "source/matchaclaw-build/scripts/searxng-wheels.json").read_bytes()
    requirements_path = root / "requirements.lock"
    requirements_bytes = requirements_path.read_bytes()
    if sha256(lock_bytes) != manifest["wheelLockSha256"] or sha256(requirements_bytes) != manifest["requirementsSha256"]:
        raise ValueError("SearXNG input lock or requirements checksum mismatch")
    lock = json.loads(lock_bytes)
    targets = sorted((root / "wheels").glob("darwin-*"))
    if not targets:
        raise ValueError("No macOS SearXNG wheels to sign")
    wheels = []
    for directory in targets:
        expected = lock["targets"][directory.name]
        filenames = {Path(urlparse(wheel["url"]).path).name for wheel in expected}
        if {entry.name for entry in directory.iterdir()} != filenames:
            raise ValueError(f"SearXNG wheel inventory mismatch: {directory.name}")
        for wheel in expected:
            filename = Path(urlparse(wheel["url"]).path).name
            file = directory / filename
            data = file.read_bytes()
            if sha256(data) != wheel["sha256"] or len(data) != wheel["size"]:
                raise ValueError(f"SearXNG upstream wheel checksum mismatch: {filename}")
            wheels.append((file, wheel["sha256"]))
    requirements = requirements_bytes.decode("utf-8")
    replacements = {}
    for wheel, original in wheels:
        if sign_wheel(wheel, identity, keychain):
            updated = sha256(wheel.read_bytes())
            replacements.setdefault(original, set()).add(updated)
    for original, updated in replacements.items():
        token = f"--hash=sha256:{original}"
        if token not in requirements:
            raise ValueError("Signed SearXNG wheel is missing from requirements.lock")
        requirements = requirements.replace(token, " \\\n    ".join(f"--hash=sha256:{digest}" for digest in sorted(updated)))
    requirements_path.write_bytes(requirements.encode("utf-8"))


if __name__ == "__main__":
    sign_bundle(Path(sys.argv[1]), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
