#feature-id CometStack > CometStack
#feature-icon CometStack.svg
#include <pjsr/DataType.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/TextAlign.jsh>

/*
 * CometStack - one-shot comet stacking for OSC (color) cameras.
 *
 * Tested on DWARF mini as well as Askar 200mm f/4 + ZWO ASI2600MC Duo.
 *
 * Workflow: Debayer -> StarAlignment -> sort by DATE-OBS -> detect time gaps
 * and sudden reframes/shifts -> mark nucleus on anchor frames (first, last,
 * and across gaps or big shifts) -> piecewise JD interpolation + local
 * centroid refinement -> CometAlignment -> StarNet2 -> ImageIntegration ->
 * stars-only isolation and screen blend with the comet stack.
 *
 * Real bugs found and worked around while building this against actual
 * DWARF mini + real comet data:
 *
 * 1. CometAlignment's own linear interpolation for non-fixed frames produces
 *    NaN positions (verified: reproducible even on clean synthetic data with
 *    as few as 3 frames). Workaround: compute piecewise interpolation by
 *    Julian Date (with local centroid refinement) and pass every frame as
 *    "fixed" with an explicit position, so CometAlignment's broken
 *    interpolation path is never used.
 * 2. Batch-processing many images through StarNet2 in a tight open/close
 *    loop can segfault the whole application. Workaround: call
 *    processEvents() and gc() between iterations.
 * 3. Marking the nucleus by asking the user to drag a native PixInsight
 *    preview on a separate image window was unreliable in practice (window
 *    management got in the way). Replaced with a picker embedded directly
 *    in this dialog: click roughly on the overview, then drag a small
 *    precise box on a magnified crop - no other window ever needs focus.
 */

var GAP_MINUTES = 45;
var SHIFT_JUMP_THRESHOLD = 80; // pixels between consecutive star-aligned frames
var EXTREME_SHIFT_THRESHOLD = 250; // pixels threshold for logging a large-shift warning
var LOCAL_SEARCH_RADIUS = 35;
var ANCHOR_REFINE_RADIUS = 20;   // snap radius when re-centering the user's anchor clicks
var REFINE_GAUSS_SIGMA = 8;      // px, Gaussian window of the iterative centroid
var REFINE_CAP_SIGMA = 25;       // per-pixel excess is clipped at this many noise sigmas
var REFINE_MIN_PEAK_SIGMA = 5;   // required smoothed peak above background, in noise sigmas
var RESTORE_RAW_NUCLEUS = true;    // after the stack-level StarNet2 pass, put the raw nucleus core back
var NUCLEUS_RESTORE_INNER = 10;    // px: raw pixels restored 100% inside this radius
var NUCLEUS_RESTORE_OUTER = 30;    // px: soft (cosine) fade back to the cleaned stack at this radius
var DEEP_STAR_LAYER = true;        // star layer from ALL star-aligned frames instead of a single frame
var STAR_MASK_INNER = 20;          // px: no deep-stack stars within this distance of the comet's path
var STAR_MASK_OUTER = 40;          // px: cosine fade back to full star layer at this distance
var STARNET_ON_COMET_STACK = true; // 2nd StarNet2 pass on the integrated stack (removes faint stars missed per frame)
var TRAJECTORY_OUTLIER_PX = 6;   // refined position vs. neighbour-median correction
var DONATE_URL = "https://paypal.me/dpmilevski";

// ---- UI & error helpers ----------------------------------------------------

function pad2(n) {
   return (n < 10 ? "0" : "") + n;
}

function formatDuration(seconds) {
   let total = Math.max(0, Math.round(seconds));
   if (total < 60) return total + "s";
   let mins = Math.floor(total / 60);
   let secs = total % 60;
   return mins + "m " + secs + "s";
}

function setHighlight(button, on) {
   button.styleSheet = on
      ? "QPushButton { background-color: #2e7d32; color: #ffffff; font-weight: bold; padding: 6px 10px; border-radius: 3px; }"
      : "QPushButton { padding: 6px 10px; }";
}

function setStopHighlight(button, enabled) {
   button.styleSheet = enabled
      ? "QPushButton { background-color: #c62828; color: #ffffff; font-weight: bold; padding: 6px 10px; border-radius: 3px; }"
      : "QPushButton { padding: 6px 10px; }";
}

function setDonateStyle(button) {
   button.styleSheet = "QPushButton { background-color: #0070ba; color: #ffffff; font-weight: bold; padding: 6px 10px; border-radius: 3px; }";
}

function openPayPalOnUbuntu(url, logFn) {
   if (typeof ExternalProcess !== "function") {
      if (logFn) logFn("ExternalProcess is not available in this PixInsight runtime.");
      return false;
   }

   let attempts = [
      ["/usr/bin/firefox", [url]],
      ["firefox", [url]],
      ["/usr/bin/xdg-open", [url]],
      ["xdg-open", [url]]
   ];

   for (let i = 0; i < attempts.length; ++i) {
      let prog = attempts[i][0];
      let args = attempts[i][1];
      try {
         let proc = new ExternalProcess;
         proc.start(prog, args);
         if (typeof proc.waitForStarted === "function") {
            if (proc.waitForStarted(3000)) {
               if (logFn) logFn("Started " + prog + " for " + url);
               return true;
            }
            if (logFn) logFn("Timed out waiting for " + prog + " to start.");
         } else {
            if (logFn) logFn("Invoked " + prog + " for " + url);
            return true;
         }
      } catch (e) {
         if (logFn) logFn("Failed via " + prog + ": " + e.message);
      }
   }
   return false;
}

function copyTextToClipboard(text, logFn) {
   try {
      if (typeof Clipboard !== "undefined") {
         if (typeof Clipboard.setText === "function") {
            Clipboard.setText(text);
            if (logFn) logFn("Copied link to clipboard: " + text);
            return true;
         }
         if ("text" in Clipboard) {
            Clipboard.text = text;
            if (logFn) logFn("Copied link to clipboard: " + text);
            return true;
         }
         let cb = new Clipboard;
         if (typeof cb.setText === "function") {
            cb.setText(text);
            if (logFn) logFn("Copied link to clipboard: " + text);
            return true;
         }
         if ("text" in cb) {
            cb.text = text;
            if (logFn) logFn("Copied link to clipboard: " + text);
            return true;
         }
      }
   } catch (e) {
      if (logFn) logFn("Clipboard copy note: " + e.message);
   }
   return false;
}

function showDonateFallbackDialog(url, parentDlg, logFn) {
   let copied = copyTextToClipboard(url, logFn);

   let dlg = new Dialog(parentDlg);
   dlg.windowTitle = "Donate to CometStack";
   dlg.minWidth = 420;

   let titleLbl = new Label(dlg);
   titleLbl.text = "Support CometStack Development";
   titleLbl.styleSheet = "font-size: 12pt; font-weight: bold;";

   let descLbl = new Label(dlg);
   descLbl.text = "Could not open Firefox automatically. Use the link below to open PayPal:";
   descLbl.wordWrapping = true;

   let linkBox = new Edit(dlg);
   linkBox.text = url;
   linkBox.readOnly = true;
   linkBox.styleSheet = "font-family: monospace; font-size: 10pt; padding: 4px;";

   let statusLbl = new Label(dlg);
   statusLbl.text = copied
      ? "Link copied to clipboard — paste into Firefox or your PayPal app."
      : "Select the link above and press Ctrl+C to copy.";
   statusLbl.styleSheet = copied ? "color: #2e7d32; font-weight: bold;" : "color: #666666;";

   let copyBtn = new PushButton(dlg);
   copyBtn.text = "Copy Link";
   copyBtn.onClick = function() {
      let ok = copyTextToClipboard(url, logFn);
      statusLbl.text = ok
         ? "Link copied to clipboard — paste into Firefox or your PayPal app."
         : "Please select the link above and copy manually (Ctrl+C).";
      statusLbl.styleSheet = ok ? "color: #2e7d32; font-weight: bold;" : "color: #666666;";
   };

   let closeBtn = new PushButton(dlg);
   closeBtn.text = "Close";
   closeBtn.onClick = function() {
      dlg.ok();
   };

   let btnSizer = new HorizontalSizer;
   btnSizer.spacing = 8;
   btnSizer.add(copyBtn);
   btnSizer.addStretch();
   btnSizer.add(closeBtn);

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 12;
   dlg.sizer.spacing = 8;
   dlg.sizer.add(titleLbl);
   dlg.sizer.add(descLbl);
   dlg.sizer.add(linkBox);
   dlg.sizer.add(statusLbl);
   dlg.sizer.add(btnSizer);
   dlg.adjustToContents();
   dlg.execute();
}

function openExternalUrl(url, parentDlg, logFn) {
   if (openPayPalOnUbuntu(url, logFn)) {
      return true;
   }
   showDonateFallbackDialog(url, parentDlg, logFn);
   return false;
}

function createCometIconBitmap(size) {
   let dim = size || 22;
   let bmp = new Bitmap(dim, dim);
   let g = new Graphics(bmp);

   g.fillRect(0, 0, dim, dim, new Brush(0x00000000));

   let headX = dim * 0.68;
   let headY = dim * 0.32;

   g.pen = new Pen(0x9090a4ae, Math.max(1, dim * 0.06));
   g.drawLine(headX, headY, dim * 0.32, dim * 0.86);

   g.pen = new Pen(0xe0cfd8dc, Math.max(1.5, dim * 0.11));
   g.drawLine(headX, headY, dim * 0.15, dim * 0.82);

   g.pen = new Pen(0xffffffff, 1);
   g.brush = new Brush(0xb3e0f7fa);
   g.drawCircle(headX, headY, dim * 0.17);

   g.pen = new Pen(0xffffffff, 1);
   g.brush = new Brush(0xffffffff);
   g.drawCircle(headX, headY, dim * 0.08);

   g.end();
   return bmp;
}

function UserStoppedError(msg) {
   this.name = "UserStoppedError";
   this.message = msg || "Process stopped by user.";
   this.stack = (new Error()).stack;
}
UserStoppedError.prototype = Object.create(Error.prototype);
UserStoppedError.prototype.constructor = UserStoppedError;

function showErrorDialog(title, err, logFn) {
   let msg = (err && err.message) ? err.message : String(err);
   let detail = (err && err.stack) ? ("\n\nDetails:\n" + err.stack) : "";
   if (logFn) logFn("ERROR [" + title + "]: " + msg);
   let mb = new MessageBox(
      msg + detail,
      "CometStack — " + title,
      StdIcon_Error,
      StdButton_Ok
   );
   mb.execute();
}

