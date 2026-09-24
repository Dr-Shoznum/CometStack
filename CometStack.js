#feature-id CometStack > CometStack

#include <pjsr/DataType.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/ColorSpace.jsh>

/*
 * CometStack - one-shot comet stacking for OSC (color) cameras.
 *
 * Workflow: Debayer -> StarAlignment -> mark nucleus in first/last frame
 * (via a self-contained click-to-zoom-then-drag picker, entirely inside this
 * dialog - no need to interact with separate PixInsight image windows) ->
 * CometAlignment -> StarNet2 -> ImageIntegration -> PixelMath combine with
 * the reference frame's original stars.
 *
 * Real bugs found and worked around while building this against actual
 * DWARF mini + real comet data:
 *
 * 1. CometAlignment's own linear interpolation for non-fixed frames produces
 *    NaN positions (verified: reproducible even on clean synthetic data with
 *    as few as 3 frames). Workaround: compute the linear interpolation
 *    ourselves from Julian Dates and pass every frame as "fixed" with an
 *    explicit position, so CometAlignment's broken interpolation path is
 *    never used.
 * 2. Batch-processing many images through StarNet2 in a tight open/close
 *    loop can segfault the whole application. Workaround: call
 *    processEvents() and gc() between iterations.
 * 3. Marking the nucleus by asking the user to drag a native PixInsight
 *    preview on a separate image window was unreliable in practice (window
 *    management got in the way). Replaced with a picker embedded directly
 *    in this dialog: click roughly on the overview, then drag a small
 *    precise box on a magnified crop - no other window ever needs focus.
 */

// ---- UI helpers -------------------------------------------------------------

// Visually marks a button as "do this next" (solid accent color, bold white
// text) or clears it back to the platform default. Used to make the
// step-by-step flow self-evident instead of relying on the user to read
// status labels to figure out what to click next.
function setHighlight(button, on) {
   button.styleSheet = on
      ? "QPushButton { background-color: #2e7d32; color: white; font-weight: bold; }"
      : "";
}

// ---- Math / stats helpers --------------------------------------------------

