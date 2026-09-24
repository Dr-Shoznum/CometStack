# CometStack for PixInsight

PixInsight script for stacking comets

- **Comet Stacking** (`CometStack.js`) - comet stacking for OSC camera data,
  producing sharp stars *and* a sharp, deep comet in one output image.

## Installation

Copy `CometStack.js` into your PixInsight
scripts folder (or use **Script Editor → File → Install Script Feature** on
each one), then restart PixInsight. It will appear under
**Script → CometStack**.

## Comet Stacking

`CometStack.js`

Stacks comet images from an OSC camera in one guided run: sharp, round
stars and a clean, deep comet in a single output image - without the usual
multi-tool, multi-pass manual workflow.

Comets move relative to the background stars over the course of an imaging
session. Stack a sequence normally and you get either trailed stars (if you
track the comet) or a smeared comet (if you track the stars) - never both
sharp at once. This script produces both by building two separate stacks
internally and combining them:

1. **Debayer** every light frame (raw OSC/Bayer data → RGB).
2. **Optionally calibrate** each light against matching dark/flat/bias
   frames, if you point it at a calibration library.
3. **StarAlignment** - register every frame to a common star-fixed
   reference.
4. **Mark the comet's nucleus** in the first and last frame, using a picker
   built into the dialog - no other PixInsight window ever needs focus.
5. **CometAlignment** - using those two positions and each frame's
   acquisition time, linearly interpolates the comet's position in every
   frame and re-registers the whole sequence so the comet is stationary
   (stars now trail, but that's fixed in the next step).
6. **StarNet2** removes the stars from every comet-aligned frame.
7. **ImageIntegration** stacks the starless, comet-aligned frames into one
   deep, clean comet image - no star trails to deal with, because the stars
   were already removed before stacking.
8. **PixelMath** combines that comet stack with the *original* stars from
   the star-aligned reference frame (`max(stars, cometStack)`), producing a
   final image with both sharp stars and a sharp, deep comet.

**Running it:** a small dialog walks you through three steps; the button
for whatever you should click next is always highlighted green.

1. **Select light frames folder** - pick the folder with your light frames.
   If a calibration library was selected, matching frames are applied
   automatically; then every frame is debayered and star-aligned.
2. **Mark nucleus (first, then last frame)** - one click opens a
   self-contained picker, twice in a row: click roughly on the comet to
   zoom in, then drag a small box precisely around the nucleus (releasing
   confirms it and moves on - the position is the brightness centroid of
   whatever you boxed, so the drag doesn't need to be pixel-perfect). A tap
   without dragging while zoomed in goes back to the full frame to re-pick.
   Close the picker window to cancel and redo this step. The view uses
   PixInsight's own standard auto-STF, no manual brightness adjustment
   needed.
3. **Run Comet Stack** - runs the rest of the pipeline (CometAlignment,
   StarNet2, integration, and the final combine) with no further input
   needed. The result is saved as `CometStack_final.xisf` in a
   `CometStack_work` subfolder next to your lights, and opened as a new
   image window.

**Optional calibration frames:** before step 1, click **"(Optional) Select
calibration frames folder..."** and point it at a folder containing
dark/flat/bias frames (subfolders named `dark`, `flat`, `bias`, optionally
further split by camera - matching how DWARF-series telescopes organize
their calibration library). The folder is scanned recursively, and each
file's metadata is read from its FITS header or, for master frames with
stripped headers, parsed from its filename (DWARF naming convention, e.g.
`dark_exp_15.000000_gain_60_bin_1_20C_stack_17.fits`). Each light's own
camera, gain, binning, exposure time, and sensor temperature are used to
find the best-matching dark/bias/flat; anything that doesn't match cleanly
is simply skipped rather than guessed at - calibration is entirely optional
and self-selecting.

**Notes and caveats:**
- StarNet2 can soften a very compact, star-like nucleus - the script checks
  each frame's nucleus brightness before and after star removal and warns
  you in the final status message if it dropped by more than 60%.
- Re-running step 1 on the same folder reuses previously-computed
  calibration/debayer/alignment output instead of redoing it, so it's safe
  to stop and resume.
- If the dialog is stuck in the center of the screen and won't drag, this
  is a GNOME/Mutter setting, not a bug: `Dialog.execute()` produces a
  genuine, independent top-level window, but GNOME's default
  `attach-modal-dialogs` behavior locks modal dialogs to their parent. Fix
  with `gsettings set org.gnome.mutter attach-modal-dialogs false` (revert
  any time with `... true`).

**Requirements:** PixInsight 1.9.x with `Debayer`, `StarAlignment`,
`CometAlignment`, `StarNet2`, `ImageIntegration`, `PixelMath`, and (if using
calibration) `ImageCalibration` installed; light frames from an OSC/color
camera (FITS or XISF) with valid `DATE-OBS` and `BAYERPAT` header keywords;
at least 3 light frames (more = a deeper, cleaner comet stack).
