# CometStack for PixInsight

PixInsight script for stacking comets.

- **Comet Stacking** (`CometStack.js`) - comet stacking for OSC camera data,
  producing sharp stars *and* a sharp, deep comet in one output image. Tested
  on **DWARF mini** as well as the **Askar 200mm f/4** and **ZWO ASI2600MC Duo**.

## Installation

Copy `CometStack.js` into your PixInsight scripts folder (or register your
script folder via **Script → Feature Scripts...**), then restart or refresh
scripts in PixInsight. It will appear under **Script → CometStack**.

*(Optional)* If you include a small comet icon file alongside `CometStack.js`
and reference it with `#feature-icon` at the top of the script, it will appear
with that icon in PixInsight's feature/script list.

## Comet Stacking

`CometStack.js`

Stacks comet images from an OSC camera in one guided run: sharp, round
stars and a clean, deep comet in a single output image - without the usual
multi-tool, multi-pass manual workflow. It has been tested with
**DWARF mini** data and with data captured using an **Askar 200mm f/4**
telescope and **ZWO ASI2600MC Duo** camera.

Comets move relative to the background stars over the course of an imaging
session. Stack a sequence normally and you get either trailed stars (if you
track the comet) or a smeared comet (if you track the stars) - never both
sharp at once. This script produces both by building two separate stacks
internally and combining them:

1. **Optionally calibrate** each light against matching dark, flat, and/or bias
   frames, if you point it at a calibration library.
2. **Debayer** every light frame (raw OSC/Bayer data → RGB).
3. **StarAlignment & jump detection** - register every frame to a common star-fixed
   reference (`_r.xisf`), sort frames chronologically by Julian Date from `DATE-OBS`,
   detect time gaps (> 45 min) or sudden frame-to-frame shifts/reframes (> 80 px),
   and log warnings for large shifts (> 250 px) without rejecting frames.
4. **Mark the comet's nucleus on anchor frames** - always the first and last
   frames, plus frames bordering any detected time gap or shift jump - using a
   picker built into the dialog (with `AutomaticBackgroundExtractor` flattening for
   easier viewing and automatic cleanup of temporary `*_ABE_background`
   windows). No other PixInsight window ever needs focus.
5. **Piecewise interpolation, local refinement & CometAlignment** - linearly
   interpolates the comet's position by Julian Date between anchors, refines
   intermediate frames locally within a ±35 px search box using a
   background-subtracted centroid (falling back to the interpolated position if
   signal is weak), and passes every frame as `fixed` to `CometAlignment`
   (`_ca.xisf`) to avoid PixInsight's broken non-fixed interpolation.
6. **StarNet2** removes the stars from every comet-aligned frame (`_sn.xisf`).
7. **ImageIntegration** stacks the starless, comet-aligned frames into
   `cometStackLayer` - using **Median** combination by default to suppress
   faint walking star-removal trails, or **Average** with tight high-sigma
   clipping (`sigmaHigh = 1.1`) for small 4–12 frame stacks - producing a
   deep, clean comet image without star trails. A second **StarNet2** pass
   on the stacked image removes faint stars that were too dim to detect in
   single frames, and the raw nucleus core is blended back in case StarNet2
   softened it. This is saved as `CometStack_comet_starless.xisf`.
8. **ImageIntegration** also stacks all star-aligned frames into a deep star
   stack (falling back to the single reference frame if that fails), with the
   star layer faded out along the comet's path. **PixelMath** isolates the
   stars (`max(0, refStarsLayer - refStarlessLayer)`) and screen-blends them
   over the comet stack (`1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)`),
   producing `CometStack_final` with both sharp stars and a sharp, deep comet.
   The deep star stack is temporary and is deleted once the final image exists.

**Running it:** a dialog walks you through the workflow; the button for
whatever you should click next is highlighted green, cleared when a step starts
running, and once stacking completes, the **Close** button is highlighted green. A live
**Process Activity Log** shows step progress and warnings, and the
bottom bar provides **Stop Process**, **Close**, **Info / Process**, and
**Donate**.

1. **Select Calibration Folder (Optional)** - before or while preparing lights,
   point to the root calibration library folder if you want dark/flat/bias
   calibration.
2. **Select Light Frames Folder** - pick the folder containing your light
   frames (at least 3). If a calibration library was selected,
   matching frames are calibrated into `0_calibrated/`; then every frame is
   debayered (`1_debayer/`), star-aligned (`2_aligned/`), sorted
   chronologically, and scanned for time gaps and shift/reframe jumps.
