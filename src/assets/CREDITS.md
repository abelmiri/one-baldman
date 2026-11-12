# City surface textures

`city-surfaces.webp` is derived from these [ambientCG](https://ambientcg.com/) assets:

- [Asphalt 012](https://ambientcg.com/a/Asphalt012)
- [Grass 001](https://ambientcg.com/a/Grass001)
- [Paving Stones 036](https://ambientcg.com/a/PavingStones036)
- [Plaster 001](https://ambientcg.com/a/Plaster001)

All four source assets are provided under [Creative Commons CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
See [ambientCG's license statement](https://docs.ambientcg.com/license/). Commercial use, modification and redistribution are permitted.

The original 1K-JPG color maps were resized to 480 × 480, converted to neutral
luminance centered on 0.5 linear, and packed with 16-pixel wrapped gutters into
a single 1024 × 1024 WebP (quality 78). The game applies its existing color
palette to this detail atlas. No normal, displacement or roughness maps are
required. The shipped image is 88,364 bytes; RGBA8 GPU storage including mipmaps
is approximately 5.33 MiB. WebP reduces transfer size, not GPU texture storage.

To rebuild, download the four original `*_1K-JPG.zip` archives and run
`python3 scripts/build-city-textures.py /path/to/downloads` with Pillow installed.
The archives and Pillow are authoring tools only, not game dependencies.

Vite imports the image as a hashed build asset. The existing service worker
includes it in the production offline cache and build version hash.

# Character skin and suit

- `hero-skin-color.webp` and `hero-skin-detail.webp`: adapted from
  `skins/young_caucasian_male/young_lightskinned_male_diffuse.png` in the
  [MakeHuman system asset pack](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).
  Author: MakeHuman team. License: **CC0 1.0**. See the
  [MakeHuman asset license explanation](https://download.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html).
  Archive: [official download](https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip).
  A clean upper-chest patch is cropped, mirrored for seamless repeat, and color
  balanced. The detail map derives subtle pore height from high-pass luminance
  in R, with roughness in G. It is an approximation, not a scanned normal map.
- `hero-suit-color.webp`, `hero-suit-normal.webp`, `hero-suit-roughness.webp`:
  [ambientCG Fabric 030](https://ambientcg.com/view?id=Fabric030), by ambientCG / Lennart Demes,
  licensed under **CC0 1.0** ([license](https://docs.ambientcg.com/license/)).
  Source archive: `Fabric030_1K-JPG.zip`. The color is neutralized to preserve
  the blue/red costume palette. The tangent-space normal uses the OpenGL
  convention; roughness is retained from the original material.

All five maps are local 512 × 512 WebP assets, totaling **495,066 bytes**;
RGBA8 GPU storage including mipmaps is approximately **6.67 MiB** in total.
Color maps use sRGB; height, normal and roughness maps use linear data.
Materials share the same maps across the character and game resets. Failed
loads retain neutral fallback maps. Vite hashes the assets and the existing
service worker includes them in the production offline cache.

To rebuild with Pillow (authoring only):

```sh
python3 scripts/build-hero-textures.py young_lightskinned_male_diffuse.png Fabric030_1K-JPG.zip
```

Technical references used for implementation:
[Three.js physical materials](https://threejs.org/docs/pages/MeshPhysicalMaterial.html),
[standard material texture channels](https://threejs.org/docs/pages/MeshStandardMaterial.html),
and [Rapier joint motors](https://rapier.rs/docs/user_guides/javascript/joints/).
The protective reflex is an authored game behavior using bounded joint
forces; it is not a biomechanical or medical simulation.
