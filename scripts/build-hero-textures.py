#!/usr/bin/env python3
"""Optimize CC0 MakeHuman skin and ambientCG Fabric030 for the physical hero.

Authoring only: python3 scripts/build-hero-textures.py skin.png Fabric030_1K-JPG.zip
Requires Pillow. Sources and licenses are documented in src/assets/CREDITS.md.
"""
from pathlib import Path
from zipfile import ZipFile
from PIL import Image, ImageOps, ImageFilter, ImageStat
import argparse
import io

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('skin', type=Path)
parser.add_argument('fabric', type=Path)
args = parser.parse_args()
output = Path(__file__).resolve().parents[1] / 'src/assets'

def save(image, name, quality=88):
    path = output / name
    image.save(path, 'WEBP', quality=quality, method=6)
    print(f'{name}: {path.stat().st_size:,} bytes')

# A clean upper-chest patch, without baked facial features: our head has its own
# anatomical UVs. Mirrored quadrants make the tile continuous at every edge.
skin = Image.open(args.skin).convert('RGB').crop((340, 300, 596, 556)).resize((256, 256), Image.Resampling.LANCZOS)
tile = Image.new('RGB', (512, 512))
tile.paste(skin, (0, 0)); tile.paste(ImageOps.mirror(skin), (256, 0))
tile.paste(ImageOps.flip(skin), (0, 256)); tile.paste(ImageOps.flip(ImageOps.mirror(skin)), (256, 256))
means = ImageStat.Stat(tile).mean
skin = Image.merge('RGB', [c.point([round(max(0, min(255, v * target / mean))) for v in range(256)])
    for c, mean, target in zip(tile.split(), means, (224, 171, 140))])
save(skin, 'hero-skin-color.webp', 90)
gray = ImageOps.grayscale(skin)
low = gray.filter(ImageFilter.GaussianBlur(3))
# R = height (subtle pores), G = roughness. Both are linear data channels.
height = Image.new('L', gray.size)
height.putdata([max(0, min(255, round(128 + (a-b) * 3))) for a,b in zip(gray.getdata(), low.getdata())])
rough = height.point([round(210 + (v-128) * .18) for v in range(256)])
save(Image.merge('RGB', (height, rough, height)), 'hero-skin-detail.webp', 94)

with ZipFile(args.fabric) as archive:
    def source(channel):
        return Image.open(io.BytesIO(archive.read(f'Fabric030_1K-JPG_{channel}.jpg'))).convert('RGB').resize((512, 512), Image.Resampling.LANCZOS)
    color = ImageOps.grayscale(source('Color'))
    mean = ImageStat.Stat(color).mean[0]
    color = color.point([round(max(170, min(255, 233 * (v / mean) ** .45))) for v in range(256)])
    save(color.convert('RGB'), 'hero-suit-color.webp')
    save(source('NormalGL'), 'hero-suit-normal.webp', 94)
    save(source('Roughness'), 'hero-suit-roughness.webp')