function showInfoDialog(parent) {
   let infoDlg = new Dialog(parent);
   infoDlg.windowTitle = "CometStack — Requirements & Process Guide";
   infoDlg.minWidth = 620;
   infoDlg.minHeight = 460;

   let titleLbl = new Label(infoDlg);
   titleLbl.text = "OSC Comet Stacking — Setup & Process Rundown";
   titleLbl.styleSheet = "font-size: 12pt; font-weight: bold;";

let readmeText =
      "by Petar Milevski (2026)  •  Automated post-nucleus stack & screen blend\n" +
      "============================================================\n\n" +
      "WHAT YOU NEED IN PIXINSIGHT\n" +
      "------------------------------------------------------------\n" +
      "• StarNet2 module installed and configured in PixInsight (required\n" +
      "  both to strip stars from comet-aligned frames and to isolate stars\n" +
      "  from the reference frame).\n" +
      "• Standard PixInsight core/modules: AutomaticBackgroundExtractor,\n" +
      "  ImageCalibration, Debayer, StarAlignment, CometAlignment,\n" +
      "  ImageIntegration, and PixelMath.\n" +
      "• At least 3 OSC (color) light frames (.fits, .fit, or .xisf) with\n" +
      "  valid DATE-OBS timestamps in their headers.\n" +
      "• Optional calibration folder: point to the ROOT folder containing\n" +
      "  subfolders named 'dark', 'flat', and/or 'bias' (exact lowercase\n" +
      "  singular names — e.g. CalibLibrary/dark/, CalibLibrary/flat/,\n" +
      "  CalibLibrary/bias/, not 'Darks'/'Flats'/'Biases'). Subfolders\n" +
      "  inside those are allowed. Frames are matched by camera, gain,\n" +
      "  binning, exposure, and detector temperature (with master flats\n" +
      "  skipped if multiple IR modes are ambiguous).\n\n" +
      "HOW THE STACKING PROCESS WORKS\n" +
      "------------------------------------------------------------\n" +
      "1. Calibration (Optional): Matches dark, flat, and bias frames to your\n" +
      "   light metadata and runs ImageCalibration into 0_calibrated/.\n" +
      "2. Debayer, StarAlignment & Jump Detection: Converts OSC frames to\n" +
      "   color (_d.xisf), aligns stars to the first frame (_r.xisf), sorts\n" +
      "   frames chronologically by Julian Date (DATE-OBS), flags time\n" +
      "   gaps (> " + GAP_MINUTES + " min) or frame-to-frame shifts (> " + SHIFT_JUMP_THRESHOLD + " px), and\n" +
      "   logs warnings listing images with large shifts (> " + EXTREME_SHIFT_THRESHOLD + " px)\n" +
      "   without automatically rejecting them.\n" +
      "3. Anchor Nucleus Marking: Opens the embedded zoom + box picker\n" +
      "   (with AutomaticBackgroundExtractor + screen stretch) on the first\n" +
      "   frame, last frame, and frames bordering any detected time gap or\n" +
      "   large shift, refining each pick with a brightness-weighted centroid.\n" +
      "4. Piecewise Interpolation & Local Refinement: Interpolates nucleus\n" +
      "   positions linearly by Julian Date between anchors, refines each\n" +
      "   intermediate frame within a ±" + LOCAL_SEARCH_RADIUS + " px local search box using a\n" +
      "   background-subtracted centroid (falling back to the interpolated\n" +
      "   position if signal is weak), and passes every frame as 'fixed' to\n" +
      "   CometAlignment (_ca.xisf) to avoid PixInsight's broken built-in\n" +
      "   non-fixed interpolation.\n" +
      "5. Batch StarNet2 Removal: Runs StarNet2 on each comet-aligned frame\n" +
      "   (_sn.xisf), monitors nucleus peak brightness for over-removal\n" +
      "   warnings, and calls processEvents() + gc() between frames to\n" +
      "   prevent memory/stability crashes.\n" +
      "6. Starless Comet Integration: Integrates the starless comet frames\n" +
      "   into 'cometStackLayer' using median combination by default (or\n" +
      "   average with tight high-sigma clipping for 4–12 frame stacks)\n" +
      "   so the comet and tail stack cleanly without star-removal trails.\n" +
      "   One more StarNet2 pass on the integrated stack then removes faint\n" +
      "   stars that were too dim to detect in single frames (they would\n" +
      "   otherwise appear as short streaks along the comet's motion).\n" +
      "   The raw nucleus core is blended back afterwards, in case StarNet2\n" +
      "   treated the compact nucleus as a star.\n" +
      "7. Star Isolation & Screen Blend: All star-aligned frames are first\n" +
      "   integrated (average, Winsorized clipping) into a deep star stack,\n" +
      "   saved as CometStack_starStack.xisf. The stack is then used as the\n" +
      "   star source (if it cannot be built, the single star-aligned\n" +
      "   reference frame is used instead). Around the comet's path the star\n" +
      "   layer is faded out, because the comet is smeared in that stack.\n" +
      "   StarNet2 is run on a copy of the star source, and stars are isolated via:\n" +
      "      max(0, refStarsLayer - refStarlessLayer)\n" +
      "   and screen-blends them over the comet stack via:\n" +
      "      1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)\n" +
      "   Finally applies an AutoSTF preview stretch and saves\n" +
      "   CometStack_final.xisf in the working folder.";

   let docBox = new TextBox(infoDlg);
   docBox.readOnly = true;
   docBox.text = readmeText;
   docBox.setMinSize(580, 360);
   docBox.styleSheet = "font-family: monospace; font-size: 9pt;";

   let okBtn = new PushButton(infoDlg);
   okBtn.text = "Got It";
   okBtn.onClick = function() { infoDlg.ok(); };

   let btnSizer = new HorizontalSizer;
   btnSizer.addStretch();
   btnSizer.add(okBtn);

   infoDlg.sizer = new VerticalSizer;
   infoDlg.sizer.margin = 12;
   infoDlg.sizer.spacing = 8;
   infoDlg.sizer.add(titleLbl);
   infoDlg.sizer.add(docBox, 100);
   infoDlg.sizer.add(btnSizer);
   infoDlg.adjustToContents();
   infoDlg.execute();
}

// ---- Math / stats / file helpers -------------------------------------------

function toJD(isoStr) {
   if (!isoStr) throw new Error("Missing DATE-OBS metadata.");
   let m = isoStr.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d+(?:\.\d+)?)/);
   if (!m) throw new Error("Unrecognized DATE-OBS format: '" + isoStr + "'");
   let year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
   let hour = parseInt(m[4], 10), minute = parseInt(m[5], 10), second = parseFloat(m[6]);
   let a = Math.floor((14 - month) / 12);
   let y = year + 4800 - a;
   let mm = month + 12 * a - 3;
   let jdn = day + Math.floor((153 * mm + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
   return jdn + (hour - 12) / 24 + minute / 1440 + second / 86400;
}

function readDateObs(window) {
   for (let k = 0; k < window.keywords.length; ++k)
      if (window.keywords[k].name == "DATE-OBS")
         return window.keywords[k].value.toString().replace(/'/g, "").trim();
   return "";
}

function readDateObsFromFile(path) {
   let w = ImageWindow.open(path)[0];
   try {
      return readDateObs(w);
   } finally {
      w.forceClose();
   }
}

function listFiles(dir, regex) {
   let ff = new FileFind;
   let files = [];
   if (ff.begin(dir + "/*")) {
      do {
         if (!ff.isDirectory && (!regex || regex.test(ff.name)))
            files.push(dir + "/" + ff.name);
      } while (ff.next());
   }
   files.sort();
   return files;
}

function clearDirFiles(dir) {
   if (!File.directoryExists(dir)) return;
   let existing = listFiles(dir, null);
   for (let i = 0; i < existing.length; ++i) {
      if (File.exists(existing[i])) File.remove(existing[i]);
   }
}

// Force-closes any open windows whose main-view id is in ids (leftovers of an earlier run).
function closeWindowsById(ids) {
   let wins = ImageWindow.windows;
   for (let i = 0; i < wins.length; ++i)
      if (ids.indexOf(wins[i].mainView.id) >= 0)
         wins[i].forceClose();
}

function peakInRegion(view, cx, cy, halfsize) {
   let img = view.image;
   let x0 = Math.max(0, Math.min(img.width - 1, Math.round(cx - halfsize)));
   let y0 = Math.max(0, Math.min(img.height - 1, Math.round(cy - halfsize)));
   let x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(cx + halfsize)));
   let y1 = Math.max(y0 + 1, Math.min(img.height, Math.round(cy + halfsize)));
   let rect = new Rect(x0, y0, x1, y1);
   let n = img.numberOfChannels;
   let ww = rect.x1 - rect.x0, hh = rect.y1 - rect.y0;
   let acc = new Float64Array(ww * hh);
   let buf = new Float64Array(ww * hh);
   for (let ch = 0; ch < n; ++ch) {
      img.getSamples(buf, rect, ch);
      for (let i = 0; i < buf.length; ++i) acc[i] += buf[i];
   }
   let mx = -1;
   for (let i = 0; i < acc.length; ++i) if (acc[i] > mx) mx = acc[i];
   return mx;
}

// Brightness centroid of a native image rectangle (sum of all channels;
// the comet coma is a diffuse feature, so a simple weighted centroid over a
// generously-sized user-marked box is more robust than trying to fit a PSF).
function weightedCentroidNative(image, rect) {
   let n = image.numberOfChannels;
   let ww = rect.x1 - rect.x0, hh = rect.y1 - rect.y0;
   let acc = new Float64Array(ww * hh);
   let buf = new Float64Array(ww * hh);
   for (let ch = 0; ch < n; ++ch) {
      image.getSamples(buf, rect, ch);
      for (let i = 0; i < buf.length; ++i) acc[i] += buf[i];
   }
   let minV = acc.length > 0 ? acc[0] : 0;
   for (let i = 1; i < acc.length; ++i) if (acc[i] < minV) minV = acc[i];
   let sumW = 0, sumX = 0, sumY = 0;
   for (let yy = 0; yy < hh; ++yy) {
      for (let xx = 0; xx < ww; ++xx) {
         let v = acc[yy * ww + xx] - minV;
         sumW += v; sumX += v * (rect.x0 + xx); sumY += v * (rect.y0 + yy);
      }
   }
   if (sumW <= 0) return [(rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2];
   return [sumX / sumW, sumY / sumW];
}

// Measures the active (non-zero) bounding box of a star-aligned frame so
// sudden reframes or large alignment shifts can be detected between frames.
function measureActiveBounds(filePath) {
   let w = ImageWindow.open(filePath)[0];
   try {
      let img = w.mainView.image;
      let step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 300));
      let minX = img.width, maxX = -1, minY = img.height, maxY = -1;
      let rowBuf = new Float32Array(img.width);

      for (let y = 0; y < img.height; y += step) {
         img.getSamples(rowBuf, new Rect(0, y, img.width, y + 1), 0);
         for (let x = 0; x < img.width; x += step) {
            if (rowBuf[x] > 0) {
               if (x < minX) minX = x;
               if (x > maxX) maxX = x;
               if (y < minY) minY = y;
               if (y > maxY) maxY = y;
            }
         }
      }

      if (maxX < minX || maxY < minY) {
         return { cx: img.width / 2, cy: img.height / 2, w: img.width, h: img.height };
      }
      return {
         cx: (minX + maxX) / 2,
         cy: (minY + maxY) / 2,
         w: maxX - minX,
         h: maxY - minY
      };
   } finally {
      w.forceClose();
   }
}

