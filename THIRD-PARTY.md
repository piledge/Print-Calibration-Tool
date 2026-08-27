# Third-party code and prior art

## Included in this repository

### `vendor/bgcode.js`, `vendor/bgcode.wasm`

A WebAssembly build of **[prusa3d/libbgcode](https://github.com/prusa3d/libbgcode)**,
the reference implementation of Prusa's binary G-code format. It is the only
third-party code this tool ships, and the only reason a `.bgcode` file can be
read in a browser at all.

The two files were taken **unmodified** from
[garethky/PrusaSlicerPressureAdvanceCalibration](https://github.com/garethky/PrusaSlicerPressureAdvanceCalibration)
(`static/js/`), which compiled them with Emscripten.

- libbgcode: **AGPL-3.0** — the same licence this tool uses
- the tool they were taken from: GPL-3.0

Only `bgcode2ascii_and_verify` is called; see `js/reader.js`.

## Prior art, not included

Neither of these is part of this repository. Both were read while designing the
tool.

### [AndrewEllis93/Pressure_Linear_Advance_Tool](https://github.com/AndrewEllis93/Pressure_Linear_Advance_Tool) — GPL-3.0

The chevron pattern of the Pressure Advance test follows the geometry described
in [Ellis' Print Tuning Guide](https://ellis3dp.com/Print-Tuning-Guide/). That
pattern in turn descends from Sineos' Marlin K-factor calibration tool, also
GPL-3.0. The implementation here is new — the geometry is not.

### [garethky/PrusaSlicerPressureAdvanceCalibration](https://github.com/garethky/PrusaSlicerPressureAdvanceCalibration) — GPL-3.0

The idea that carries this whole tool: **do not generate a start and end block —
reuse the slicer's.** The splice points it looks for (`;AFTER_LAYER_CHANGE`,
`; Filament-specific end gcode`) were found there.
