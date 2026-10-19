import argparse
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib


def extract_source(archive, output, revision):
    if any(output.iterdir()):
        raise ValueError("source extraction requires an empty directory")
    prefix = f"searxng-{revision}"
    with tarfile.open(archive, "r:gz") as bundle:
        if bundle.pax_headers.get("comment") != revision:
            raise ValueError("source archive commit does not match the pinned revision")
        members = bundle.getmembers()
        if sum(member.size for member in members) > 256 * 1024 * 1024:
            raise ValueError("source archive exceeds 256 MiB")
        seen = set()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != prefix or ".." in parts or "\\" in member.name:
                raise ValueError("invalid source archive path")
            if len(parts) > 1 and parts[1] == "searx" and any(":" in part for part in parts):
                raise ValueError("runtime source has a Windows alternate-stream path")
            if len(parts) > 1 and parts[1] == "searx" and not member.isfile() and not member.isdir():
                raise ValueError("runtime source links and special files are not allowed")
            relative = PurePosixPath(*parts[1:])
            if member.isfile() and str(relative).lower() in seen:
                raise ValueError("duplicate source archive file")
            seen.add(str(relative).lower())
        # searx contains WSGI code, engine data, translations, static files and templates.
        for member in members:
            parts = PurePosixPath(member.name).parts[1:]
            if not parts or not member.isfile():
                continue
            if parts[0] != "searx" and member.name.rsplit("/", 1)[-1] not in (
                "LICENSE", "AUTHORS.rst", "README.rst", "requirements.txt"
            ):
                continue
            if parts[0] != "searx" and len(parts) != 1:
                continue
            destination = output.joinpath(*parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as content:
                destination.write_bytes(content.read())


def describe_lock(lock):
    packages = tomllib.loads(lock.read_text(encoding="utf-8"))["packages"]
    wheels = []
    for package in packages:
        if not package.get("wheels"):
            raise ValueError(f"target lock has no binary wheel: {package['name']}")
        for wheel in package["wheels"]:
            wheels.append({
                "name": package["name"], "version": package["version"],
                "url": wheel["url"], "sha256": wheel["hashes"]["sha256"],
                "size": wheel["size"],
            })
    print(json.dumps(wheels, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--output", type=Path, required=True)
    extract.add_argument("--revision", required=True)
    lock = commands.add_parser("describe-lock")
    lock.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "extract":
        extract_source(args.archive, args.output, args.revision)
    else:
        describe_lock(args.lock)


if __name__ == "__main__":
    main()