function toJD(isoStr) {
   let m = isoStr.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
   let year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
   let hour = parseInt(m[4], 10), minute = parseInt(m[5], 10), second = parseInt(m[6], 10);
   let a = Math.floor((14 - month) / 12);
   let y = year + 4800 - a;
   let mm = month + 12 * a - 3;
   let jdn = day + Math.floor((153 * mm + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
   return jdn + (hour - 12) / 24 + minute / 1440 + second / 86400;
}

function readDateObs(window) {
   for (let k = 0; k < window.keywords.length; ++k)
      if (window.keywords[k].name == "DATE-OBS")
         return window.keywords[k].value.replace(/'/g, "").trim();
   return "";
}

function listFiles(dir, pattern) {
   let ff = new FileFind;
   let files = [];
   if (ff.begin(dir + "/" + pattern)) {
      do { if (!ff.isDirectory) files.push(dir + "/" + ff.name); } while (ff.next());
   }
   files.sort();
   return files;
}

function peakInRegion(view, cx, cy, halfsize) {
   let img = view.image;
   let rect = new Rect(Math.round(cx - halfsize), Math.round(cy - halfsize), Math.round(cx + halfsize), Math.round(cy + halfsize));
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
   let minV = Math.min.apply(null, acc);
   let sumW = 0, sumX = 0, sumY = 0;
   for (let yy = 0; yy < hh; ++yy) {
      for (let xx = 0; xx < ww; ++xx) {
         let v = acc[yy * ww + xx] - minV;
         sumW += v; sumX += v * (rect.x0 + xx); sumY += v * (rect.y0 + yy);
      }
   }
   return [sumX / sumW, sumY / sumW];
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

// [avgMedian, c0] - the expensive part of a stretch (a full-image statistics
// scan). Computed once per opened frame. This mirrors PixInsight's own
// "linked" STF algorithm (its Ctrl+A default, from the canonical ApplyAutoSTF
// reference script): each channel's median and MAD are computed SEPARATELY,
// then the per-channel medians are averaged and the per-channel shadow
// points (median_c - shadowsClipping*MAD_c) are averaged - producing one
// shared [c0, m] pair applied to every channel. The shadow point must be
// SUBTRACTED below the median (not added above it) so it sits on the dark
// side of the background - getting this backwards once made avgMedian - c0
// go negative, which forces MTF() to always return 0 and crushes the whole
// background to black except for star peaks. An earlier version also pooled
// every channel's raw pixel VALUES into one combined array and took a single
// global median/MAD of that, which isn't what PixInsight does either.
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

// Cheap: turn the cached (linked) stats + a target background into a single
// MTF stretch [m, c0, c1], applied identically to every channel.
function finalizeStretch(stats, targetBkg) {
   let avgMedian = stats[0], c0 = Math.min(1, Math.max(0, stats[1]));
   let m = (c0 >= 1) ? 0.0001 : MTF(targetBkg, avgMedian - c0);
   return [m, c0, 1];
}

// ---- Nucleus picker rendering ----------------------------------------------
//
// Each preview (overview or zoom) is built in two phases: prepareOverviewData()/
// prepareZoomData() read the actual pixel data (once per frame, once per
// click), and renderFromPrepared() applies a plain autostretch to it and
// renders a Bitmap - no other processing layered on top, so what's shown
// for picking the nucleus is a straightforward autostretch of the real
// image.

// Downscaled raw (unstretched) channel data for the whole frame, using
// box-averaging (not nearest-neighbor) so single-pixel sensor/read noise is
// suppressed and the comet's diffuse coma is easier to spot than in a raw
// 1:1 view.
function prepareOverviewData(image, maxW) {
   let n = image.numberOfChannels;
   let scale = Math.min(1, maxW / image.width);
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

// Magnified raw (unstretched) crop of a small native-pixel region around
// (cx, cy). Plain nearest-neighbor magnification of the real pixel data -
// no blur or other noise-reduction processing, so what's shown for picking
// the nucleus is a straightforward autostretch of the actual image, nothing
// else layered on top.
function prepareZoomData(image, cx, cy, halfSize, zoomFactor) {
   let n = image.numberOfChannels;
   let cropW = 2 * halfSize, cropH = 2 * halfSize;
   let x0 = Math.round(cx - halfSize), y0 = Math.round(cy - halfSize);
   x0 = Math.max(0, Math.min(image.width - cropW, x0));
   y0 = Math.max(0, Math.min(image.height - cropH, y0));
   let cropRect = new Rect(x0, y0, x0 + cropW, y0 + cropH);
   let outW = cropW * zoomFactor, outH = cropH * zoomFactor;
   let channels = [];
   for (let c = 0; c < n; ++c) {
      let buf = new Float32Array(cropW * cropH);
      image.getSamples(buf, cropRect, c);
      // Nearest-neighbor magnify from crop resolution up to the zoomed
      // output size - renderFromPrepared() expects channel arrays already
      // sized outW*outH, same convention as prepareOverviewData().
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

// Applies the fixed autostretch to already-prepared raw channel data and
// renders it to a Bitmap.
//
// Uses PixInsight's own HistogramTransformation process (via a small
// temporary image window) rather than a hand-rolled per-pixel MTF loop -
// an earlier manual implementation looked visibly worse (murkier, harder to
// pick a faint comet out of) than PixInsight's native stretch on the same
// data with the same computed parameters, for reasons not fully tracked
// down. Using the real process guarantees the same look users already know
// from PixInsight itself.
function renderFromPrepared(prepared, stretch) {
   let small = new Image(prepared.outW, prepared.outH, prepared.n, prepared.n > 1 ? ColorSpace_RGB : ColorSpace_Gray);
   for (let c = 0; c < prepared.n; ++c)
      small.setSamples(prepared.channels[c], new Rect(0, 0, prepared.outW, prepared.outH), c);

   let tmpWin = new ImageWindow(prepared.outW, prepared.outH, prepared.n, 32, true, prepared.n > 1, "cometPickerTmp");
   tmpWin.mainView.beginProcess();
   tmpWin.mainView.image.assign(small);
   tmpWin.mainView.endProcess();

   // Same [m, c0, c1] triple applied to each of R/G/B (PixInsight's "linked"
   // STF behavior) - see computeChannelStats(). The RGB/K row (index 3) and
   // alpha row (index 4) must stay identity: HistogramTransformation applies
   // H[3] as an ADDITIONAL pass on top of the per-channel R/G/B rows, so
   // setting it to the same non-identity curve double-applies the stretch
   // and blows the image out to near-white.
   let hEntry = [stretch[1], stretch[0], stretch[2], 0, 1]; // [c0, m, c1, r0, r1]
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

// Runs AutomaticBackgroundExtractor (subtraction mode, in place) on a view
// before it's used for nucleus-picking. This is what actually fixes the
// uncalibrated color cast, rather than the stretch itself trying to
// compensate for it: ABE models and subtracts each channel's own background
// level independently, so afterward every channel sits near zero background
// and a plain stretch shows a clean neutral background with stars/comet
// visible in natural color - not a manual white-balance hack layered on top
// of the raw data.
function runBackgroundExtraction(view) {
   let P = new AutomaticBackgroundExtractor;
   P.targetCorrection = 1; // Correction_Subtract (verified: toSource() confirms 1 = Subtract)
   P.replaceTarget = true; // modify this view in place instead of creating a separate "_ABE" window
   P.executeOn(view);
}

// Self-contained nucleus picker: click roughly on the comet to zoom in, then
// drag a small precise box around it - releasing the drag confirms and
// closes the dialog immediately (no separate Confirm button). A tap without
// dragging while zoomed in goes back to the full-frame view to re-pick (no
// separate Back button either). Closing the dialog (native X / Escape)
// cancels. Returns [x, y] in native image pixel coordinates, or null if
// cancelled. Never shows or requires interacting with any other PixInsight
// window.
function pickNucleus(filePath, title, subtitle) {
   let w = ImageWindow.open(filePath)[0];
   runBackgroundExtraction(w.mainView);
   let img = w.mainView.image;
   let result = null;

   const VIEWW = 900, VIEWH = 640;
   const ZOOM_HALFSIZE = 110, ZOOM_FACTOR = 3;
   const TAP_TOLERANCE = 6; // px - drags smaller than this count as a tap, not a selection

   let dlg = new Dialog;
   dlg.windowTitle = title;

   // Fixed PixInsight-standard auto-STF stretch (target background 0.25,
   // the same default the real Screen Transfer Function tool uses) -
   // computed once and used for both the overview and every zoom crop. An
   // earlier version exposed this as a user-adjustable slider, but that
   // control never behaved reliably, and the standard auto-stretch already
   // shows a faint coma clearly enough on real data.
   const TARGET_BKG = 0.25;
   let channelStats = computeChannelStats(img, img.numberOfChannels);
   let stretch = finalizeStretch(channelStats, TARGET_BKG);
   let state = { mode: "overview", overviewData: null, overview: null, zoomData: null, zoom: null, dragStart: null, dragCur: null };
   state.overviewData = prepareOverviewData(img, VIEWW);
   state.overview = renderFromPrepared(state.overviewData, stretch);

   const OVERVIEW_HINT = "Click roughly on the comet's nucleus to zoom in.";
   const ZOOM_HINT = "Drag a small box precisely around the nucleus to confirm.\nClick without dragging to go back.";

   let info = new Label(dlg);
   info.text = (subtitle ? subtitle + "\n" : "") + OVERVIEW_HINT;
   info.wordWrapping = true;
   info.minHeight = 48;

   let view = new Control(dlg);
   view.setFixedSize(VIEWW, VIEWH);

   view.onPaint = function(x0, y0, x1, y1) {
      let g = new Graphics(this);
      g.fillRect(0, 0, VIEWW, VIEWH, new Brush(4278190080)); // opaque black
      if (state.mode == "overview") {
         g.drawBitmap(0, 0, state.overview.bitmap);
      } else if (state.zoom) {
         g.drawBitmap(0, 0, state.zoom.bitmap);
         if (state.dragStart && state.dragCur) {
            g.pen = new Pen(4294901760, 2); // opaque red
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
            // A real drag: pin down the nucleus box and confirm right away.
            let z = state.zoom;
            let nx0 = z.x0 + rx0 / z.zoomFactor, ny0 = z.y0 + ry0 / z.zoomFactor;
            let nx1 = z.x0 + rx1 / z.zoomFactor, ny1 = z.y0 + ry1 / z.zoomFactor;
            let rect = new Rect(Math.round(nx0), Math.round(ny0), Math.round(nx1), Math.round(ny1));
            result = weightedCentroidNative(img, rect);
            dlg.ok();
         } else {
            // Just a tap: go back to the full frame to re-pick.
            state.mode = "overview";
            state.dragStart = null; state.dragCur = null;
            info.text = (subtitle ? subtitle + "\n" : "") + OVERVIEW_HINT;
            this.repaint();
         }
      }
      return true;
   };

   dlg.sizer = new VerticalSizer;
   dlg.sizer.margin = 8;
   dlg.sizer.spacing = 6;
   dlg.sizer.add(info);
   dlg.sizer.add(view);
   dlg.adjustToContents();

   let ok = dlg.execute();
   w.forceClose();
   return (ok && result) ? result : null;
}

// ---- Calibration library scanning ------------------------------------------
//
// A calibration root folder can hold a mix of ready-to-use master frames
// (whose filenames encode exp/gain/bin/temp/ir, e.g.
// "dark_exp_15.000000_gain_60_bin_1_20C_stack_17.fits" - these have stripped
// FITS headers, so metadata comes from the filename) and folders of raw
// individual subs (generic names like "tele_0000.fits", full FITS headers,
// "ir" mode only recoverable from the containing folder name). Everything
// is matched against the actual light frames' own header values; if nothing
// matches, that calibration step is simply skipped.

function readFrameMeta(path) {
   let w = ImageWindow.open(path)[0];
   let meta = { camera: null, gain: null, bin: null, exptime: null, temp: null };
   for (let k = 0; k < w.keywords.length; ++k) {
      let kw = w.keywords[k], v = kw.value.toString().replace(/'/g, "").trim();
      if (kw.name == "CAMERA") meta.camera = v;
      else if (kw.name == "GAIN") meta.gain = parseFloat(v);
      else if (kw.name == "XBINNING") meta.bin = parseInt(v, 10);
      else if (kw.name == "EXPTIME") meta.exptime = parseFloat(v);
      else if (kw.name == "DET-TEMP") meta.temp = parseFloat(v);
   }
   w.forceClose();
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

   if (kind == "dark" && (m = name.match(/dark_exp_([\d.]+)_gain_(\d+)_bin_(\d+)_(\d+)C_stack_(\d+)/i))) {
      exptime = parseFloat(m[1]); gain = parseInt(m[2], 10); bin_ = parseInt(m[3], 10); temp = parseFloat(m[4]);
      isMaster = true;
   } else if (kind == "flat" && (m = name.match(/flat_gain_(\d+)_bin_(\d+)(?:_ir_(\d+))?/i))) {
      gain = parseInt(m[1], 10); bin_ = parseInt(m[2], 10); ir = (m[3] !== undefined) ? parseInt(m[3], 10) : null;
      isMaster = true;
   } else if (kind == "bias" && (m = name.match(/bias_gain_(\d+)_bin_(\d+)/i))) {
      gain = parseInt(m[1], 10); bin_ = parseInt(m[2], 10);
      isMaster = true;
   } else {
      // Not a recognizable pre-built master filename - treat as a raw sub
      // and read its own FITS header for authoritative values.
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
   let pool = exact.length > 0 ? exact : cands;
   pool = pool.slice().sort(function(a, b) { return Math.abs(a.temp - targetTemp) - Math.abs(b.temp - targetTemp); });
   return { path: pool[0].path, approxExptime: exact.length == 0, usedExptime: pool[0].exptime, tempDiff: Math.abs(pool[0].temp - targetTemp) };
}

function findBestBias(lib, camera, gain, bin_) {
   let cands = lib.filter(function(r) { return r.kind == "bias" && r.camera == camera && r.gain == gain && r.bin == bin_; });
   if (cands.length == 0) return null;
   cands = cands.slice().sort(function(a, b) { return (b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0); });
   return cands[0];
}

// Returns null (no candidates), {ambiguous:true, options:[...]} (multiple
// IR-mode variants found with no way to know which matches the lights), or
// {ambiguous:false, path:...} (exactly one variant - safe to use).
function findBestFlat(lib, camera, gain, bin_) {
   let cands = lib.filter(function(r) { return r.kind == "flat" && r.camera == camera && r.gain == gain && r.bin == bin_ && r.isMaster; });
   if (cands.length == 0) return null;
   let irValues = {};
   cands.forEach(function(r) { irValues[r.ir] = true; });
   if (Object.keys(irValues).length > 1) return { ambiguous: true, options: cands };
   return { ambiguous: false, record: cands[0] };
}

// ---- Pipeline steps -------------------------------------------------------

// ImageCalibration refuses to use a plain FITS file as a master calibration
// frame unless it carries certain embedded metadata (it errors with "lacks
// required capabilities for master calibration frames"). The pre-built
// master files in a calibration library are often stripped-down FITS with
// no keywords at all (their metadata lives only in the filename, which is
// exactly what classifyCalibFile() already parsed out) - so re-embed the
// values we already know and re-save as XISF before handing the path to
// ImageCalibration.
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

// Subtract matched master dark/bias/flat from each raw light frame (before
// debayering - these calibrations are properties of the raw sensor, so they
// have to be applied to the raw CFA data, not the debayered RGB image).
// Any of masterDarkPath/masterBiasPath/masterFlatPath may be null/omitted;
// only the ones actually found are applied.
function runCalibration(files, workDir, masterDarkPath, masterBiasPath, masterFlatPath) {
   let outDir = workDir + "/0_calibrated";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, "*_c.xisf");
   if (existing.length == files.length) return existing; // already done from a previous run
   let P = new ImageCalibration;
   P.targetFrames = files.map(function(p) { return [true, p]; });
   P.masterDarkEnabled = !!masterDarkPath;
   P.masterDarkPath = masterDarkPath || "";
   P.masterBiasEnabled = !!masterBiasPath;
   P.masterBiasPath = masterBiasPath || "";
   P.masterFlatEnabled = !!masterFlatPath;
   P.masterFlatPath = masterFlatPath || "";
   P.outputDirectory = outDir;
   P.outputPostfix = "_c";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("ImageCalibration failed.");
   return listFiles(outDir, "*_c.xisf");
}

function runDebayer(files, workDir) {
   let outDir = workDir + "/1_debayer";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, "*_d.xisf");
   if (existing.length == files.length) return existing; // already done from a previous run
   let P = new Debayer;
   P.targetItems = files.map(function(p) { return [true, p]; });
   P.outputDirectory = outDir;
   P.outputPostfix = "_d";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("Debayer failed.");
   return listFiles(outDir, "*_d.xisf");
}

function runStarAlignment(files, workDir) {
   let outDir = workDir + "/2_aligned";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let existing = listFiles(outDir, "*_r.xisf");
   if (existing.length == files.length) return existing; // already done from a previous run
   let P = new StarAlignment;
   P.referenceImage = files[0];
   P.referenceIsFile = true;
   P.targets = files.map(function(p) { return [true, true, p]; });
   P.outputDirectory = outDir;
   P.outputPostfix = "_r";
   P.overwriteExistingFiles = true;
   P.generateDrizzleData = false;
   if (!P.executeGlobal()) throw new Error("StarAlignment failed.");
   return listFiles(outDir, "*_r.xisf");
}

function runCometAlignment(files, workDir, x0, y0, x1, y1) {
   let dates = files.map(function(p) {
      let w = ImageWindow.open(p)[0];
      let d = readDateObs(w);
      w.forceClose();
      return d;
   });
   let jds = dates.map(toJD);
   let jd0 = jds[0], jd1 = jds[jds.length - 1];

   // Workaround for CometAlignment's broken non-fixed interpolation:
   // compute every position ourselves and mark all frames "fixed".
   let targetFrames = [];
   for (let i = 0; i < files.length; ++i) {
      let t = (jds[i] - jd0) / (jd1 - jd0);
      let x = x0 + t * (x1 - x0), y = y0 + t * (y1 - y0);
      targetFrames.push([files[i], true, dates[i], jds[i], x, y, true, ""]);
   }

   let outDir = workDir + "/3_comet_aligned";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let P = new CometAlignment;
   P.targetFrames = targetFrames;
   P.referenceIndex = 0;
   P.fitPSF = false; // positions are already exact; PSF-fit refinement is what triggers the NaN bug on noisy real data
   P.outputDirectory = outDir;
   P.outputPostfix = "_ca";
   P.overwriteExistingFiles = true;
   if (!P.executeGlobal()) throw new Error("CometAlignment failed.");
   return listFiles(outDir, "*_ca.xisf");
}

function runStarNet2Batch(files, workDir, nucleusX, nucleusY) {
   let outDir = workDir + "/4_starless";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   let warnings = [];
   for (let i = 0; i < files.length; ++i) {
      let w = ImageWindow.open(files[i])[0];
      let before = peakInRegion(w.mainView, nucleusX, nucleusY, 40);
      let P = new StarNet2;
      P.mask = false;
      P.linear = true;
      P.executeOn(w.mainView);
      let after = peakInRegion(w.mainView, nucleusX, nucleusY, 40);
      if (before > 0 && after / before < 0.4)
         warnings.push(File.extractName(files[i]) + ": nucleus dropped to " + (100 * after / before).toFixed(0) + "% of its original brightness");
      w.saveAs(outDir + "/" + File.extractName(files[i]) + "_sn.xisf", false, false, false, false);
      w.forceClose();
      processEvents();
      gc();
   }
   return { files: listFiles(outDir, "*_sn.xisf"), warnings: warnings };
}

function runIntegration(files) {
   let P = new ImageIntegration;
   P.images = files.map(function(p) { return [true, p, "", ""]; });
   P.inputHints = "";
   P.normalization = 0; // NoNormalization
   P.weightMode = 0;    // DontCare
   // combination = Average, rejection = NoRejection (both defaults)
   P.generateRejectionMaps = false;
   P.evaluateSNR = false;
   if (!P.executeGlobal()) throw new Error("ImageIntegration failed.");
   let w = ImageWindow.windowById(P.integrationImageId);
   w.mainView.id = "cometStackLayer";
   return w;
}

function combine(starWindow, cometWindow) {
   starWindow.mainView.id = "starsLayer";
   let P = new PixelMath;
   P.expression = "max(starsLayer, cometStackLayer)";
   P.useSingleExpression = true;
   P.createNewImage = true;
   P.newImageId = "CometStack_final";
   P.showNewImage = true;
   P.rescale = false;
   P.truncate = true;
   if (!P.executeOn(starWindow.mainView)) throw new Error("PixelMath combine failed.");
   return ImageWindow.windowById("CometStack_final");
}

// ---- UI --------------------------------------------------------------------

function CometStackDialog() {
   this.__base__ = Dialog;
   this.__base__();

   let dlg = this;
   this.inputFiles = [];
   this.workDir = "";
   this.alignedFiles = [];
   this.nucleusFirst = null;
   this.nucleusLast = null;
   this.calibLibrary = [];

   this.windowTitle = "OSC Comet Stacking";
   this.minWidth = 460;
   this.position = new Point(100, 100); // safe on-screen starting position

   this.creditLabel = new Label(this);
   this.creditLabel.text = "by Petar Milevski (2026)";
   this.creditLabel.styleSheet = "font-style: italic; color: gray;";
   this.creditLabel.margin = 6;

   // Step 0 (optional): point at a calibration library root - it's scanned
   // recursively and matched against each light's own FITS header (camera,
   // gain, binning, exposure time, sensor temperature) when step 1 runs.
   // Anything that doesn't have a match (wrong gain, no dark at that temp,
   // ambiguous flat variant, etc.) is simply left uncalibrated.
   this.step0Button = new PushButton(this);
   this.step0Button.text = "(Optional) Select calibration frames folder...";
   this.step0Button.onClick = function() {
      let gdd = new GetDirectoryDialog;
      gdd.caption = "Select folder containing dark/flat/bias frames";
      if (!gdd.execute()) return;
      dlg.status0.text = "Scanning calibration library...";
      processEvents();
      try {
         dlg.calibLibrary = scanCalibrationLibrary(gdd.directory);
         let nDark = dlg.calibLibrary.filter(function(r) { return r.kind == "dark"; }).length;
         let nFlat = dlg.calibLibrary.filter(function(r) { return r.kind == "flat"; }).length;
         let nBias = dlg.calibLibrary.filter(function(r) { return r.kind == "bias"; }).length;
         dlg.status0.text = "Library: " + nDark + " dark, " + nFlat + " flat, " + nBias +
            " bias file(s) found. Matched automatically against your lights in step 1.";
      } catch (e) {
         dlg.status0.text = "ERROR scanning: " + e.message;
         dlg.calibLibrary = [];
      }
   };
   this.status0 = new Label(this);
   this.status0.text = "No calibration folder selected (optional - lights used uncalibrated).";
   this.status0.wordWrapping = true;

   // Step 1: pick folder, then immediately calibrate (if a matching dark/
   // flat/bias was found) + Debayer + StarAlignment
   this.step1Button = new PushButton(this);
   this.step1Button.text = "1. Select light frames folder...";
   this.step1Button.onClick = function() {
      let gdd = new GetDirectoryDialog;
      gdd.caption = "Select folder containing light frames";
      if (!gdd.execute()) return;

      dlg.inputFiles = listFiles(gdd.directory, "*.fits").concat(listFiles(gdd.directory, "*.fit")).concat(listFiles(gdd.directory, "*.xisf"));
      dlg.workDir = gdd.directory + "/CometStack_work";
      if (dlg.inputFiles.length < 3) {
         dlg.status1.text = "Only " + dlg.inputFiles.length + " files found - need at least 3.";
         return;
      }

      dlg.status1.text = dlg.inputFiles.length + " files found.";
      processEvents();
      try {
         let filesToDebayer = dlg.inputFiles;

         if (dlg.calibLibrary.length > 0) {
            dlg.status1.text = "Matching calibration frames...";
            processEvents();
            let lightMeta = readFrameMeta(dlg.inputFiles[0]);
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
               msgs.push("dark " + (darkMatch.approxExptime ? "(closest exptime " + darkMatch.usedExptime + "s) " : "") +
                  "@ " + darkMatch.tempDiff.toFixed(0) + "C off target");
            } else msgs.push("no matching dark");
            if (biasRec) {
               biasPath = materializeMasterFrame(biasRec, dlg.workDir, "bias");
               msgs.push("bias found");
            } else msgs.push("no matching bias");
            if (flatMatch && !flatMatch.ambiguous) {
               flatPath = materializeMasterFrame(flatMatch.record, dlg.workDir, "flat");
               msgs.push("flat found");
            } else if (flatMatch && flatMatch.ambiguous) msgs.push("flat skipped (ambiguous IR mode)");
            else msgs.push("no matching flat");

            if (darkPath || biasPath || flatPath) {
               dlg.status1.text = "Calibration: " + msgs.join(", ") + ". Calibrating lights...";
               processEvents();
               filesToDebayer = runCalibration(dlg.inputFiles, dlg.workDir, darkPath, biasPath, flatPath);
            } else {
               dlg.status1.text = "Calibration: " + msgs.join(", ") + ". Proceeding uncalibrated.";
            }
            processEvents();
         }

         dlg.status1.text += " Running Debayer...";
         processEvents();
         let debayered = runDebayer(filesToDebayer, dlg.workDir);
         dlg.status1.text = dlg.inputFiles.length + " files: running StarAlignment...";
         processEvents();
         dlg.alignedFiles = runStarAlignment(debayered, dlg.workDir);

         dlg.status1.text = dlg.alignedFiles.length + " frames aligned.";
         setHighlight(dlg.step1Button, false);
         dlg.step2Button.enabled = true;
         setHighlight(dlg.step2Button, true);
      } catch (e) {
         dlg.status1.text = "ERROR: " + e.message;
      }
   };
   this.status1 = new Label(this);
   this.status1.text = "No folder selected yet.";
   this.status1.wordWrapping = true;
   setHighlight(this.step1Button, true);

   // Step 2: mark the nucleus in the first frame, then immediately the last
   // frame - one continuous action, two self-contained picker dialogs back
   // to back.
   this.step2Button = new PushButton(this);
   this.step2Button.text = "2. Mark nucleus (first, then last frame)...";
   this.step2Button.enabled = false;
   this.step2Button.onClick = function() {
      try {
         let r1 = pickNucleus(dlg.alignedFiles[0], "Mark comet nucleus", "Frame 1 of 2 (FIRST frame in the sequence)");
         if (!r1) { dlg.status2.text = "Cancelled."; return; }
         dlg.nucleusFirst = r1;
         dlg.status2.text = "First-frame nucleus: (" + r1[0].toFixed(1) + ", " + r1[1].toFixed(1) + "). Now the last frame...";
         processEvents();

         let r2 = pickNucleus(dlg.alignedFiles[dlg.alignedFiles.length - 1], "Mark comet nucleus", "Frame 2 of 2 (LAST frame in the sequence)");
         if (!r2) { dlg.status2.text = "Cancelled after marking the first frame - click this button again to redo both."; return; }
         dlg.nucleusLast = r2;
         dlg.status2.text = "First: (" + r1[0].toFixed(1) + ", " + r1[1].toFixed(1) + ")  Last: (" + r2[0].toFixed(1) + ", " + r2[1].toFixed(1) + ")";
         setHighlight(dlg.step2Button, false);
         dlg.step3Button.enabled = true;
         setHighlight(dlg.step3Button, true);
      } catch (e) { dlg.status2.text = "ERROR: " + e.message; }
   };
   this.status2 = new Label(this);
   this.status2.text = "";
   this.status2.wordWrapping = true;

   // Step 3: run the rest of the pipeline
   this.step3Button = new PushButton(this);
   this.step3Button.text = "3. Run Comet Stack";
   this.step3Button.enabled = false;
   this.step3Button.onClick = function() {
      try {
         setHighlight(dlg.step3Button, false);
         dlg.status3.text = "Running CometAlignment...";
         processEvents();
         let caFiles = runCometAlignment(dlg.alignedFiles, dlg.workDir,
            dlg.nucleusFirst[0], dlg.nucleusFirst[1], dlg.nucleusLast[0], dlg.nucleusLast[1]);

         dlg.status3.text = "Removing stars (StarNet2) from " + caFiles.length + " frames...";
         processEvents();
         let sn = runStarNet2Batch(caFiles, dlg.workDir, dlg.nucleusFirst[0], dlg.nucleusFirst[1]);
         if (sn.warnings.length > 0)
            dlg.status3.text = "Warning: " + sn.warnings.join("; ");

         dlg.status3.text += "\nIntegrating comet stack...";
         processEvents();
         let cometWin = runIntegration(sn.files);

         let starWin = ImageWindow.open(dlg.alignedFiles[0])[0];
         let finalWin = combine(starWin, cometWin);
         applyAutoSTF(finalWin.mainView, 2.8, 0.25);
         finalWin.zoomToFit();
         finalWin.show();
         finalWin.bringToFront();

         let savePath = dlg.workDir + "/CometStack_final.xisf";
         finalWin.saveAs(savePath, false, false, false, false);
         dlg.status3.text = "Done. Saved to " + savePath +
            (sn.warnings.length > 0 ? "\n\nWarnings:\n" + sn.warnings.join("\n") : "");
         setHighlight(dlg.closeButton, true);
      } catch (e) {
         dlg.status3.text = "ERROR: " + e.message;
      }
   };
   this.status3 = new Label(this);
   this.status3.text = "";
   this.status3.wordWrapping = true;

   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { dlg.ok(); };

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(this.creditLabel);
   this.sizer.addSpacing(8);
   this.sizer.add(this.step0Button);
   this.sizer.add(this.status0);
   this.sizer.add(this.step1Button);
   this.sizer.add(this.status1);
   this.sizer.add(this.step2Button);
   this.sizer.add(this.status2);
   this.sizer.add(this.step3Button);
   this.sizer.add(this.status3);
   this.sizer.addSpacing(8);
   this.sizer.add(this.closeButton);
}
CometStackDialog.prototype = new Dialog;

function main() {
   let dialog = new CometStackDialog;
   dialog.execute();
}

main();
