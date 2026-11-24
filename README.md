# CometStack for PixInsight

PixInsight script for stacking comets[cite: 4].

- **Comet Stacking** (`CometStack.js`) - comet stacking for OSC camera data,
  producing sharp stars *and* a sharp, deep comet in one output image[cite: 1, 4]. Tested
  on **DWARF mini** as well as the **Askar 200mm f/4** and **ZWO ASI2600MC Duo**[cite: 1, 4].

## Installation

Copy `CometStack.js` into your PixInsight scripts folder (or register your
script folder via **Script → Feature Scripts...**), then restart or refresh
scripts in PixInsight[cite: 4]. It will appear under **Script → CometStack**[cite: 1, 4].

*(Optional)* If you include a small comet icon file alongside `CometStack.js`
and reference it with `#feature-icon` at the top of the script, it will appear
with that icon in PixInsight's feature/script list[cite: 1, 4].

## Comet Stacking

`CometStack.js`

Stacks comet images from an OSC camera in one guided run: sharp, round
stars and a clean, deep comet in a single output image - without the usual
multi-tool, multi-pass manual workflow[cite: 1, 4]. It has been tested with
**DWARF mini** data and with data captured using an **Askar 200mm f/4**
telescope and **ZWO ASI2600MC Duo** camera[cite: 1, 4].

Comets move relative to the background stars over the course of an imaging
session[cite: 4]. Stack a sequence normally and you get either trailed stars (if you
track the comet) or a smeared comet (if you track the stars) - never both
sharp at once[cite: 4]. This script produces both by building two separate stacks
internally and combining them[cite: 1, 4]:

1. **Optionally calibrate** each light against matching dark, flat, and/or bias
   frames, if you point it at a calibration library[cite: 1, 4].
2. **Debayer** every light frame (raw OSC/Bayer data → RGB)[cite: 1, 4].
3. **StarAlignment & jump detection** - register every frame to a common star-fixed
   reference (`_r.xisf`), sort frames chronologically by Julian Date from `DATE-OBS`,
   detect time gaps (> 45 min) or sudden frame-to-frame shifts/reframes (> 80 px),
   and log warnings for large shifts (> 250 px) without rejecting frames[cite: 1, 4].
4. **Mark the comet's nucleus on anchor frames** - always the first and last
   frames, plus frames bordering any detected time gap or shift jump - using a
   picker built into the dialog (with `AutomaticBackgroundExtractor` flattening for
   easier viewing and automatic cleanup of temporary `*_ABE_background`
   windows)[cite: 1, 4]. No other PixInsight window ever needs focus[cite: 1, 4].
5. **Piecewise interpolation, local refinement & CometAlignment** - linearly
   interpolates the comet's position by Julian Date between anchors, refines
   intermediate frames locally within a ±35 px search box using a
   background-subtracted centroid (falling back to the interpolated position if
   signal is weak), and passes every frame as `fixed` to `CometAlignment`
   (`_ca.xisf`) to avoid PixInsight's broken non-fixed interpolation[cite: 1, 4].
6. **StarNet2** removes the stars from every comet-aligned frame (`_sn.xisf`)[cite: 1, 4].
7. **ImageIntegration** stacks the starless, comet-aligned frames into
   `cometStackLayer` - one deep, clean comet image without star trails[cite: 1, 4].
8. **PixelMath** isolates stars from the star-aligned reference frame
   (`max(0, refStarsLayer - refStarlessLayer)`) and screen-blends them over
   the comet stack (`1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)`),
   producing `CometStack_final` with both sharp stars and a sharp, deep comet[cite: 1, 4].

**Running it:** a dialog walks you through the workflow; the button for
whatever you should click next is highlighted green, and once stacking
completes, the **Close** button is highlighted green[cite: 1, 4]. A live
**Process Activity Log** shows step progress and warnings[cite: 1], and the
bottom bar provides **Stop Process**, **Close**, **Info / Process**, and
**Donate**[cite: 1].

1. **Select Calibration Folder (Optional)** - before or while preparing lights,
   point to the root calibration library folder if you want dark/flat/bias
   calibration[cite: 1, 4].