// Local centroid refinement around a prediction (predX, predY). Used for BOTH the
// user-marked anchors and the interpolated intermediate frames, so every position
// in the trajectory comes from the same estimator.
//  - background = window median, noise = 1.4826*MAD of the window (robust to coma/stars)
//  - needs a clear (3x3-smoothed) peak above the background, else falls back
//  - iterative Gaussian-windowed centroid starting at the prediction; per-pixel
//    excess is clipped at REFINE_CAP_SIGMA*noise so bright stars cannot dominate
//    the extended coma
//  - falls back to the prediction if the result drifts too far from it
function refineNucleusLocally(filePath, predX, predY, radius) {
   let w = ImageWindow.open(filePath)[0];
   try {
      let img = w.mainView.image;
      let r = radius || LOCAL_SEARCH_RADIUS;
      let x0 = Math.max(0, Math.min(img.width - 2, Math.floor(predX - r)));
      let y0 = Math.max(0, Math.min(img.height - 2, Math.floor(predY - r)));
      let x1 = Math.max(x0 + 2, Math.min(img.width, Math.ceil(predX + r)));
      let y1 = Math.max(y0 + 2, Math.min(img.height, Math.ceil(predY + r)));
      let rect = new Rect(x0, y0, x1, y1);
      let ww = rect.x1 - rect.x0, hh = rect.y1 - rect.y0;
      let n = img.numberOfChannels;
      let unrefined = { pos: [predX, predY], refined: false };

      let acc = new Float64Array(ww * hh);
      let buf = new Float64Array(ww * hh);
      for (let ch = 0; ch < n; ++ch) {
         img.getSamples(buf, rect, ch);
         for (let i = 0; i < buf.length; ++i) acc[i] += buf[i];
      }

      let byValue = function(a, b) { return a - b; };
      let sorted = Array.prototype.slice.call(acc).sort(byValue);
      let bkg = sorted[Math.floor(sorted.length * 0.5)];
      let absDev = new Array(acc.length);
      for (let i = 0; i < acc.length; ++i) absDev[i] = Math.abs(acc[i] - bkg);
      absDev.sort(byValue);
      let sigma = Math.max(1e-9, 1.4826 * absDev[Math.floor(absDev.length * 0.5)]);

      // Require a clear peak (3x3 box-smoothed, so a single hot pixel does not count).
      let smPeak = -Infinity;
      for (let yy = 1; yy < hh - 1; ++yy) {
         for (let xx = 1; xx < ww - 1; ++xx) {
            let sum = 0;
            for (let dy = -1; dy <= 1; ++dy)
               for (let dx = -1; dx <= 1; ++dx)
                  sum += acc[(yy + dy) * ww + (xx + dx)];
            let m = sum / 9;
            if (m > smPeak) smPeak = m;
         }
      }
      if (!(smPeak - bkg >= REFINE_MIN_PEAK_SIGMA * sigma)) return unrefined;

      let cap = REFINE_CAP_SIGMA * sigma;
      let twoS2 = 2 * REFINE_GAUSS_SIGMA * REFINE_GAUSS_SIGMA;
      let cx = predX, cy = predY;
      for (let it = 0; it < 10; ++it) {
         let sumW = 0, sumX = 0, sumY = 0;
         for (let yy = 0; yy < hh; ++yy) {
            for (let xx = 0; xx < ww; ++xx) {
               let excess = acc[yy * ww + xx] - bkg;
               if (excess <= 0) continue;
               if (excess > cap) excess = cap;
               let px = rect.x0 + xx, py = rect.y0 + yy;
               let ddx = px - cx, ddy = py - cy;
               let weight = excess * Math.exp(-(ddx * ddx + ddy * ddy) / twoS2);
               sumW += weight; sumX += weight * px; sumY += weight * py;
            }
         }
         if (sumW <= 0) return unrefined;
         let nx = sumX / sumW, ny = sumY / sumW;
         let moved = Math.sqrt((nx - cx) * (nx - cx) + (ny - cy) * (ny - cy));
         cx = nx; cy = ny;
         if (moved < 0.05) break;
      }

      let dist = Math.sqrt((cx - predX) * (cx - predX) + (cy - predY) * (cy - predY));
      if (dist > r * 0.75) return unrefined;
      return { pos: [cx, cy], refined: true };
   } finally {
      w.forceClose();
   }
}

// PixInsight's standard screen-stretch algorithm, so previews look natural.
function MTF(m, x) {
   if (x <= 0) return 0;
   if (x >= 1) return 1;
   if (x == m) return 0.5;
   return ((m - 1) * x) / (((2 * m - 1) * x) - m);
}

function applyAutoSTF(view, sclip, tbgnd) {
   let n = view.image.isColor ? 3 : 1;
   let median = view.computeOrFetchProperty("Median");
   let mad = view.computeOrFetchProperty("MAD");
   mad.mul(1.4826);
   let stf = [[0.5,0,1,0,1],[0.5,0,1,0,1],[0.5,0,1,0,1],[0.5,0,1,0,1]];
   for (let c = 0; c < n; ++c) {
      let m0 = median.at(c), d0 = mad.at(c), c0, c1, m;
      if (m0 < 0.5) {
         c0 = Math.min(1, Math.max(0, m0 - sclip * d0));
         m = (c0 == 1) ? 0.0001 : MTF(tbgnd, m0 - c0);
         c1 = 1;
      } else {
         c1 = Math.min(1, Math.max(0, m0 + sclip * d0));
         m = (c1 == 0) ? 0.9999 : 1 - MTF(tbgnd, c1 - m0);
         c0 = 0;
      }
      stf[c] = [m, c0, c1, 0, 1];
   }
   if (n == 1) { stf[1] = stf[0]; stf[2] = stf[0]; }
   view.stf = stf;
}

function computeChannelStats(image, n) {
   let fullRect = new Rect(0, 0, image.width, image.height);
   let SHADOWS_CLIP = 2.8;
   let sumMedian = 0, sumC0 = 0;
   for (let c = 0; c < n; ++c) {
      let m0 = image.median(fullRect, c, c);
      let d0 = image.MAD(m0, fullRect, c, c) * 1.4826;
      sumMedian += m0;
      sumC0 += m0 - SHADOWS_CLIP * d0;
   }
   return [sumMedian / n, sumC0 / n];
}

function finalizeStretch(stats, targetBkg) {
   let avgMedian = stats[0], c0 = Math.min(1, Math.max(0, stats[1]));
   let m = (c0 >= 1) ? 0.0001 : MTF(targetBkg, avgMedian - c0);
   return [m, c0, 1];
}

// ---- Nucleus picker rendering ----------------------------------------------

function prepareOverviewData(image, maxW, maxH) {
   let n = image.numberOfChannels;
   // Fit BOTH dimensions into the picker view (4:3 and squarer frames used to overflow the height).
   let scale = Math.min(1, maxW / image.width, maxH / image.height);
   let outW = Math.max(1, Math.round(image.width * scale));
   let outH = Math.max(1, Math.round(image.height * scale));
   let block = Math.max(1, Math.round(1 / scale));
   let channels = [];
   for (let c = 0; c < n; ++c) {
      let full = new Float32Array(image.width * image.height);
      image.getSamples(full, new Rect(0, 0, image.width, image.height), c);
      let out = new Float32Array(outW * outH);
      for (let yy = 0; yy < outH; ++yy) {
         let sy0 = Math.min(image.height - 1, Math.round(yy / scale));
         let sy1 = Math.min(image.height, sy0 + block);
         for (let xx = 0; xx < outW; ++xx) {
            let sx0 = Math.min(image.width - 1, Math.round(xx / scale));
            let sx1 = Math.min(image.width, sx0 + block);
            let sum = 0, cnt = 0;
            for (let sy = sy0; sy < sy1; ++sy)
               for (let sx = sx0; sx < sx1; ++sx) { sum += full[sy * image.width + sx]; ++cnt; }
            out[yy * outW + xx] = sum / cnt;
         }
      }
      channels.push(out);
   }
   return { channels: channels, n: n, outW: outW, outH: outH, scale: scale };
}

function prepareZoomData(image, cx, cy, halfSize, zoomFactor) {
   let n = image.numberOfChannels;
   let cropW = Math.min(image.width, 2 * halfSize);
   let cropH = Math.min(image.height, 2 * halfSize);
   let x0 = Math.round(cx - cropW / 2), y0 = Math.round(cy - cropH / 2);
   x0 = Math.max(0, Math.min(image.width - cropW, x0));
   y0 = Math.max(0, Math.min(image.height - cropH, y0));
   let cropRect = new Rect(x0, y0, x0 + cropW, y0 + cropH);
   let outW = cropW * zoomFactor, outH = cropH * zoomFactor;
   let channels = [];
   for (let c = 0; c < n; ++c) {
      let buf = new Float32Array(cropW * cropH);
      image.getSamples(buf, cropRect, c);
      let magnified = new Float32Array(outW * outH);
      for (let yy = 0; yy < outH; ++yy) {
         let sy = Math.min(cropH - 1, Math.floor(yy / zoomFactor));
         for (let xx = 0; xx < outW; ++xx) {
            let sx = Math.min(cropW - 1, Math.floor(xx / zoomFactor));
            magnified[yy * outW + xx] = buf[sy * cropW + sx];
         }
      }
      channels.push(magnified);
   }
   return { channels: channels, n: n, outW: outW, outH: outH, cropW: cropW, cropH: cropH, x0: x0, y0: y0, zoomFactor: zoomFactor };
}

function renderFromPrepared(prepared, stretch) {
   let small = new Image(prepared.outW, prepared.outH, prepared.n, prepared.n > 1 ? ColorSpace_RGB : ColorSpace_Gray);
   for (let c = 0; c < prepared.n; ++c)
      small.setSamples(prepared.channels[c], new Rect(0, 0, prepared.outW, prepared.outH), c);

   let tmpWin = new ImageWindow(prepared.outW, prepared.outH, prepared.n, 32, true, prepared.n > 1, "cometPickerTmp");
   tmpWin.mainView.beginProcess();
   tmpWin.mainView.image.assign(small);
   tmpWin.mainView.endProcess();

   // RGB/K row (index 3) and alpha row (index 4) stay identity so
   // HistogramTransformation does not double-apply the curve.
   let hEntry = [stretch[1], stretch[0], stretch[2], 0, 1];
   let identity = [0, 0.5, 1, 0, 1];
   let H = prepared.n > 1 ? [hEntry, hEntry, hEntry, identity, identity]
                           : [hEntry, hEntry, hEntry, hEntry, identity];
   let P = new HistogramTransformation;
   P.H = H;
   P.executeOn(tmpWin.mainView);

   let bitmap = tmpWin.mainView.image.render();
   tmpWin.forceClose();

   let result = { bitmap: bitmap };
   if (prepared.scale !== undefined) result.scale = prepared.scale;
   if (prepared.x0 !== undefined) { result.x0 = prepared.x0; result.y0 = prepared.y0; result.zoomFactor = prepared.zoomFactor; }
   return result;
}

function closeNewAbeBackgroundWindows(beforeIds) {
   let wins = ImageWindow.windows;
   for (let i = 0; i < wins.length; ++i) {
      let id = wins[i].mainView.id;
      if (beforeIds.indexOf(id) < 0 && /_ABE_background$/i.test(id)) {
         wins[i].forceClose();
      }
   }
}

function runBackgroundExtraction(view) {
   let beforeIds = ImageWindow.windows.map(function(w) { return w.mainView.id; });
   let P = new AutomaticBackgroundExtractor;
   P.targetCorrection = 1; // Correction_Subtract
   P.replaceTarget = true;
   P.executeOn(view);
   closeNewAbeBackgroundWindows(beforeIds);
}

