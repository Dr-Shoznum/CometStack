# CometStack for PixInsight

PixInsight script for stacking comets[cite: 7]

- **Comet Stacking** (`CometStack.js`) - comet stacking for OSC camera data,
  producing sharp stars *and* a sharp, deep comet in one output image[cite: 7].

## Installation

Copy `CometStack.js` into your PixInsight scripts folder (or register your
script folder via **Script → Feature Scripts...**), then restart or refresh
scripts in PixInsight. It will appear under **Script → CometStack**.

*(Optional)* If you include a small comet icon file alongside `CometStack.js`
and reference it with `#feature-icon` at the top of the script, it will appear
with that icon in PixInsight's feature/script list.

## Comet Stacking

`CometStack.js`[cite: 7]

Stacks comet images from an OSC camera in one guided run: sharp, round
stars and a clean, deep comet in a single output image - without the usual
multi-tool, multi-pass manual workflow[cite: 7].

Comets move relative to the background stars over the course of an imaging
session[cite: 7]. Stack a sequence normally and you get either trailed stars (if you
track the comet) or a smeared comet (if you track the stars) - never both
sharp at once[cite: 7]. This script produces both by building two separate stacks
internally and combining them[cite: 7]:

1. **Optionally calibrate** each light against matching dark, flat, and/or bias
   frames, if you point it at a calibration library[cite: 1, 7].
2. **Debayer** every light frame (raw OSC/Bayer data → RGB)[cite: 1, 7].
3. **StarAlignment** - register every frame to a common star-fixed
   reference and sort frames chronologically by Julian Date from `DATE-OBS`[cite: 1, 7].
4. **Mark the comet's nucleus** in the first and last frame using a picker
   built into the dialog (with `AutomaticBackgroundExtractor` flattening for
   easier viewing and automatic cleanup of temporary `*_ABE_background`
   windows) - no other PixInsight window ever needs focus[cite: 1, 4, 7].
5. **CometAlignment** - using those two positions and each frame's Julian
   Date, linearly interpolates the comet's position across the sequence and
   passes every frame as `fixed` so the comet is stationary (stars now trail,
   but that's fixed in the next step)[cite: 1, 7].
6. **StarNet2** removes the stars from every comet-aligned frame[cite: 1, 7].
7. **ImageIntegration** stacks the starless, comet-aligned frames into
   `cometStackLayer` - one deep, clean comet image without star trails[cite: 1, 7].
8. **PixelMath** isolates stars from the star-aligned reference frame
   (`max(0, refStarsLayer - refStarlessLayer)`) and screen-blends them over
   the comet stack (`1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)`),
   producing `CometStack_final` with both sharp stars and a sharp, deep comet[cite: 1, 7].

**Running it:** a dialog walks you through the workflow; the button for
whatever you should click next is highlighted green, and once stacking
completes, only the **Close** button is highlighted green[cite: 1, 7].

1. **Select Calibration Folder (Optional)** - before or while preparing lights,
   point to the root calibration library folder if you want dark/flat/bias
   calibration[cite: 1, 7].
2. **Select Light Frames Folder** - pick the folder containing your light
   frames (at least 3)[cite: 1, 7]. If a calibration library was selected,
   matching frames are calibrated into `0_calibrated/`; then every frame is
   debayered (`1_debayer/`), star-aligned (`2_aligned/`), and sorted
   chronologically[cite: 1, 7].
3. **Mark Nucleus (First, then Last Frame) & Run** - opens the embedded
   picker twice in a row (first frame, then last frame): click roughly on the
   comet to zoom in, then drag a small box around the nucleus (releasing
   confirms it via a brightness-weighted centroid, so the drag doesn't need to
   be pixel-perfect)[cite: 1, 7]. A tap without dragging while zoomed in goes
   back to the overview[cite: 1, 7], and closing the picker cancels the step[cite: 7].
   As soon as the second frame is confirmed, stacking runs automatically
   through `CometAlignment`, `StarNet2`, `ImageIntegration`, star isolation,
   screen blending, AutoSTF preview stretch, and saving `CometStack_final.xisf`
   in `CometStack_work` next to your lights[cite: 1, 7]. The intermediate
   `cometStackLayer` window is closed automatically once `CometStack_final` is
   created[cite: 6].

**Optional calibration frames:** click **Select Calibration Folder (Optional)...**
and point to the **root folder** containing subfolders named **`dark`**,
**`flat`**, and/or **`bias`** (exact lowercase singular names - e.g.
`CalibLibrary/dark/`, `CalibLibrary/flat/`, `CalibLibrary/bias/`, not
`Darks`/`Flats`/`Biases`)[cite: 1]. Subfolders inside those directories are
allowed[cite: 1] (such as camera subdirectories like `cam_0` / `cam_1` or `IR`
folders[cite: 1], matching DWARF-series library layouts[cite: 7]). The folder is
scanned recursively, and metadata is parsed from filenames (including DWARF
master naming conventions) or read from FITS/XISF headers[cite: 1, 7]. Frames are
matched on camera, gain, and binning (plus exposure time and detector
temperature for darks; ambiguous multi-IR master flats are skipped)[cite: 1].
Any frame type without a clean match is skipped rather than guessed at[cite: 1, 7].

**Notes and caveats:**
- **StarNet2 runtime & progress log:** Removing stars with StarNet2 can take a
  very long time depending on your computer's speed, GPU/CPU setup, and image
  size. The script logs a warning when StarNet2 starts and estimates remaining
  time after the first frame finishes based on how long frame 1 took and how
  many frames remain. It also calls `processEvents()` and `gc()` between
  frames to help keep long batch runs stable[cite: 1].
- **Nucleus over-removal check:** StarNet2 can soften a compact nucleus—the
  script checks peak brightness around the nucleus before and after StarNet2
  and logs a warning if it drops below 40% of its original brightness[cite: 1].
- **Resumable prep steps:** Re-running light preparation on the same folder
  reuses already-completed calibration, debayer, and alignment outputs when
  counts match[cite: 1, 7].
- **GNOME/Mutter window dragging:** If the dialog is stuck in the center of
  the screen and won't drag, this is a GNOME/Mutter setting, not a bug:
  `Dialog.execute()` produces an independent top-level window, but GNOME's
  default `attach-modal-dialogs` behavior locks modal dialogs to their parent[cite: 7].
  Fix with `gsettings set org.gnome.mutter attach-modal-dialogs false` (revert
  any time with `... true`)[cite: 7].

**Requirements:** PixInsight with `AutomaticBackgroundExtractor`,
`Debayer`, `StarAlignment`, `CometAlignment`, `StarNet2`, `ImageIntegration`,
`PixelMath`, and (if using calibration) `ImageCalibration` installed[cite: 1];
at least 3 light frames from an OSC/color camera (`.fits`, `.fit`, or
`.xisf`) with valid `DATE-OBS` timestamps in their headers[cite: 1].
