# Print Calibration Tool

Three print-calibration tests in the browser. Feed it a file you sliced yourself,
pick a range, get G-code back. No install, no build step, no upload — the file
never leaves your machine.

![Pressure Advance test](docs/pressure-advance.png)

Most calibration tools generate a print from scratch and guess at your machine.
This one starts from **your** sliced file, so every setting you care about —
start G-code, temperatures, retraction, cooling, flow — is already the one you
print with. The tool only adds what the test needs.

## Quick start

1. Slice a file with your own settings (see each test below for what to slice).
2. Open the tool and drop the file on it.
3. Pick the range you want to test.
4. Download and print.
5. Click the best specimen. The tool tells you the value and where to enter it.

Run it locally with any static web server — HTTP is required because ES modules
and WebAssembly do not load over `file://`:

```sh
./serve.sh            # http://localhost:8080
```

Needs Python 3 for that one-line server, nothing else. There are no
dependencies, no build, and no `npm install`.

## Pressure Advance

Takes any sliced file, keeps its start and end block, and puts a chevron pattern
between them — the pattern from
[Andrew Ellis' tuning guide](https://ellis3dp.com/Print-Tuning-Guide/), redrawn.
Every chevron is printed at a different Pressure Advance value; the sharpest
corner wins.

Because the slicer's own blocks survive, the test heats, homes, meshes and purges
exactly like your normal prints. Slice anything — the model is thrown away, only
the settings are kept.

## Extrusion Multiplier

![Extrusion Multiplier test](docs/extrusion-multiplier.png)

Takes a plate of 56 identical tiles and rewrites the extrusion of each one, so
every tile is printed at a different multiplier. The target value is read from
the object's name (`0.945` or `EM_Cube-0.945.stl`), nothing is re-generated —
the geometry stays byte for byte what your slicer produced.

Slice the [template](template/) with all 56 tiles, then pick a range in the tool.
The tiles outside it are cut out of the file, so a five-tile run really only
prints five tiles.

Print settings must have **Output options → Label objects** set to
*Firmware-specific*; that is how the tool tells the tiles apart.

## Temperature Tower

![Temperature Tower test](docs/temperature-tower.png)

Takes the sliced tower and sets the hotend temperature for each 10 mm band:
21 bands from 180 °C at the bottom to 280 °C at the top, in 5 °C steps, with the
values embossed on the model.

Slice the [template](template/) at its full height, then pick a range. The tool
cuts the tower down to those bands and stands them on the model's own base — so a
three-band run is a 30 mm print, not a 210 mm one, and it still starts on a
proper first layer.

The switch is issued right after the first layer, so the hotend changes
temperature while the rest of the base prints. No waiting mid-print.

## What it does to your file

- **Start and end block are the slicer's**, untouched. Your `PRINT_START` macro
  keeps its arguments, your purge line stays your purge line.
- **Nothing is re-generated** in the two rewriting tests. Apart from the E values
  the Extrusion Multiplier test scales, and the Z the tower shifts when you trim
  it, the output is line for line the input.
- **Filament and time in the header are recalculated** so the printer's estimate
  matches what it is really about to do.
- **Preview thumbnails are replaced** with a picture of the test itself, so you
  can see on the printer's screen which value sits where.
- **Everything runs locally.** The tool makes no network requests of any kind;
  the only third-party code is Prusa's own `libbgcode` compiled to WebAssembly,
  which is what reads `.bgcode` files.

## Printers and firmware

| | Voron 2.4 | Prusa CORE One |
|---|---|---|
| Firmware | Klipper | Marlin2 |
| PA command | `SET_PRESSURE_ADVANCE ADVANCE=` | `M572 S` |
| Object markers | `EXCLUDE_OBJECT_START/END` | `M486 S<id>` |
| E counting | absolute | relative |
| Input format | `.gcode` | `.bgcode` |

Those two are the machines it is tested against on every change. Also recognised:
Marlin 1.x (`M900 K`), RepRapFirmware (`M572 D S`) and the older Prusa models
XL/XL2/XL5/MK4/MINI (`M900 K`).

Not supported: round beds, beds whose origin is not 0×0, slicers other than
PrusaSlicer, and multi-extruder setups beyond detecting the tool index.

## Templates

The two models the rewriting tests need are in [`template/`](template/) and are
offered for download inside the tool:

| | |
|---|---|
| `Temperature_Tower.stl` | 21 bands, 180 … 280 °C, values embossed |
| `Extrusion_Multipliers.3mf` | 56 tiles, 0.850 … 1.125 in steps of 0.005 |

Both must be sliced complete — the tool checks and refuses a partial plate or a
tower cut short, because the range you pick is applied here, not in the slicer.

## Development

No build step, no dependencies. `sh tools/test_all.sh` runs everything and has to
end with `ALLES GRUEN`: golden files, fingerprints, three independent checkers
that verify a generated file against its own input, unit cases and two sweeps.

`ENTWICKLUNG.md` describes the module layout and the test harness,
`KONZEPT.md` every module contract and formula, `VORGABEN.md` the requirements.
Those three are in German.

## Licence

Two different ones, deliberately:

| | |
|---|---|
| The tool — `index.html`, `css/`, `js/`, `tools/` | **AGPL-3.0**, see `LICENSE.txt` |
| The models — `template/*.stl`, `template/*.3mf` | **CC BY-NC 4.0** |
| `vendor/bgcode.js`, `vendor/bgcode.wasm` | Prusa's libbgcode, AGPL-3.0, unmodified |

The models are under
[Creative Commons Attribution-NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
and are **not** covered by the AGPL: share and adapt them freely with attribution,
but not commercially. Running the tool commercially is allowed by the AGPL — just
not with the two files in `template/`. See [`template/LICENSE.md`](template/LICENSE.md).

The chevron pattern descends from Sineos' Marlin K-factor tool by way of Andrew
Ellis' tuning guide, both GPLv3.

## Documents

- `ENTWICKLUNG.md` — module layout and the test harness (German)
- `KONZEPT.md` — technical concept, every formula (German)
- `VORGABEN.md` — requirements and the decisions taken (German)
- `NOTIZEN-referenz-tools.md` — analysis of the two prior-art tools (German)