function pickNucleus(filePath, title, subtitle) {
   let w = ImageWindow.open(filePath)[0];
   runBackgroundExtraction(w.mainView);
   let img = w.mainView.image;
   let result = null;

   const VIEWW = 900, VIEWH = 640;
   const ZOOM_HALFSIZE = 100, ZOOM_FACTOR = 3; // 2*100*3 = 600 px, fits the 640 px view height
   const TAP_TOLERANCE = 6;

   let dlg = new Dialog;
   dlg.windowTitle = title;

   const TARGET_BKG = 0.25;
   let channelStats = computeChannelStats(img, img.numberOfChannels);
   let stretch = finalizeStretch(channelStats, TARGET_BKG);
   let state = { mode: "overview", overviewData: null, overview: null, zoomData: null, zoom: null, dragStart: null, dragCur: null };
   state.overviewData = prepareOverviewData(img, VIEWW, VIEWH);
   state.overview = renderFromPrepared(state.overviewData, stretch);

   const OVERVIEW_HINT = "Click roughly on the comet's nucleus to zoom in.";
   const ZOOM_HINT = "Drag a small box precisely around the nucleus to confirm.\nClick without dragging to go back.";

   let info = new Label(dlg);
   info.text = (subtitle ? subtitle + "\n" : "") + OVERVIEW_HINT;
   info.textAlignment = TextAlign_Center;
   info.wordWrapping = true;
   info.minHeight = 52;
   info.styleSheet = "QLabel { color: #d32f2f; font-size: 11pt; font-weight: bold; }";

   let view = new Control(dlg);
   view.setFixedSize(VIEWW, VIEWH);

   view.onPaint = function(x0, y0, x1, y1) {
      let g = new Graphics(this);
      g.fillRect(0, 0, VIEWW, VIEWH, new Brush(4278190080));
      if (state.mode == "overview") {
         g.drawBitmap(0, 0, state.overview.bitmap);
      } else if (state.zoom) {
         g.drawBitmap(0, 0, state.zoom.bitmap);
         if (state.dragStart && state.dragCur) {
            g.pen = new Pen(4294901760, 2);
            let rx0 = Math.min(state.dragStart.x, state.dragCur.x);
            let ry0 = Math.min(state.dragStart.y, state.dragCur.y);
            let rx1 = Math.max(state.dragStart.x, state.dragCur.x);
            let ry1 = Math.max(state.dragStart.y, state.dragCur.y);
            g.drawRect(rx0, ry0, rx1, ry1);
         }
      }
      g.end();
   };

   view.onMousePress = function(x, y, button, buttons, modifiers) {
      if (state.mode == "overview") {
         // Ignore clicks on the black margin outside the rendered overview.
         if (x >= state.overviewData.outW || y >= state.overviewData.outH) return true;
         let nx = x / state.overview.scale;
         let ny = y / state.overview.scale;
         state.zoomCx = nx; state.zoomCy = ny;
         state.zoomData = prepareZoomData(img, nx, ny, ZOOM_HALFSIZE, ZOOM_FACTOR);
         state.zoom = renderFromPrepared(state.zoomData, stretch);
         state.mode = "zoom";
         state.dragStart = null; state.dragCur = null;
         info.text = (subtitle ? subtitle + "\n" : "") + ZOOM_HINT;
      } else {
         state.dragStart = { x: x, y: y };
         state.dragCur = { x: x, y: y };
      }
      this.repaint();
      return true;
   };
   view.onMouseMove = function(x, y, buttons, modifiers) {
      if (state.mode == "zoom" && state.dragStart) {
         state.dragCur = { x: x, y: y };
         this.repaint();
      }
      return true;
   };
   view.onMouseRelease = function(x, y, button, buttons, modifiers) {
      if (state.mode == "zoom" && state.dragStart) {
         let rx0 = Math.min(state.dragStart.x, state.dragCur.x);
         let ry0 = Math.min(state.dragStart.y, state.dragCur.y);
         let rx1 = Math.max(state.dragStart.x, state.dragCur.x);
         let ry1 = Math.max(state.dragStart.y, state.dragCur.y);
         if (rx1 - rx0 >= TAP_TOLERANCE && ry1 - ry0 >= TAP_TOLERANCE) {
            let z = state.zoom;
            let nx0 = z.x0 + rx0 / z.zoomFactor, ny0 = z.y0 + ry0 / z.zoomFactor;
            let nx1 = z.x0 + rx1 / z.zoomFactor, ny1 = z.y0 + ry1 / z.zoomFactor;
            let rect = new Rect(Math.round(nx0), Math.round(ny0), Math.round(nx1), Math.round(ny1));
            result = weightedCentroidNative(img, rect);
            dlg.ok();
         } else {
            state.mode = "overview";
            state.dragStart = null; state.dragCur = null;
            info.text = (subtitle ? subtitle + "\n" : "") + OVERVIEW_HINT;
            this.repaint();
         }
      }
      return true;
   };

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 10;
   dlg.sizer.spacing = 8;
   dlg.sizer.add(info);
   dlg.sizer.add(view);
   dlg.adjustToContents();

   let ok = dlg.execute();
   w.forceClose();
   return (ok && result) ? result : null;
}

// ---- Calibration library scanning ------------------------------------------

function readFrameMeta(path) {
   let w = ImageWindow.open(path)[0];
   let meta = { camera: null, gain: null, bin: null, exptime: null, temp: null };
   try {
      // DWARF-style headers use CAMERA / DET-TEMP; ASI/ASIAIR/NINA-style headers use
      // INSTRUME and CCD-TEMP (or SET-TEMP). The first form found wins.
      let instrume = null, ccdTemp = null, setTemp = null, exposure = null;
      for (let k = 0; k < w.keywords.length; ++k) {
         let kw = w.keywords[k], v = kw.value.toString().replace(/'/g, "").trim();
         if (kw.name == "CAMERA") meta.camera = v;
         else if (kw.name == "INSTRUME") instrume = v;
         else if (kw.name == "GAIN") meta.gain = parseFloat(v);
         else if (kw.name == "XBINNING") meta.bin = parseInt(v, 10);
         else if (kw.name == "EXPTIME") meta.exptime = parseFloat(v);
         else if (kw.name == "EXPOSURE") exposure = parseFloat(v);
         else if (kw.name == "DET-TEMP") meta.temp = parseFloat(v);
         else if (kw.name == "CCD-TEMP") ccdTemp = parseFloat(v);
         else if (kw.name == "SET-TEMP") setTemp = parseFloat(v);
      }
      if (meta.camera == null) meta.camera = instrume;
      if (meta.exptime == null || isNaN(meta.exptime)) meta.exptime = exposure;
      if (meta.temp == null || isNaN(meta.temp)) meta.temp = (ccdTemp != null && !isNaN(ccdTemp)) ? ccdTemp : setTemp;
   } finally {
      w.forceClose();
   }
   return meta;
}

function classifyCalibFile(path, rootDir) {
   let rel = path.substring(rootDir.length).replace(/^[\/\\]+/, "");
   let topSeg = rel.split(/[\/\\]/)[0].toLowerCase();
   let kind = (topSeg == "dark" || topSeg == "flat" || topSeg == "bias") ? topSeg : null;
   if (!kind) return null;

   let camera = null;
   let camMatch = rel.match(/cam_(\d+)/i);
   if (camMatch) camera = (camMatch[1] == "0") ? "TELE" : "WIDE";

   let name = File.extractName(path);
   let gain = null, bin_ = null, exptime = null, temp = null, ir = null, isMaster = false, m;

   if (kind == "dark" && (m = name.match(/dark_exp_([\d.]+)_gain_(\d+)_bin_(\d+)_(-?\d+)C_stack_(\d+)/i))) {
      exptime = parseFloat(m[1]); gain = parseInt(m[2], 10); bin_ = parseInt(m[3], 10); temp = parseFloat(m[4]);
      isMaster = true;
   } else if (kind == "flat" && (m = name.match(/flat_gain_(\d+)_bin_(\d+)(?:_ir_(\d+))?/i))) {
      gain = parseInt(m[1], 10); bin_ = parseInt(m[2], 10); ir = (m[3] !== undefined) ? parseInt(m[3], 10) : null;
      isMaster = true;
   } else if (kind == "bias" && (m = name.match(/bias_gain_(\d+)_bin_(\d+)/i))) {
      gain = parseInt(m[1], 10); bin_ = parseInt(m[2], 10);
      isMaster = true;
   } else {
      try {
         let meta = readFrameMeta(path);
         camera = meta.camera || camera;
         gain = meta.gain; bin_ = meta.bin; exptime = meta.exptime; temp = meta.temp;
         let irMatch = rel.match(/ir_(\d+)/i);
         if (irMatch) ir = parseInt(irMatch[1], 10);
      } catch (e) { return null; }
   }

   return { path: path, kind: kind, camera: camera, gain: gain, bin: bin_, exptime: exptime, temp: temp, ir: ir, isMaster: isMaster };
}

function scanCalibrationLibrary(rootDir) {
   let results = [];
   function walk(dir) {
      let ff = new FileFind;
      if (ff.begin(dir + "/*")) {
         do {
            if (ff.name == "." || ff.name == "..") continue;
            let full = dir + "/" + ff.name;
            if (ff.isDirectory) walk(full);
            else if (/\.(fits|fit|xisf)$/i.test(ff.name)) {
               let rec = classifyCalibFile(full, rootDir);
               if (rec && rec.camera && rec.gain != null && rec.bin != null) results.push(rec);
            }
         } while (ff.next());
      }
   }
   walk(rootDir);
   return results;
}

function findBestDark(lib, camera, gain, bin_, exptime, targetTemp) {
   let cands = lib.filter(function(r) { return r.kind == "dark" && r.camera == camera && r.gain == gain && r.bin == bin_ && r.exptime != null && r.temp != null; });
   if (cands.length == 0) return null;
   let exact = cands.filter(function(r) { return Math.abs(r.exptime - exptime) < 0.01; });
   let haveTemp = (targetTemp != null && !isNaN(targetTemp));
   let tDiff = function(r) { return haveTemp ? Math.abs(r.temp - targetTemp) : 0; };
   let pool = exact.length > 0 ? exact : cands;
   // Exact exposure: closest temperature. Otherwise: closest exposure first, then temperature.
   pool = pool.slice().sort(function(a, b) {
      if (exact.length == 0) {
         let de = Math.abs(a.exptime - exptime) - Math.abs(b.exptime - exptime);
         if (Math.abs(de) > 1e-6) return de;
      }
      return tDiff(a) - tDiff(b);
   });
   return { path: pool[0].path, approxExptime: exact.length == 0, usedExptime: pool[0].exptime, tempDiff: tDiff(pool[0]), haveTemp: haveTemp };
}

function findBestBias(lib, camera, gain, bin_) {
   let cands = lib.filter(function(r) { return r.kind == "bias" && r.camera == camera && r.gain == gain && r.bin == bin_; });
   if (cands.length == 0) return null;
   cands = cands.slice().sort(function(a, b) { return (b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0); });
   return cands[0];
}

function findBestFlat(lib, camera, gain, bin_) {
   let cands = lib.filter(function(r) { return r.kind == "flat" && r.camera == camera && r.gain == gain && r.bin == bin_ && r.isMaster; });
   if (cands.length == 0) return null;
   let irValues = {};
   cands.forEach(function(r) { irValues[r.ir] = true; });
   if (Object.keys(irValues).length > 1) return { ambiguous: true, options: cands };
   return { ambiguous: false, record: cands[0] };
}

// ---- Pipeline steps -------------------------------------------------------

function materializeMasterFrame(rec, workDir, label) {
   let outDir = workDir + "/0_masters";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let outPath = outDir + "/" + label + "_" + File.extractName(rec.path) + ".xisf";
   if (File.exists(outPath)) return outPath;
   let w = ImageWindow.open(rec.path)[0];
   let kws = w.keywords.slice();
   if (rec.exptime != null) kws.push(new FITSKeyword("EXPTIME", rec.exptime.toString(), "[s] Exposure time"));
   if (rec.gain != null) kws.push(new FITSKeyword("GAIN", rec.gain.toString(), "Gain"));
   if (rec.bin != null) {
      kws.push(new FITSKeyword("XBINNING", rec.bin.toString(), "Binning factor X"));
      kws.push(new FITSKeyword("YBINNING", rec.bin.toString(), "Binning factor Y"));
   }
   if (rec.temp != null) kws.push(new FITSKeyword("DET-TEMP", rec.temp.toString(), "Detector temperature"));
   w.keywords = kws;
   w.saveAs(outPath, false, false, false, false);
   w.forceClose();
   return outPath;
}

function runCalibration(files, workDir, masterDarkPath, masterBiasPath, masterFlatPath, approxDark) {
   let outDir = workDir + "/0_calibrated";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, /_c\.xisf$/i);
   if (existing.length == files.length) return existing;
   clearDirFiles(outDir);
   clearDirFiles(workDir + "/1_debayer");
   clearDirFiles(workDir + "/2_aligned");

   let P = new ImageCalibration;
   P.targetFrames = files.map(function(p) { return [true, p]; });
   P.masterDarkEnabled = !!masterDarkPath;
   P.masterDarkPath = masterDarkPath || "";
   P.masterBiasEnabled = !!masterBiasPath;
   P.masterBiasPath = masterBiasPath || "";
   P.masterFlatEnabled = !!masterFlatPath;
   P.masterFlatPath = masterFlatPath || "";
   if (approxDark) {
      // The master dark has a different exposure than the lights: it must be scaled.
      P.optimizeDarks = true;
      P.enableCFA = true; // lights are still un-debayered (CFA) at this stage
   }
   P.outputDirectory = outDir;
   P.outputPostfix = "_c";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("ImageCalibration failed.");
   return listFiles(outDir, /_c\.xisf$/i);
}

