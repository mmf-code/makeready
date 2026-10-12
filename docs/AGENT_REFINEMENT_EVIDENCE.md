# Actual logo refinement: matched-camera evidence

Captured on 12 October 2026 from the downloaded normalized GLBs. These are independent renders of actual provider-derived artifacts, with original materials and embedded textures. They are not fixture models or screenshots of the application UI.

## Result

**The requested approximately 25 mm depth target failed.** The refined model is 69.62725 mm deep. Both versions retain the requested 120 mm overall height.

| Stored-audit measurement | Original | Refined |
| --- | ---: | ---: |
| Height | 120.00000 mm | 120.00000 mm |
| Width | 177.71738 mm | 177.46775 mm |
| Depth | 1.89677 mm | 69.62725 mm |
| Triangles | 79,868 | 80,000 |

The side and three-quarter renders show that the revision changed the thin logo into a substantial extruded body. The front renders retain a recognizable M, light yellow face and black outline. Exact silhouette, regional dimensions and color preservation were not measured; overall bounds do not establish them. The result should not be presented as satisfying the 25 mm requirement.

The saved [height-only measurement](../artifacts/live/logo-refined-20261012-1316/measurement-height-only.json) passes its height checks. The [height-and-depth measurement](../artifacts/live/logo-refined-20261012-1316/measurement.json) records the expected depth failure. This requested-dimension failure is separate from the bounded topology audit and from unimplemented manufacturing checks.

## Visual artifacts

- [Matched contact sheet](../artifacts/live/matched-logo-refinement/contact-sheet.png)
- [Original front](../artifacts/live/matched-logo-refinement/original-front.png) / [refined front](../artifacts/live/matched-logo-refinement/refined-front.png)
- [Original side](../artifacts/live/matched-logo-refinement/original-side.png) / [refined side](../artifacts/live/matched-logo-refinement/refined-side.png)
- [Original three-quarter](../artifacts/live/matched-logo-refinement/original-three_quarter.png) / [refined three-quarter](../artifacts/live/matched-logo-refinement/refined-three_quarter.png)
- [File hashes, camera matrices and texture readiness](../artifacts/live/matched-logo-refinement/render-evidence.json)

These local artifacts are intentionally ignored by Git. The Markdown records their location and provenance; a fresh checkout does not contain the image or model files.

## Capture controls

- Three.js r186, cached Chromium headless shell 1200, SwiftShader; viewport 960 × 720, device scale 1.
- Orthographic frustum 240 × 180 mm, near plane 1 mm, far plane 10 m; target `(0, 60, 0)` mm; Y up.
- Front position `(0, 60, 450)` mm; side `(450, 60, 0)` mm; three-quarter `(318.1980515, 195, 318.1980515)` mm.
- Each pair has exactly equal camera world and projection matrices. Neither model was fitted, rescaled, rotated or recentered by the viewer.
- Background, directional lights, RoomEnvironment and exposure are identical. Original GLB materials are retained, so appearance includes their material response to this lighting.
- Both embedded 4096 × 4096 image textures decoded into ImageBitmaps. Capture followed texture upload, asynchronous shader compilation, four warmed frames and GPU completion.
- The browser independently hashed the bytes it parsed; those hashes match the local files before and after rendering.

## Model identity

| File | SHA-256 |
| --- | --- |
| `artifacts/live/logo-20261012-1256/normalized.glb` | `38f49ed61bba2ab51bd015d23b2b4b0f55abb6165ee2a00b924a19961f9ec265` |
| `artifacts/live/logo-refined-20261012-1316/normalized.glb` | `531ae3a64fdaf3fd942ccff3f72686510c80b81a64c9f23989d720b9e97d59dd` |
| Matched contact sheet PNG | `1b3565179a235993ab2b91539e519d384beab2a9dc8e391b6489db50fe3b5533` |

## Reproduce locally

```sh
node artifacts/live/matched-logo-refinement/capture.mjs
```

The script uses only the two existing local GLBs and a loopback server. It makes no generation, planning, refinement or other paid API call. Screenshots support visual inspection; they do not certify wall thickness, self-intersection, material suitability, tool access or physical manufacture.
