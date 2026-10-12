"""Builds one upload-ready zip per game portal from web/.

    python tools/build_portals.py                 # all portals
    python tools/build_portals.py crazygames poki  # only some

Each build is a copy of web/ with data-portal set on <html> (js/portal.js
reads it) and the portal's SDK <script> tag added where the portal asks for
one. Output goes to dist/<portal>/ and dist/night-garden-snake-<portal>.zip,
with index.html at the root of the zip as every portal expects.

GameDistribution needs your game id from their dashboard:
    GD_GAME_ID=xxxxxxxx python tools/build_portals.py gamedistribution
"""
import os
import re
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")

# SDKs that the portal wants in <head>. The others are loaded by js/portal.js.
HEAD_SCRIPTS = {
    "crazygames": '<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>',
    "poki": '<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>',
    "yandex": '<script src="/sdk.js"></script>',
}
PORTALS = ["crazygames", "poki", "yandex", "gamedistribution"]


def build(portal):
    out = os.path.join(DIST, portal)
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(WEB, out)

    index = os.path.join(out, "index.html")
    with open(index, encoding="utf-8") as f:
        html = f.read()
    attrs = f'data-portal="{portal}"'
    if portal == "gamedistribution":
        gd_id = os.environ.get("GD_GAME_ID", "").strip()
        if not gd_id:
            print("  warning: GD_GAME_ID is not set, the GameDistribution build will run without ads")
        elif not re.fullmatch(r"[A-Za-z0-9]+", gd_id):
            sys.exit("GD_GAME_ID should only contain letters and digits")
        attrs += f' data-gd-id="{gd_id}"'
    html, n = re.subn(r'data-portal="[a-z]+"', attrs, html, count=1)
    if n != 1:
        sys.exit("index.html has no data-portal attribute")
    if portal in HEAD_SCRIPTS:
        html = html.replace("</head>", f"{HEAD_SCRIPTS[portal]}\n</head>", 1)
    with open(index, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    archive = os.path.join(DIST, f"night-garden-snake-{portal}.zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(out):
            for name in sorted(files):
                path = os.path.join(folder, name)
                z.write(path, os.path.relpath(path, out).replace(os.sep, "/"))
    count = sum(len(f) for _, _, f in os.walk(out))
    print(f"  {portal:17s} {count:3d} files, {os.path.getsize(archive) // 1024} KB -> {os.path.relpath(archive, ROOT)}")


def main():
    wanted = sys.argv[1:] or PORTALS
    unknown = [p for p in wanted if p not in PORTALS]
    if unknown:
        sys.exit(f"unknown portal(s): {', '.join(unknown)}. Choose from: {', '.join(PORTALS)}")
    os.makedirs(DIST, exist_ok=True)
    print("Building portal zips:")
    for p in wanted:
        build(p)


if __name__ == "__main__":
    main()