function runDebayer(files, workDir) {
   let outDir = workDir + "/1_debayer";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, /_d\.xisf$/i);
   if (existing.length == files.length) return existing;
   clearDirFiles(outDir);
   clearDirFiles(workDir + "/2_aligned");

   let P = new Debayer;
   P.cfaPattern = Debayer.prototype.Auto;
   P.targetItems = files.map(function(p) { return [true, p]; });
   P.outputDirectory = outDir;
   P.outputPostfix = "_d";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("Debayer failed.");
   return listFiles(outDir, /_d\.xisf$/i);
}

function runStarAlignment(files, workDir) {
   let outDir = workDir + "/2_aligned";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, /_r\.xisf$/i);
   if (existing.length == files.length) return existing;
   clearDirFiles(outDir);

   let P = new StarAlignment;
   P.referenceImage = files[0];
   P.referenceIsFile = true;
   P.targets = files.map(function(p) { return [true, true, p]; });
   P.outputDirectory = outDir;
   P.outputPostfix = "_r";
   P.overwriteExistingFiles = true;
   P.generateDrizzleData = false;
   if (!P.executeGlobal()) throw new Error("StarAlignment failed.");
   return listFiles(outDir, /_r\.xisf$/i);
}

function sortFilesChronologically(files) {
   let entries = files.map(function(p) {
      let dateStr = readDateObsFromFile(p);
      return { path: p, dateStr: dateStr, jd: toJD(dateStr) };
   });
   entries.sort(function(a, b) { return a.jd - b.jd; });
   return entries;
}

// Identifies anchor frame indices: always first and last, plus frames
// immediately before/after a time gap or a sudden shift/reframe jump.
// Warns and lists images with large shifts without rejecting them.
function findAnchorIndices(entries, gapMinutes, shiftThreshold, extremeShiftThreshold, logFn, checkStopFn) {
   let gapDays = (gapMinutes || GAP_MINUTES) / 1440;
   let maxShift = shiftThreshold || SHIFT_JUMP_THRESHOLD;
   let extremeShift = extremeShiftThreshold || EXTREME_SHIFT_THRESHOLD;
   let set = {};
   set[0] = true;
   set[entries.length - 1] = true;

   let bounds = entries.map(function(e, idx) {
      processEvents();
      if (checkStopFn) checkStopFn();
      return measureActiveBounds(e.path);
   });

   let gapCount = 0;
   let shiftCount = 0;
   let extremeItems = [];

   for (let i = 1; i < entries.length; ++i) {
      let dtDays = entries[i].jd - entries[i - 1].jd;
      let isTimeGap = dtDays > gapDays;

      let dx = bounds[i].cx - bounds[i - 1].cx;
      let dy = bounds[i].cy - bounds[i - 1].cy;
      let dw = bounds[i].w - bounds[i - 1].w;
      let dh = bounds[i].h - bounds[i - 1].h;
      let shiftMag = Math.sqrt(dx * dx + dy * dy + 0.25 * (dw * dw + dh * dh));
      let isShiftJump = shiftMag > maxShift;

      if (isTimeGap || isShiftJump) {
         set[i - 1] = true;
         set[i] = true;
         if (isTimeGap) ++gapCount;
         if (isShiftJump) ++shiftCount;
         if (logFn) {
            let reasons = [];
            if (isTimeGap) reasons.push((dtDays * 1440).toFixed(1) + "m gap");
            if (isShiftJump) reasons.push(shiftMag.toFixed(0) + "px shift");
            logFn("   Detected discontinuity between frame #" + i + " and #" + (i + 1) + " (" + reasons.join(", ") + ").");
         }
      }

      if (shiftMag > extremeShift) {
         extremeItems.push({
            idxA: i - 1,
            idxB: i,
            nameA: File.extractName(entries[i - 1].path),
            nameB: File.extractName(entries[i].path),
            shift: shiftMag
         });
      }
   }

   if (logFn) {
      if (gapCount > 0 || shiftCount > 0) {
         logFn("   Anchor triggers: " + gapCount + " time gap(s), " + shiftCount + " shift/reframe jump(s).");
      }
      if (extremeItems.length > 0) {
         let listStr = extremeItems.map(function(it) {
            return "#" + (it.idxA + 1) + " (" + it.nameA + ") -> #" + (it.idxB + 1) + " (" + it.nameB + ") [" + it.shift.toFixed(0) + "px]";
         }).join("; ");
         logFn("   WARNING: Large shift (> " + extremeShift + "px) detected — kept in stack, check: " + listStr);
      }
   }

   return Object.keys(set).map(function(k) { return parseInt(k, 10); }).sort(function(a, b) { return a - b; });
}

// Computes nucleus coordinates for all frames using piecewise JD interpolation
// between manual anchor picks, refined locally around each predicted position.
function computeCometPositions(entries, anchorCoordsByIdx, logFn, checkStopFn) {
   let anchorIndices = Object.keys(anchorCoordsByIdx)
      .map(function(k) { return parseInt(k, 10); })
      .sort(function(a, b) { return a - b; });

   let positions = new Array(entries.length);

   // Re-center each anchor click with the SAME estimator used for the intermediate
   // frames, so there is no systematic offset between anchors and refined frames.
   let anchorsRefined = 0;
   let anchorShifts = [];      // click -> local centroid distance (px), for the robustness report
   let anchorLines = [];
   for (let a = 0; a < anchorIndices.length; ++a) {
      processEvents();
      if (checkStopFn) checkStopFn();
      let idx = anchorIndices[a];
      let click = anchorCoordsByIdx[idx];
      let loc = refineNucleusLocally(entries[idx].path, click[0], click[1], ANCHOR_REFINE_RADIUS);
      positions[idx] = loc.pos;
      if (loc.refined) {
         ++anchorsRefined;
         anchorShifts.push(Math.sqrt((loc.pos[0] - click[0]) * (loc.pos[0] - click[0]) + (loc.pos[1] - click[1]) * (loc.pos[1] - click[1])));
      }
      anchorLines.push("   Anchor [" + idx + "]: click (" + click[0].toFixed(2) + ", " + click[1].toFixed(2) + ") -> " +
                       (loc.refined ? "local centroid (" : "kept as clicked (") + loc.pos[0].toFixed(2) + ", " + loc.pos[1].toFixed(2) + ")");
   }

   let refinedCount = 0, outlierCount = 0;
   let allCorrMags = [];       // |refined - straight-line prediction| (px) for every refined frame
   for (let a = 0; a < anchorIndices.length - 1; ++a) {
      let i0 = anchorIndices[a];
      let i1 = anchorIndices[a + 1];
      let jd0 = entries[i0].jd;
      let jd1 = entries[i1].jd;
      let dt = jd1 - jd0;
      let p0 = positions[i0];
      let p1 = positions[i1];

      let pred = {}, corr = {};   // per-frame prediction and refined correction
      for (let k = i0 + 1; k < i1; ++k) {
         processEvents();
         if (checkStopFn) checkStopFn();
         let t = (dt > 0) ? (entries[k].jd - jd0) / dt : 0;
         let predX = p0[0] + t * (p1[0] - p0[0]);
         let predY = p0[1] + t * (p1[1] - p0[1]);
         let loc = refineNucleusLocally(entries[k].path, predX, predY, LOCAL_SEARCH_RADIUS);
         positions[k] = loc.pos;
         pred[k] = [predX, predY];
         if (loc.refined) {
            ++refinedCount;
            corr[k] = [loc.pos[0] - predX, loc.pos[1] - predY];
            allCorrMags.push(Math.sqrt(corr[k][0] * corr[k][0] + corr[k][1] * corr[k][1]));
         }
      }

      // Outlier pass: the interpolation error is smooth in time, so a refined frame whose
      // correction disagrees with the median correction of its neighbours (+-3 frames)
      // most likely locked onto a star or noise. Replace it with prediction + neighbour median.
      let medianOf = function(arr) {
         let b = arr.slice().sort(function(x, y) { return x - y; });
         let m = b.length >> 1;
         return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
      };
      for (let k = i0 + 1; k < i1; ++k) {
         if (!corr[k]) continue;
         let nx = [], ny = [];
         for (let j = Math.max(i0 + 1, k - 3); j <= Math.min(i1 - 1, k + 3); ++j) {
            if (j !== k && corr[j]) { nx.push(corr[j][0]); ny.push(corr[j][1]); }
         }
         if (nx.length < 3) continue;
         let mx = medianOf(nx), my = medianOf(ny);
         let dx = corr[k][0] - mx, dy = corr[k][1] - my;
         if (Math.sqrt(dx * dx + dy * dy) > TRAJECTORY_OUTLIER_PX) {
            positions[k] = [pred[k][0] + mx, pred[k][1] + my];
            ++outlierCount;
         }
      }
   }

   if (logFn) {
      for (let i = 0; i < anchorLines.length; ++i) logFn(anchorLines[i]);
      if (allCorrMags.length > 0) {
         let sortedMags = allCorrMags.slice().sort(function(x, y) { return x - y; });
         logFn("   Intermediate-frame corrections vs. straight-line prediction: median " +
               sortedMags[sortedMags.length >> 1].toFixed(2) + " px, max " + sortedMags[sortedMags.length - 1].toFixed(2) +
               " px over " + sortedMags.length + " frame(s).");
      }
      logFn("   Re-centered " + anchorsRefined + " of " + anchorIndices.length + " anchor click(s) with the local centroid.");
      logFn("   Refined " + refinedCount + " of " + Math.max(0, entries.length - anchorIndices.length) + " intermediate frame(s) via local centroid search" +
            (outlierCount > 0 ? "; corrected " + outlierCount + " outlier position(s) against neighbouring frames." : "."));
   }
   return positions;
}

function runCometAlignment(entries, positions, workDir) {
   // Workaround for CometAlignment's broken non-fixed interpolation:
   // compute every position ourselves and mark all frames "fixed".
   let targetFrames = [];
   for (let i = 0; i < entries.length; ++i) {
      let x = positions[i][0], y = positions[i][1];
      targetFrames.push([entries[i].path, true, entries[i].dateStr, entries[i].jd, x, y, true, ""]);
   }

   let outDir = workDir + "/3_comet_aligned";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   clearDirFiles(outDir);

   let P = new CometAlignment;
   P.targetFrames = targetFrames;
   P.referenceIndex = 0;
   P.fitPSF = false;
   P.outputDirectory = outDir;
   P.outputPostfix = "_ca";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("CometAlignment failed.");
   return listFiles(outDir, /_ca\.xisf$/i);
}

function runStarNet2Batch(files, workDir, nucleusX, nucleusY, logFn, statusFn, checkStopFn) {
   let outDir = workDir + "/4_starless";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   clearDirFiles(outDir);

   if (logFn) {
      logFn("   NOTE: StarNet2 star removal can take a very long time depending on your computer's speed and image size.");
   }

   let warnings = [];
   let avgFrameSec = null;

   for (let i = 0; i < files.length; ++i) {
      processEvents();
      if (checkStopFn) checkStopFn();

      let tStart = Date.now();
      if (logFn) logFn("   StarNet2 [" + (i + 1) + "/" + files.length + "]: " + File.extractName(files[i]));
      let w = ImageWindow.open(files[i])[0];
      let before = peakInRegion(w.mainView, nucleusX, nucleusY, 40);
      let P = new StarNet2;
      P.mask = false;
      P.linear = true;
      P.executeOn(w.mainView);
      let after = peakInRegion(w.mainView, nucleusX, nucleusY, 40);
      if (before > 0 && after / before < 0.4) {
         let warnMsg = File.extractName(files[i]) + ": nucleus dropped to " + (100 * after / before).toFixed(0) + "% of original brightness";
         warnings.push(warnMsg);
         if (logFn) logFn("   WARNING: " + warnMsg);
      }
      w.saveAs(outDir + "/" + File.extractName(files[i]) + "_sn.xisf", false, false, false, false);
      w.forceClose();

      let elapsedSec = (Date.now() - tStart) / 1000;
      if (avgFrameSec === null) {
         avgFrameSec = elapsedSec;
      } else {
         avgFrameSec = 0.7 * avgFrameSec + 0.3 * elapsedSec;
      }

      let remainingFrames = files.length - 1 - i;
      if (remainingFrames > 0) {
         let estRemainingSec = avgFrameSec * remainingFrames;
         let etaStr = "~" + formatDuration(estRemainingSec);
         if (statusFn) {
            statusFn("StarNet2 [" + (i + 1) + "/" + files.length + "] — Estimated time remaining for " + remainingFrames + " frame(s): " + etaStr);
         }
         if (logFn) {
            if (i === 0) {
               logFn("   First frame took " + formatDuration(elapsedSec) + ". Estimated time remaining for " + remainingFrames + " frame(s): " + etaStr + ".");
            } else {
               logFn("   Frame took " + formatDuration(elapsedSec) + " (avg " + formatDuration(avgFrameSec) + "). Estimated time remaining for " + remainingFrames + " frame(s): " + etaStr + ".");
            }
         }
      }

      processEvents();
      gc();
      if (checkStopFn) checkStopFn();
   }
   return { files: listFiles(outDir, /_sn\.xisf$/i), warnings: warnings };
}

