#!/usr/bin/env python3
"""Build the shipped atlas from ambientCG's original CC0 1K-JPG ZIPs.

Requires Pillow (authoring only). Download Asphalt012, Grass001,
PavingStones036 and Plaster001 from https://ambientcg.com, then run:
  python3 scripts/build-city-textures.py /path/to/downloads
No source archives or additional Python dependencies ship with the game.
"""
from pathlib import Path
from zipfile import ZipFile
import argparse
import io
from PIL import Image, ImageOps, ImageStat

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('sources', type=Path)
args = parser.parse_args()
atlas = Image.new('RGB', (1024, 1024))
for index, asset in enumerate(('Asphalt012', 'Grass001', 'PavingStones036', 'Plaster001')):
    with ZipFile(args.sources / f'{asset}_1K-JPG.zip') as archive:
        image = Image.open(io.BytesIO(archive.read(f'{asset}_1K-JPG_Color.jpg'))).convert('RGB')
    image = ImageOps.grayscale(image.resize((480, 480), Image.Resampling.LANCZOS))
    mean = ImageStat.Stat(image).mean[0]
    # Neutral detail preserves the game's per-instance palette. Store sRGB,
    # centered on .5 linear so the shader can recover a unit-mean multiplier.
    def encode(value):
        linear = max(.15, min(.85, .5 * (value / mean) ** .9))
        return round(255 * (1.055 * linear ** (1 / 2.4) - .055))
    image = image.point([encode(value) for value in range(256)]).convert('RGB')
    padded = Image.new('RGB', (512, 512))
    # Wrap the tile into its gutter for correct repeat filtering.
    for dx in (-480, 0, 480):
        for dy in (-480, 0, 480):
            padded.paste(image, (16 + dx, 16 + dy))
    atlas.paste(padded, ((index % 2) * 512, (index // 2) * 512))
output = Path(__file__).resolve().parents[1] / 'src/assets/city-surfaces.webp'
atlas.save(output, 'WEBP', quality=78, method=6)
print(f'{output.name}: {output.stat().st_size:,} bytes, 1024 x 1024')