3. **Mark Nucleus on Anchors and Run** - opens the embedded picker on each
   required anchor frame (first, last, and any gap/shift boundary frames): click
   roughly on the comet to zoom in, then drag a small box around the nucleus
   (releasing confirms it via a brightness-weighted centroid, so the drag doesn't
   need to be pixel-perfect). A tap without dragging while zoomed in goes
   back to the overview, and closing the picker cancels the step.
   Once all anchors are confirmed, stacking runs automatically through
   piecewise interpolation and local centroid refinement, `CometAlignment`,
   `StarNet2`, `ImageIntegration` (median default, or tight-clipped average
   for 4–12 frames), star isolation, screen blending, AutoSTF
   preview stretch, and saving the two output files described below. The
   intermediate `cometStackLayer` window is closed automatically once
   `CometStack_final` is created.

**Output files:** everything is written to `CometStack_work/` next to your
lights. A finished run leaves exactly two images there:

| File | Contents |
|---|---|
| `CometStack_final.xisf` | The finished image: sharp comet **and** sharp stars. |
| `CometStack_comet_starless.xisf` | The comet alone, with the stars removed - useful for processing the comet and tail separately. |

The numbered subfolders (`0_calibrated/`, `1_debayer/`, `2_aligned/`,
`3_comet_aligned/`, `4_starless/`) hold the per-frame working files. The
first three let a re-run on the same folder skip calibration, debayering and
alignment; the last two are rebuilt on every run. All of them can be deleted
once you are happy with the result. `CometStack_comet_starless.xisf` is saved as soon as the comet is
stacked, so if a later step fails, the comet stack is not lost. Files left by
older versions of the script (`CometStack_cometStack.xisf`,
`CometStack_cometStack_clean.xisf`, `CometStack_starStack.xisf`) are removed
automatically at the end of a successful run.

**Optional calibration frames:** click **Select Calibration Folder (Optional)...**
and point to the **root folder** containing subfolders named **`dark`**,
**`flat`**, and/or **`bias`** (exact lowercase singular names - e.g.
`CalibLibrary/dark/`, `CalibLibrary/flat/`, `CalibLibrary/bias/`, not
`Darks`/`Flats`/`Biases`). Subfolders inside those directories are
allowed (such as camera subdirectories like `cam_0` / `cam_1` or `IR`
folders, matching DWARF-series library layouts). The folder is
scanned recursively, and metadata is parsed from filenames (including DWARF
master naming conventions) or read from FITS/XISF headers. Frames are
matched on camera, gain, and binning (plus exposure time and detector
temperature for darks; ambiguous multi-IR master flats are skipped).
Any frame type without a clean match is skipped rather than guessed at.

**Notes and caveats:**
- **StarNet2 runtime & progress log:** Removing stars with StarNet2 can take a
  very long time depending on your computer's speed, GPU/CPU setup, and image
  size. The script logs a note when StarNet2 starts and updates both
  the status line and log with rolling average frame duration and estimated
  time remaining after each frame finishes. It also calls
  `processEvents()` and `gc()` between frames to help keep long batch runs
  stable.
- **Nucleus over-removal check:** StarNet2 can soften a compact nucleus—the
  script checks peak brightness around the nucleus before and after StarNet2
  and logs a warning if it drops below 40% of its original brightness.
- **Resumable prep steps:** Re-running light preparation on the same folder
  reuses already-completed calibration, debayer, and alignment outputs when
  counts match.
- **GNOME/Mutter window dragging:** If the dialog is stuck in the center of
  the screen and won't drag, this is a GNOME/Mutter setting, not a bug:
  `Dialog.execute()` produces an independent top-level window, but GNOME's
  default `attach-modal-dialogs` behavior locks modal dialogs to their parent.
  Fix with `gsettings set org.gnome.mutter attach-modal-dialogs false` (revert
  any time with `... true`).

**Requirements:** PixInsight with `AutomaticBackgroundExtractor`,
`Debayer`, `StarAlignment`, `CometAlignment`, `StarNet2`, `ImageIntegration`,
`PixelMath`, and (if using calibration) `ImageCalibration` installed;
at least 3 light frames from an OSC/color camera (`.fits`, `.fit`, or
`.xisf`) with valid `DATE-OBS` timestamps in their headers.