function runIntegration(files, mode) {
   let chosenMode = mode || "median"; // Default: Median; supports "average" for small stacks (4-12 frames)
   let useAverage = (chosenMode === "average");

   let P = new ImageIntegration;
   P.images = files.map(function(p) { return [true, p, "", ""]; });
   P.inputHints = "";
   P.combination = useAverage
      ? ImageIntegration.prototype.Average
      : ImageIntegration.prototype.Median;
   P.normalization = ImageIntegration.prototype.AdditiveWithScaling;
   P.weightMode = ImageIntegration.prototype.DontCare;
   if (useAverage && files.length >= 4) {
      P.rejection = ImageIntegration.prototype.WinsorizedSigmaClip;
      P.rejectionNormalization = 1; // 0 = None, 1 = Scale + Zero Offset
      P.sigmaLow = 4.0;
      P.sigmaHigh = 1.1;
   } else {
      P.rejection = ImageIntegration.prototype.NoRejection;
   }
   P.generateRejectionMaps = false;
   P.evaluateSNR = false;
   if (!P.executeGlobal()) throw new Error("ImageIntegration failed.");
   let w = ImageWindow.windowById(P.integrationImageId);
   // A kept-for-recovery stack from an earlier failed run would otherwise collide with this id.
   closeWindowsById(["cometStackLayer"]);
   w.mainView.id = "cometStackLayer";
   return w;
}

// Faint stars that StarNet2 cannot detect in a single frame stay in every starless frame; the
// comet alignment then smears them into short streaks in the integrated stack. In the (much
// deeper) stack they are detectable, so one extra StarNet2 pass on that single image removes them.
// StarNet2 can also take part of the compact nucleus (it looks like a star), so the raw pixels
// around the nucleus are copied first and blended back afterwards (full strength inside
// NUCLEUS_RESTORE_INNER px, cosine fade to the cleaned data at NUCLEUS_RESTORE_OUTER px).
// Returns true if the pass was applied.
function removeResidualStarsFromStack(cometWin, nucleusX, nucleusY, logFn) {
   let view = cometWin.mainView;
   let before = peakInRegion(view, nucleusX, nucleusY, 40);

   // Keep the raw pixels around the nucleus.
   let R0 = NUCLEUS_RESTORE_INNER, R1 = Math.max(NUCLEUS_RESTORE_OUTER, NUCLEUS_RESTORE_INNER + 1);
   let img = view.image;
   let x0 = Math.max(0, Math.floor(nucleusX - R1)), y0 = Math.max(0, Math.floor(nucleusY - R1));
   let x1 = Math.min(img.width, Math.ceil(nucleusX + R1) + 1), y1 = Math.min(img.height, Math.ceil(nucleusY + R1) + 1);
   let rect = new Rect(x0, y0, x1, y1);
   let ww = x1 - x0, hh = y1 - y0;
   let n = img.numberOfChannels;
   let rawBuf = [];
   if (RESTORE_RAW_NUCLEUS) {
      for (let ch = 0; ch < n; ++ch) {
         let b = new Float64Array(ww * hh);
         img.getSamples(b, rect, ch);
         rawBuf.push(b);
      }
   }

   let P = new StarNet2;
   P.mask = false;
   P.linear = true;
   P.executeOn(view);
   let afterStarnet = peakInRegion(view, nucleusX, nucleusY, 40);

   let after = afterStarnet;
   if (RESTORE_RAW_NUCLEUS) {
      view.beginProcess();
      try {
         let cur = view.image;
         let cleanBuf = new Float64Array(ww * hh);
         for (let ch = 0; ch < n; ++ch) {
            cur.getSamples(cleanBuf, rect, ch);
            for (let i = 0; i < cleanBuf.length; ++i) {
               let px = x0 + (i % ww), py = y0 + Math.floor(i / ww);
               let d = Math.sqrt((px - nucleusX) * (px - nucleusX) + (py - nucleusY) * (py - nucleusY));
               let wgt = (d <= R0) ? 1 : ((d >= R1) ? 0 : 0.5 * (1 + Math.cos(Math.PI * (d - R0) / (R1 - R0))));
               if (wgt > 0) cleanBuf[i] += wgt * (rawBuf[ch][i] - cleanBuf[i]);
            }
            cur.setSamples(cleanBuf, rect, ch);
         }
      } finally {
         view.endProcess();
      }
      after = peakInRegion(view, nucleusX, nucleusY, 40);
   }

   if (logFn) {
      let pct = function(v) { return before > 0 ? (100 * v / before).toFixed(0) + "%" : "n/a"; };
      if (RESTORE_RAW_NUCLEUS)
         logFn("   Stack-level StarNet2 pass done. Nucleus peak after StarNet2: " + pct(afterStarnet) +
               " of the raw stack; after restoring the raw core (" + R0 + "-" + R1 + " px): " + pct(after) + ".");
      else
         logFn("   Stack-level StarNet2 pass done. Nucleus peak kept at " + pct(afterStarnet) + " of the raw stack.");
   }
   return true;
}

// Integrates ALL star-aligned frames (stars are sharp, the comet is smeared over its path) into a
// deep star stack: much lower noise than a single frame, so many more faint stars survive.
// Saved to workDir; returns the saved path.
function buildDeepStarStack(files, workDir) {
   let P = new ImageIntegration;
   P.images = files.map(function(p) { return [true, p, "", ""]; });
   P.inputHints = "";
   P.combination = ImageIntegration.prototype.Average;
   P.normalization = ImageIntegration.prototype.AdditiveWithScaling;
   P.weightMode = ImageIntegration.prototype.NoiseEvaluation;
   P.rejection = ImageIntegration.prototype.WinsorizedSigmaClip;
   P.rejectionNormalization = 1; // 0 = None, 1 = Scale + Zero Offset
   P.sigmaLow = 4.0;
   P.sigmaHigh = 3.0;
   P.rangeClipLow = true;  // ignore the empty (zero) borders left by StarAlignment
   P.rangeLow = 0.0;
   P.generateRejectionMaps = false;
   P.evaluateSNR = false;
   if (!P.executeGlobal()) throw new Error("ImageIntegration of the star-aligned frames failed.");
   let w = ImageWindow.windowById(P.integrationImageId);
   let outPath = workDir + "/CometStack_starStack.xisf";
   try {
      w.saveAs(outPath, false, false, false, false);
   } finally {
      w.forceClose();
   }
   return outPath;
}

function distToSegment(px, py, ax, ay, bx, by) {
   let dx = bx - ax, dy = by - ay;
   let len2 = dx * dx + dy * dy;
   let t = (len2 > 0) ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
   t = Math.max(0, Math.min(1, t));
   let cx = ax + t * dx, cy = ay + t * dy;
   return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// The comet is smeared along its path in the star-aligned stack, and StarNet2 may split part of
// that smear off as "stars". Fade the star layer to zero around the comet's path so the
// comet-aligned stack alone provides the comet (zero inside r0, cosine fade up to full at r1).
function maskStarsAroundComet(view, a, b, r0, r1) {
   let img = view.image;
   let x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r1)), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r1));
   let x1 = Math.min(img.width, Math.ceil(Math.max(a[0], b[0]) + r1) + 1), y1 = Math.min(img.height, Math.ceil(Math.max(a[1], b[1]) + r1) + 1);
   if (x1 <= x0 || y1 <= y0) return;
   let rect = new Rect(x0, y0, x1, y1);
   let ww = x1 - x0, hh = y1 - y0;
   let n = img.numberOfChannels;
   view.beginProcess();
   try {
      let cur = view.image;
      let buf = new Float64Array(ww * hh);
      for (let ch = 0; ch < n; ++ch) {
         cur.getSamples(buf, rect, ch);
         for (let i = 0; i < buf.length; ++i) {
            let px = x0 + (i % ww), py = y0 + Math.floor(i / ww);
            let d = distToSegment(px, py, a[0], a[1], b[0], b[1]);
            let keep = (d <= r0) ? 0 : ((d >= r1) ? 1 : 0.5 * (1 - Math.cos(Math.PI * (d - r0) / (r1 - r0))));
            buf[i] *= keep;
         }
         cur.setSamples(buf, rect, ch);
      }
   } finally {
      view.endProcess();
   }
}

// Isolates stars from the star-aligned reference frame by subtracting its
// StarNet2 starless version, then screen-blends starsOnly over cometStackLayer
// so single-frame background noise does not clip into the comet via max().
function combine(refStarPath, cometWindow, workDir, cometPathSegment) {
   // Leftover temporaries from an earlier failed run would collide with the ids used below.
   closeWindowsById(["refStarsLayer", "refStarlessLayer", "starsOnlyLayer"]);
   let starWin = ImageWindow.open(refStarPath)[0];
   let starlessWin = ImageWindow.open(refStarPath)[0];
   let succeeded = false;
   try {
      let sn = new StarNet2;
      sn.mask = false;
      sn.linear = true;
      sn.executeOn(starlessWin.mainView);

      starWin.mainView.id = "refStarsLayer";
      starlessWin.mainView.id = "refStarlessLayer";

      let subPM = new PixelMath;
      subPM.expression = "max(0, refStarsLayer - refStarlessLayer)";
      subPM.useSingleExpression = true;
      subPM.createNewImage = true;
      subPM.newImageId = "starsOnlyLayer";
      subPM.showNewImage = false;
      subPM.rescale = false;
      subPM.truncate = true;
      if (!subPM.executeOn(starWin.mainView)) throw new Error("PixelMath star isolation failed.");

      let starsOnlyWin = ImageWindow.windowById("starsOnlyLayer");
      try {
         if (cometPathSegment)
            maskStarsAroundComet(starsOnlyWin.mainView, cometPathSegment[0], cometPathSegment[1],
                                 STAR_MASK_INNER, Math.max(STAR_MASK_OUTER, STAR_MASK_INNER + 1));
         // PixelMath gives the new image a different id if "CometStack_final" is already open
         // (e.g. the result of a previous run), so identify the new window by diffing the list.
         let idsBefore = ImageWindow.windows.map(function(w) { return w.mainView.id; });
         let blendPM = new PixelMath;
         blendPM.expression = "1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)";
         blendPM.useSingleExpression = true;
         blendPM.createNewImage = true;
         blendPM.newImageId = "CometStack_final";
         blendPM.showNewImage = true;
         blendPM.rescale = false;
         blendPM.truncate = true;
         if (!blendPM.executeOn(cometWindow.mainView)) throw new Error("PixelMath screen blend failed.");

         let finalWin = null;
         let wins = ImageWindow.windows;
         for (let i = 0; i < wins.length; ++i) {
            if (idsBefore.indexOf(wins[i].mainView.id) < 0) { finalWin = wins[i]; break; }
         }
         if (!finalWin) finalWin = ImageWindow.windowById("CometStack_final");
         if (!finalWin || finalWin.isNull) throw new Error("Could not locate the blended result window.");
         succeeded = true;
         return finalWin;
      } finally {
         if (starsOnlyWin) starsOnlyWin.forceClose();
      }
   } finally {
      // Only discard the integrated comet stack once the final image exists; on any failure
      // it stays open (and was already saved to disk by the caller) so no work is lost.
      if (succeeded && cometWindow) cometWindow.forceClose();
      starlessWin.forceClose();
      starWin.forceClose();
   }
}