2. **Select Light Frames Folder** - pick the folder containing your light
   frames (at least 3)[cite: 1, 4]. If a calibration library was selected,
   matching frames are calibrated into `0_calibrated/`; then every frame is
   debayered (`1_debayer/`), star-aligned (`2_aligned/`), sorted
   chronologically, and scanned for time gaps and shift/reframe jumps[cite: 1, 4].
3. **Mark Nucleus on Anchors and Run** - opens the embedded picker on each
   required anchor frame (first, last, and any gap/shift boundary frames): click
   roughly on the comet to zoom in, then drag a small box around the nucleus
   (releasing confirms it via a brightness-weighted centroid, so the drag doesn't
   need to be pixel-perfect)[cite: 1, 4]. A tap without dragging while zoomed in goes
   back to the overview, and closing the picker cancels the step[cite: 1, 4].
   Once all anchors are confirmed, stacking runs automatically through
   piecewise interpolation and local centroid refinement, `CometAlignment`,
   `StarNet2`, `ImageIntegration`, star isolation, screen blending, AutoSTF
   preview stretch, and saving `CometStack_final.xisf` in `CometStack_work`
   next to your lights[cite: 1, 4]. The intermediate `cometStackLayer` window is
   closed automatically once `CometStack_final` is created[cite: 1, 4].

**Optional calibration frames:** click **Select Calibration Folder (Optional)...**
and point to the **root folder** containing subfolders named **`dark`**,
**`flat`**, and/or **`bias`** (exact lowercase singular names - e.g.
`CalibLibrary/dark/`, `CalibLibrary/flat/`, `CalibLibrary/bias/`, not
`Darks`/`Flats`/`Biases`)[cite: 1, 4]. Subfolders inside those directories are
allowed (such as camera subdirectories like `cam_0` / `cam_1` or `IR`
folders, matching DWARF-series library layouts)[cite: 1, 4]. The folder is
scanned recursively, and metadata is parsed from filenames (including DWARF
master naming conventions) or read from FITS/XISF headers[cite: 1, 4]. Frames are
matched on camera, gain, and binning (plus exposure time and detector
temperature for darks; ambiguous multi-IR master flats are skipped)[cite: 1, 4].
Any frame type without a clean match is skipped rather than guessed at[cite: 1, 4].

**Notes and caveats:**
- **StarNet2 runtime & progress log:** Removing stars with StarNet2 can take a
  very long time depending on your computer's speed, GPU/CPU setup, and image
  size[cite: 1, 4]. The script logs a note when StarNet2 starts and updates both
  the status line and log with rolling average frame duration and estimated
  time remaining after each frame finishes[cite: 1, 4]. It also calls
  `processEvents()` and `gc()` between frames to help keep long batch runs
  stable[cite: 1, 4].
- **Nucleus over-removal check:** StarNet2 can soften a compact nucleus—the
  script checks peak brightness around the nucleus before and after StarNet2
  and logs a warning if it drops below 40% of its original brightness[cite: 1, 4].
- **Resumable prep steps:** Re-running light preparation on the same folder
  reuses already-completed calibration, debayer, and alignment outputs when
  counts match[cite: 1, 4].
- **GNOME/Mutter window dragging:** If the dialog is stuck in the center of
  the screen and won't drag, this is a GNOME/Mutter setting, not a bug:
  `Dialog.execute()` produces an independent top-level window, but GNOME's
  default `attach-modal-dialogs` behavior locks modal dialogs to their parent[cite: 4].
  Fix with `gsettings set org.gnome.mutter attach-modal-dialogs false` (revert
  any time with `... true`)[cite: 4].

**Requirements:** PixInsight with `AutomaticBackgroundExtractor`,
`Debayer`, `StarAlignment`, `CometAlignment`, `StarNet2`, `ImageIntegration`,
`PixelMath`, and (if using calibration) `ImageCalibration` installed[cite: 1, 4];
at least 3 light frames from an OSC/color camera (`.fits`, `.fit`, or
`.xisf`) with valid `DATE-OBS` timestamps in their headers[cite: 1, 4].