// ---- UI --------------------------------------------------------------------

function CometStackDialog() {
   this.__base__ = Dialog;
   this.__base__();

   let dlg = this;
   this.inputFiles = [];
   this.workDir = "";
   this.orderedEntries = [];
   this.anchorCoordsByIdx = {};
   this.calibLibrary = [];
   this.isRunning = false;
   this.isCompleted = false;
   this.cancelRequested = false;

   let cometIcon = createCometIconBitmap(22);

   this.windowTitle = "OSC Comet Stacking Script";
   this.minWidth = 560;
   this.position = new Point(100, 100);

   this.log = function(line) {
      let now = new Date();
      let stamp = "[" + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds()) + "] ";
      let cur = dlg.logBox.text;
      dlg.logBox.text = cur ? (cur + "\n" + stamp + line) : (stamp + line);
      processEvents();
   };

   this.checkCancelled = function() {
      processEvents();
      if (dlg.cancelRequested) {
         throw new UserStoppedError("Process stopped by user.");
      }
   };

   this.setControlsBusy = function(busy) {
      dlg.isRunning = busy;
      if (busy) dlg.cancelRequested = false;
      dlg.step0Button.enabled = !busy;
      dlg.step1Button.enabled = !busy;
      dlg.step2Button.enabled = !busy && !dlg.isCompleted && dlg.orderedEntries.length >= 3;
      dlg.stopButton.enabled = busy;
      setStopHighlight(dlg.stopButton, busy);
      dlg.closeButton.enabled = !busy;
   };

   // Centered Header
   this.headerIcon = new Label(this);
   this.headerIcon.pixmap = cometIcon;
   this.headerIcon.setFixedSize(22, 22);

   this.headerLabel = new Label(this);
   this.headerLabel.text = "OSC Comet Stacking Script";
   this.headerLabel.styleSheet = "font-size: 13.5pt; font-weight: bold;";

   let headerSizer = new HorizontalSizer;
   headerSizer.spacing = 8;
   headerSizer.addStretch();
   headerSizer.add(this.headerIcon);
   headerSizer.add(this.headerLabel);
   headerSizer.addStretch();

   // Group 1: Inputs & Preparation
   this.prepGroup = new GroupBox(this);
   this.prepGroup.title = "1. Calibration and Light Frames";
   this.prepGroup.styleSheet = "QGroupBox { font-size: 10.5pt; font-weight: bold; }";

   this.step0Button = new PushButton(this.prepGroup);
   this.step0Button.text = "Select Calibration Folder (Optional)...";
   setHighlight(this.step0Button, false);
   this.step0Button.onClick = function() {
      let gdd = new GetDirectoryDialog;
      gdd.caption = "Select folder containing dark/flat/bias frames";
      if (!gdd.execute()) return;

      dlg.setControlsBusy(true);
      dlg.status0.text = "Scanning calibration library...";
      dlg.log("Scanning calibration library: " + gdd.directory);
      try {
         dlg.calibLibrary = scanCalibrationLibrary(gdd.directory);
         let nDark = dlg.calibLibrary.filter(function(r) { return r.kind == "dark"; }).length;
         let nFlat = dlg.calibLibrary.filter(function(r) { return r.kind == "flat"; }).length;
         let nBias = dlg.calibLibrary.filter(function(r) { return r.kind == "bias"; }).length;
         let summary = "Library: " + nDark + " dark, " + nFlat + " flat, " + nBias + " bias file(s) ready.";
         dlg.status0.text = summary;
         dlg.log(summary);
      } catch (e) {
         dlg.calibLibrary = [];
         dlg.status0.text = "Calibration scan failed.";
         showErrorDialog("Calibration Scan", e, dlg.log);
      } finally {
         dlg.setControlsBusy(false);
      }
   };

   this.status0 = new Label(this.prepGroup);
   this.status0.text = "No calibration folder selected (lights will run uncalibrated).";
   this.status0.wordWrapping = true;
   this.status0.styleSheet = "color: #666666; font-weight: normal; font-size: 9pt;";

   this.step1Button = new PushButton(this.prepGroup);
   this.step1Button.text = "Select Light Frames Folder...";
   setHighlight(this.step1Button, true);
   this.step1Button.onClick = function() {
      let gdd = new GetDirectoryDialog;
      gdd.caption = "Select folder containing light frames";
      if (!gdd.execute()) return;

      dlg.isCompleted = false;
      dlg.anchorCoordsByIdx = {};
      setHighlight(dlg.closeButton, false);
      dlg.setControlsBusy(true);
      setHighlight(dlg.step1Button, false);
      dlg.inputFiles = listFiles(gdd.directory, /\.(fits|fit|xisf)$/i);
      dlg.workDir = gdd.directory + "/CometStack_work";
      if (dlg.inputFiles.length < 3) {
         let msg = "Found " + dlg.inputFiles.length + " frame(s); at least 3 are required.";
         dlg.status1.text = msg;
         dlg.setControlsBusy(false);
         showErrorDialog("Insufficient Frames", new Error(msg), dlg.log);
         return;
      }

      dlg.log("Found " + dlg.inputFiles.length + " light frames. Work folder: " + dlg.workDir);
      try {
         dlg.checkCancelled();
         let filesToDebayer = dlg.inputFiles;

         if (dlg.calibLibrary.length > 0) {
            dlg.status1.text = "Matching calibration frames...";
            dlg.log("Matching calibration frames against light metadata...");
            let lightMeta = readFrameMeta(dlg.inputFiles[0]);
            let missingKw = [];
            if (!lightMeta.camera) missingKw.push("CAMERA/INSTRUME");
            if (lightMeta.gain == null || isNaN(lightMeta.gain)) missingKw.push("GAIN");
            if (lightMeta.bin == null || isNaN(lightMeta.bin)) missingKw.push("XBINNING");
            if (lightMeta.exptime == null || isNaN(lightMeta.exptime)) missingKw.push("EXPTIME");
            if (missingKw.length > 0)
               dlg.log("   NOTE: the first light frame's header has no " + missingKw.join(", ") + "; calibration frames that need it cannot be matched.");
            let temps = dlg.inputFiles.map(function(p) { return readFrameMeta(p).temp; }).filter(function(t) { return t != null; });
            let avgTemp = temps.length ? (temps.reduce(function(a, b) { return a + b; }, 0) / temps.length) : lightMeta.temp;

            let darkMatch = (lightMeta.camera && lightMeta.gain != null && lightMeta.bin != null && lightMeta.exptime != null)
               ? findBestDark(dlg.calibLibrary, lightMeta.camera, lightMeta.gain, lightMeta.bin, lightMeta.exptime, avgTemp) : null;
            let biasRec = (lightMeta.camera && lightMeta.gain != null && lightMeta.bin != null)
               ? findBestBias(dlg.calibLibrary, lightMeta.camera, lightMeta.gain, lightMeta.bin) : null;
            let flatMatch = (lightMeta.camera && lightMeta.gain != null && lightMeta.bin != null)
               ? findBestFlat(dlg.calibLibrary, lightMeta.camera, lightMeta.gain, lightMeta.bin) : null;

            let msgs = [];
            let darkPath = null, biasPath = null, flatPath = null;
            if (darkMatch) {
               darkPath = materializeMasterFrame({ path: darkMatch.path, exptime: darkMatch.usedExptime, gain: lightMeta.gain, bin: lightMeta.bin, temp: null }, dlg.workDir, "dark");
               msgs.push("dark " + (darkMatch.approxExptime ? "(closest exptime " + darkMatch.usedExptime + "s, dark optimization on) " : "") +
                  (darkMatch.haveTemp ? "@ " + darkMatch.tempDiff.toFixed(0) + "°C diff" : "(no temperature in light headers)"));
            } else msgs.push("no dark");
            if (biasRec) {
               biasPath = materializeMasterFrame(biasRec, dlg.workDir, "bias");
               msgs.push("bias matched");
            } else msgs.push("no bias");
            if (flatMatch && !flatMatch.ambiguous) {
               flatPath = materializeMasterFrame(flatMatch.record, dlg.workDir, "flat");
               msgs.push("flat matched");
            } else if (flatMatch && flatMatch.ambiguous) msgs.push("flat skipped (ambiguous IR)");
            else msgs.push("no flat");

            dlg.log("Calibration match: " + msgs.join(", "));
            if (darkPath || biasPath || flatPath) {
               dlg.checkCancelled();
               dlg.status1.text = "Calibrating (" + msgs.join(", ") + ")...";
               dlg.log("Running ImageCalibration...");
               filesToDebayer = runCalibration(dlg.inputFiles, dlg.workDir, darkPath, biasPath, flatPath, !!(darkMatch && darkMatch.approxExptime));
            } else {
               dlg.log("No applicable calibration frames matched; proceeding uncalibrated.");
            }
         }

         dlg.checkCancelled();
         dlg.status1.text = "Running Debayer...";
         dlg.log("Running Debayer on " + filesToDebayer.length + " frames...");
         let debayered = runDebayer(filesToDebayer, dlg.workDir);

         dlg.checkCancelled();
         dlg.status1.text = "Running StarAlignment...";
         dlg.log("Running StarAlignment on " + debayered.length + " debayered frames...");
         let aligned = runStarAlignment(debayered, dlg.workDir);

         dlg.checkCancelled();
         dlg.log("Sorting aligned frames chronologically by DATE-OBS...");
         dlg.orderedEntries = sortFilesChronologically(aligned);

         dlg.checkCancelled();
         dlg.status1.text = "Scanning for time gaps and reframes/shifts...";
         dlg.log("Scanning aligned frames for time gaps (> " + GAP_MINUTES + "m) and shifts (> " + SHIFT_JUMP_THRESHOLD + "px)...");
         let anchors = findAnchorIndices(dlg.orderedEntries, GAP_MINUTES, SHIFT_JUMP_THRESHOLD, EXTREME_SHIFT_THRESHOLD, dlg.log, dlg.checkCancelled);
         let extraAnchors = Math.max(0, anchors.length - 2);
         let doneMsg = dlg.orderedEntries.length + " frames aligned & ordered" +
            (extraAnchors > 0 ? (" (" + extraAnchors + " extra anchor(s) from gaps/shifts)") : "") + ".";
         dlg.status1.text = doneMsg;
         dlg.log(doneMsg);

         setHighlight(dlg.step1Button, false);
         dlg.step2Button.enabled = true;
         setHighlight(dlg.step2Button, true);
      } catch (e) {
         if (e instanceof UserStoppedError) {
            dlg.status1.text = "Preparation stopped by user.";
            dlg.log("Preparation stopped by user.");
         } else {
            dlg.status1.text = "Preparation failed.";
            showErrorDialog("Light Preparation", e, dlg.log);
         }
      } finally {
         dlg.setControlsBusy(false);
         setHighlight(dlg.step1Button, false);
         if (!dlg.isCompleted && dlg.orderedEntries.length >= 3) {
            setHighlight(dlg.step2Button, true);
         }
      }
   };

   this.status1 = new Label(this.prepGroup);
   this.status1.text = "Waiting for light frames folder.";
   this.status1.wordWrapping = true;
   this.status1.styleSheet = "font-weight: normal; font-size: 9pt;";

   this.prepGroup.sizer = new VerticalSizer;
   this.prepGroup.sizer.margin = 10;
   this.prepGroup.sizer.spacing = 6;
   this.prepGroup.sizer.add(this.step0Button);
   this.prepGroup.sizer.add(this.status0);
   this.prepGroup.sizer.addSpacing(4);
   this.prepGroup.sizer.add(this.step1Button);
   this.prepGroup.sizer.add(this.status1);

   // Group 2: Nucleus Marking -> Auto-Run Comet Stack
   this.cometGroup = new GroupBox(this);
   this.cometGroup.title = "2. Comet Nucleus and Automatic Stacking";
   this.cometGroup.styleSheet = "QGroupBox { font-size: 10.5pt; font-weight: bold; }";

   this.step2Button = new PushButton(this.cometGroup);
   this.step2Button.text = "Mark Nucleus on Anchors and Run";
   this.step2Button.icon = cometIcon;
   this.step2Button.enabled = false;
   setHighlight(this.step2Button, false);

   this.status2 = new Label(this.cometGroup);
   this.status2.text = "Complete step 1 to enable nucleus selection.";
   this.status2.wordWrapping = true;
   this.status2.styleSheet = "font-weight: normal; font-size: 9pt;";

   this.step2Button.onClick = function() {
      dlg.setControlsBusy(true);
      setHighlight(dlg.step2Button, false);
      try {
         dlg.checkCancelled();
         let anchorIndices = findAnchorIndices(dlg.orderedEntries, GAP_MINUTES, SHIFT_JUMP_THRESHOLD, EXTREME_SHIFT_THRESHOLD, null, dlg.checkCancelled);
         let coordsByIdx = {};

         for (let a = 0; a < anchorIndices.length; ++a) {
            dlg.checkCancelled();
            let idx = anchorIndices[a];
            let entry = dlg.orderedEntries[idx];
            let role = (idx === 0)
               ? "FIRST frame"
               : (idx === dlg.orderedEntries.length - 1)
                  ? "LAST frame"
                  : "GAP/SHIFT boundary frame #" + (idx + 1);

            dlg.status2.text = "Marking anchor " + (a + 1) + " of " + anchorIndices.length + " (" + role + ")...";
            dlg.log("Opening " + role + " [index " + idx + ", " + entry.dateStr + "] for nucleus selection...");

            let pt = pickNucleus(
               entry.path,
               "Mark comet nucleus (" + (a + 1) + "/" + anchorIndices.length + ")",
               "Anchor " + (a + 1) + " of " + anchorIndices.length + " — " + role + " (" + entry.dateStr + ")"
            );
            if (!pt) {
               dlg.status2.text = "Cancelled on anchor " + (a + 1) + " of " + anchorIndices.length + " — click button to restart.";
               dlg.log("Nucleus selection cancelled on anchor " + (a + 1) + " of " + anchorIndices.length + ".");
               return;
            }
            coordsByIdx[idx] = pt;
            dlg.log("Anchor [" + idx + "] marked at (" + pt[0].toFixed(1) + ", " + pt[1].toFixed(1) + ").");
         }

         dlg.checkCancelled();
         dlg.anchorCoordsByIdx = coordsByIdx;
         dlg.status2.text = "Interpolating & locally refining " + dlg.orderedEntries.length + " frame positions...";
         dlg.log("Computing piecewise JD trajectory with local centroid refinement...");
         let positions = computeCometPositions(dlg.orderedEntries, coordsByIdx, dlg.log, dlg.checkCancelled);

         dlg.checkCancelled();
         dlg.status2.text = "Running CometAlignment...";
         dlg.log("Running CometAlignment (" + dlg.orderedEntries.length + " fixed frames)...");
         let caFiles = runCometAlignment(dlg.orderedEntries, positions, dlg.workDir);
         dlg.log("CometAlignment produced " + caFiles.length + " aligned frames.");

         dlg.checkCancelled();
         dlg.status2.text = "Running StarNet2 on " + caFiles.length + " frames...";
         dlg.log("Removing stars with StarNet2...");
         let refNucleus = positions[0];
         let sn = runStarNet2Batch(caFiles, dlg.workDir, refNucleus[0], refNucleus[1], dlg.log, function(msg) {
            dlg.status2.text = msg;
            processEvents();
         }, dlg.checkCancelled);

         dlg.checkCancelled();
         let integMode = (sn.files.length >= 4 && sn.files.length <= 12) ? "average" : "median";
         dlg.status2.text = "Integrating starless comet frames (" + integMode + ")...";
         dlg.log("Running ImageIntegration (" + integMode.toUpperCase() + ") on " + sn.files.length + " starless frames...");
         let cometWin = runIntegration(sn.files, integMode);
         try {
            let cometSavePath = dlg.workDir + "/CometStack_cometStack.xisf";
            cometWin.saveAs(cometSavePath, false, false, false, false);
            dlg.log("Saved integrated starless comet stack: " + cometSavePath);
         } catch (e) {
            dlg.log("Note: could not save the intermediate comet stack (" + (e && e.message ? e.message : e) + ").");
         }

         if (STARNET_ON_COMET_STACK) {
            dlg.checkCancelled();
            dlg.status2.text = "Removing residual faint stars from the integrated stack (StarNet2)...";
            dlg.log("Running StarNet2 on the integrated comet stack to remove faint residual stars...");
            removeResidualStarsFromStack(cometWin, positions[0][0], positions[0][1], dlg.log);
            try {
               cometWin.saveAs(dlg.workDir + "/CometStack_cometStack_clean.xisf", false, false, false, false);
            } catch (e) {
               dlg.log("Note: could not save the cleaned comet stack (" + (e && e.message ? e.message : e) + ").");
            }
         }

         dlg.checkCancelled();
         dlg.status2.text = "Isolating stars and screen-blending...";
         let starSource = dlg.orderedEntries[0].path;
         let cometPathSegment = null;
         if (DEEP_STAR_LAYER) {
            try {
               dlg.status2.text = "Integrating all star-aligned frames for the star layer...";
               dlg.log("Integrating all " + dlg.orderedEntries.length + " star-aligned frames into a deep star stack...");
               starSource = buildDeepStarStack(dlg.orderedEntries.map(function(e) { return e.path; }), dlg.workDir);
               cometPathSegment = [positions[0], positions[positions.length - 1]];
               dlg.log("Saved deep star stack: " + starSource);
            } catch (e) {
               if (e instanceof UserStoppedError) throw e;
               starSource = dlg.orderedEntries[0].path;
               cometPathSegment = null;
               dlg.log("Note: could not build the deep star stack (" + (e && e.message ? e.message : e) + "); using the single reference frame instead.");
            }
            dlg.checkCancelled();
            dlg.status2.text = "Isolating stars and screen-blending...";
         }
         dlg.log("Isolating stars (" + (cometPathSegment ? "deep star stack" : "single reference frame") + ") and blending over comet stack...");
         let finalWin = combine(starSource, cometWin, dlg.workDir, cometPathSegment);
         applyAutoSTF(finalWin.mainView, 2.8, 0.16);
         finalWin.zoomToFit();
         finalWin.show();
         finalWin.bringToFront();

         let savePath = dlg.workDir + "/CometStack_final.xisf";
         finalWin.saveAs(savePath, false, false, false, false);
         dlg.status2.text = "Completed! Saved to " + savePath;
         dlg.log("Finished! Final image saved to: " + savePath);
         dlg.isCompleted = true;
         setHighlight(dlg.closeButton, true);
      } catch (e) {
         if (e instanceof UserStoppedError) {
            dlg.status2.text = "Stacking stopped by user — click button to restart.";
            dlg.log("Stacking stopped by user.");
         } else {
            dlg.status2.text = "Stacking failed — see error dialog or log.";
            if (ImageWindow.windowById("cometStackLayer") && !ImageWindow.windowById("cometStackLayer").isNull)
               dlg.log("The integrated comet stack is still open as 'cometStackLayer' and is saved as CometStack_cometStack.xisf in the work folder.");
            showErrorDialog("Comet Stack", e, dlg.log);
         }
      } finally {
         dlg.setControlsBusy(false);
         if (!dlg.isRunning && !dlg.isCompleted && dlg.orderedEntries.length >= 3) {
            setHighlight(dlg.step2Button, true);
         } else if (dlg.isCompleted) {
            setHighlight(dlg.step2Button, false);
            setHighlight(dlg.closeButton, true);
         }
      }
   };

   this.cometGroup.sizer = new VerticalSizer;
   this.cometGroup.sizer.margin = 10;
   this.cometGroup.sizer.spacing = 6;
   this.cometGroup.sizer.add(this.step2Button);
   this.cometGroup.sizer.add(this.status2);

   // Group 3: Live Process Log
   this.logGroup = new GroupBox(this);
   this.logGroup.title = "Process Activity Log";
   this.logGroup.styleSheet = "QGroupBox { font-size: 10.5pt; font-weight: bold; }";

   this.logBox = new TextBox(this.logGroup);
   this.logBox.readOnly = true;
   this.logBox.setFixedHeight(165);
   this.logBox.styleSheet = "font-family: monospace; font-size: 9pt;";

   this.logGroup.sizer = new VerticalSizer;
   this.logGroup.sizer.margin = 10;
   this.logGroup.sizer.spacing = 6;
   this.logGroup.sizer.add(this.logBox);

   // Footer: Stop Process, Close, Info / Process, Donate (uniformly sized)
   const FOOTER_BTN_W = 122;
   const FOOTER_BTN_H = 30;

   this.stopButton = new PushButton(this);
   this.stopButton.text = "Stop Process";
   this.stopButton.setFixedSize(FOOTER_BTN_W, FOOTER_BTN_H);
   this.stopButton.enabled = false;
   setStopHighlight(this.stopButton, false);
   this.stopButton.onClick = function() {
      if (dlg.isRunning && !dlg.cancelRequested) {
         dlg.cancelRequested = true;
         dlg.stopButton.enabled = false;
         setStopHighlight(dlg.stopButton, false);
         dlg.log("Stop requested — halting after current operation...");
         processEvents();
      }
   };

   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.setFixedSize(FOOTER_BTN_W, FOOTER_BTN_H);
   setHighlight(this.closeButton, false);
   this.closeButton.onClick = function() {
      if (!dlg.isRunning) dlg.ok();
   };

   this.infoButton = new PushButton(this);
   this.infoButton.text = "Info / Process";
   this.infoButton.setFixedSize(FOOTER_BTN_W, FOOTER_BTN_H);
   this.infoButton.toolTip = "View PixInsight requirements (such as StarNet2) and a rundown of how jump-aware stacking works";
   this.infoButton.styleSheet = "QPushButton { padding: 6px 10px; }";
   this.infoButton.onClick = function() {
      showInfoDialog(dlg);
   };

   this.donateButton = new PushButton(this);
   this.donateButton.text = "Donate";
   this.donateButton.setFixedSize(FOOTER_BTN_W, FOOTER_BTN_H);
   this.donateButton.toolTip = "Support CometStack development via PayPal (" + DONATE_URL + ")";
   setDonateStyle(this.donateButton);
   this.donateButton.onClick = function() {
      dlg.log("Donation link: " + DONATE_URL);
      openExternalUrl(DONATE_URL, dlg, dlg.log);
   };

   let footerSizer = new HorizontalSizer;
   footerSizer.spacing = 8;
   footerSizer.add(this.stopButton);
   footerSizer.addStretch();
   footerSizer.add(this.closeButton);
   footerSizer.add(this.infoButton);
   footerSizer.add(this.donateButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 8;
   this.sizer.add(headerSizer);
   this.sizer.add(this.prepGroup);
   this.sizer.add(this.cometGroup);
   this.sizer.add(this.logGroup);
   this.sizer.add(footerSizer);
   this.adjustToContents();

   this.log("Ready. Select a light frames folder to begin.");
}
CometStackDialog.prototype = new Dialog;

function main() {
   let dialog = new CometStackDialog;
   dialog.execute();
}

main();
