#feature-id CometStack > CometStack

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
 * Workflow: Debayer -> StarAlignment -> mark nucleus in first/last frame
 * (via a self-contained click-to-zoom-then-drag picker, entirely inside this
 * dialog - no need to interact with separate PixInsight image windows) ->
 * CometAlignment -> StarNet2 -> ImageIntegration -> stars-only isolation and
 * screen blend with the comet stack.
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
      "2. Debayer & StarAlignment: Converts OSC frames to color (_d.xisf)\n" +
      "   and aligns stars to the first frame (_r.xisf), then sorts frames\n" +
      "   chronologically by Julian Date derived from DATE-OBS.\n" +
      "3. Nucleus Marking (First & Last Frame): Opens an embedded picker\n" +
      "   with AutomaticBackgroundExtractor + screen stretch so you can click\n" +
      "   roughly on the nucleus, zoom in, and drag a box around it on the\n" +
      "   first and last frames. A brightness-weighted centroid refines each\n" +
      "   position, and stacking begins automatically after frame 2.\n" +
      "4. CometAlignment (Custom JD Interpolation): Computes linear nucleus\n" +
      "   positions across frames by Julian Date and passes every frame as\n" +
      "   'fixed' to CometAlignment (_ca.xisf), avoiding PixInsight's broken\n" +
      "   built-in non-fixed interpolation.\n" +
      "5. Batch StarNet2 Removal: Runs StarNet2 on each comet-aligned frame\n" +
      "   (_sn.xisf), monitors nucleus peak brightness for over-removal\n" +
      "   warnings, and calls processEvents() + gc() between frames to\n" +
      "   prevent memory/stability crashes.\n" +
      "6. Starless Comet Integration: Integrates the starless comet frames\n" +
      "   into 'cometStackLayer' so the comet and tail stack cleanly without\n" +
      "   star trails.\n" +
      "7. Star Isolation & Screen Blend: Runs StarNet2 on a copy of the\n" +
      "   star-aligned reference frame, isolates stars via:\n" +
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
   let d = readDateObs(w);
   w.forceClose();
   return d;
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
   const ZOOM_HALFSIZE = 110, ZOOM_FACTOR = 3;
   const TAP_TOLERANCE = 6;

   let dlg = new Dialog;
   dlg.windowTitle = title;

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

function runCalibration(files, workDir, masterDarkPath, masterBiasPath, masterFlatPath) {
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

function runCometAlignment(entries, workDir, x0, y0, x1, y1) {
   let jd0 = entries[0].jd;
   let jd1 = entries[entries.length - 1].jd;
   let dt = jd1 - jd0;

   // Workaround for CometAlignment's broken non-fixed interpolation:
   // compute every position ourselves and mark all frames "fixed".
   let targetFrames = [];
   for (let i = 0; i < entries.length; ++i) {
      let t = (dt > 0) ? (entries[i].jd - jd0) / dt : 0;
      let x = x0 + t * (x1 - x0), y = y0 + t * (y1 - y0);
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

function runStarNet2Batch(files, workDir, nucleusX, nucleusY, logFn) {
   let outDir = workDir + "/4_starless";
   if (!File.directoryExists(outDir)) File.createDirectory(outDir, true);
   clearDirFiles(outDir);

   if (logFn) {
      logFn("   NOTE: StarNet2 star removal can take a very long time depending on your computer's speed and image size.");
   }

   let warnings = [];
   let firstFrameSec = null;

   for (let i = 0; i < files.length; ++i) {
      let tStart = Date.now();
      if (logFn) logFn("   StarNet2 [" + (i + 1) + "/" + files.length + "]: " + File.extractName(files[i]));
      processEvents();
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
      if (i === 0) {
         firstFrameSec = elapsedSec;
         let remainingFrames = files.length - 1;
         if (logFn && remainingFrames > 0) {
            let estRemainingSec = firstFrameSec * remainingFrames;
            logFn("   First frame took " + formatDuration(firstFrameSec) + ". Estimated time remaining for " + remainingFrames + " frame(s): ~" + formatDuration(estRemainingSec) + ".");
         }
      }

      processEvents();
      gc();
   }
   return { files: listFiles(outDir, /_sn\.xisf$/i), warnings: warnings };
}

function runIntegration(files) {
   let P = new ImageIntegration;
   P.images = files.map(function(p) { return [true, p, "", ""]; });
   P.inputHints = "";
   P.normalization = 0; // NoNormalization
   P.weightMode = 0;    // DontCare
   P.generateRejectionMaps = false;
   P.evaluateSNR = false;
   if (!P.executeGlobal()) throw new Error("ImageIntegration failed.");
   let w = ImageWindow.windowById(P.integrationImageId);
   w.mainView.id = "cometStackLayer";
   return w;
}

// Isolates stars from the star-aligned reference frame by subtracting its
// StarNet2 starless version, then screen-blends starsOnly over cometStackLayer
// so single-frame background noise does not clip into the comet via max().
function combine(refStarPath, cometWindow, workDir) {
   let starWin = ImageWindow.open(refStarPath)[0];
   let starlessWin = ImageWindow.open(refStarPath)[0];
   let keepCometWindow = false;
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
         let blendPM = new PixelMath;
         blendPM.expression = "1 - (1 - cometStackLayer) * (1 - starsOnlyLayer)";
         blendPM.useSingleExpression = true;
         blendPM.createNewImage = true;
         blendPM.newImageId = "CometStack_final";
         blendPM.showNewImage = true;
         blendPM.rescale = false;
         blendPM.truncate = true;
         if (!blendPM.executeOn(cometWindow.mainView)) {
            keepCometWindow = true;
            throw new Error("PixelMath screen blend failed.");
         }
         return ImageWindow.windowById("CometStack_final");
      } finally {
         if (starsOnlyWin) starsOnlyWin.forceClose();
      }
   } finally {
      if (!keepCometWindow && cometWindow) cometWindow.forceClose();
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
   this.nucleusFirst = null;
   this.nucleusLast = null;
   this.calibLibrary = [];
   this.isRunning = false;
   this.isCompleted = false;

   this.windowTitle = "OSC Comet Stacking";
   this.minWidth = 540;
   this.position = new Point(100, 100);

   this.log = function(line) {
      let now = new Date();
      let stamp = "[" + pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds()) + "] ";
      let cur = dlg.logBox.text;
      dlg.logBox.text = cur ? (cur + "\n" + stamp + line) : (stamp + line);
      processEvents();
   };

   this.setControlsBusy = function(busy) {
      dlg.isRunning = busy;
      dlg.step0Button.enabled = !busy;
      dlg.step1Button.enabled = !busy;
      dlg.step2Button.enabled = !busy && !dlg.isCompleted && dlg.orderedEntries.length >= 3;
      dlg.closeButton.enabled = !busy;
   };

   // Header + Info button right next to heading title
   this.headerLabel = new Label(this);
   this.headerLabel.text = "OSC Comet Stacking";
   this.headerLabel.styleSheet = "font-size: 13pt; font-weight: bold;";

   this.infoButton = new PushButton(this);
   this.infoButton.text = "Info / Process";
   this.infoButton.toolTip = "View PixInsight requirements (such as StarNet2) and a rundown of how stacking works";
   this.infoButton.styleSheet = "QPushButton { padding: 3px 8px; font-size: 9pt; }";
   this.infoButton.onClick = function() {
      showInfoDialog(dlg);
   };

   let headerSizer = new HorizontalSizer;
   headerSizer.spacing = 8;
   headerSizer.add(this.headerLabel);
   headerSizer.add(this.infoButton);
   headerSizer.addStretch();

   this.creditLabel = new Label(this);
   this.creditLabel.text = "by Petar Milevski (2026)  •  Automated post-nucleus stack & screen blend";
   this.creditLabel.styleSheet = "font-style: italic; color: #777777;";

   // Group 1: Inputs & Preparation
   this.prepGroup = new GroupBox(this);
   this.prepGroup.title = "1. Calibration & Light Frames";

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
   this.status0.styleSheet = "color: #666666;";

   this.step1Button = new PushButton(this.prepGroup);
   this.step1Button.text = "Select Light Frames Folder...";
   setHighlight(this.step1Button, true);
   this.step1Button.onClick = function() {
      let gdd = new GetDirectoryDialog;
      gdd.caption = "Select folder containing light frames";
      if (!gdd.execute()) return;

      dlg.isCompleted = false;
      setHighlight(dlg.closeButton, false);
      dlg.setControlsBusy(true);
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
         let filesToDebayer = dlg.inputFiles;

         if (dlg.calibLibrary.length > 0) {
            dlg.status1.text = "Matching calibration frames...";
            dlg.log("Matching calibration frames against light metadata...");
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
                  "@ " + darkMatch.tempDiff.toFixed(0) + "°C diff");
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
               dlg.status1.text = "Calibrating (" + msgs.join(", ") + ")...";
               dlg.log("Running ImageCalibration...");
               filesToDebayer = runCalibration(dlg.inputFiles, dlg.workDir, darkPath, biasPath, flatPath);
            } else {
               dlg.log("No applicable calibration frames matched; proceeding uncalibrated.");
            }
         }

         dlg.status1.text = "Running Debayer...";
         dlg.log("Running Debayer on " + filesToDebayer.length + " frames...");
         let debayered = runDebayer(filesToDebayer, dlg.workDir);

         dlg.status1.text = "Running StarAlignment...";
         dlg.log("Running StarAlignment on " + debayered.length + " debayered frames...");
         let aligned = runStarAlignment(debayered, dlg.workDir);

         dlg.log("Sorting aligned frames chronologically by DATE-OBS...");
         dlg.orderedEntries = sortFilesChronologically(aligned);

         let doneMsg = dlg.orderedEntries.length + " frames aligned & ordered.";
         dlg.status1.text = doneMsg;
         dlg.log(doneMsg);

         setHighlight(dlg.step1Button, false);
         dlg.step2Button.enabled = true;
         setHighlight(dlg.step2Button, true);
      } catch (e) {
         dlg.status1.text = "Preparation failed.";
         showErrorDialog("Light Preparation", e, dlg.log);
      } finally {
         dlg.setControlsBusy(false);
         if (!dlg.isCompleted && dlg.orderedEntries.length >= 3) {
            setHighlight(dlg.step2Button, true);
         }
      }
   };

   this.status1 = new Label(this.prepGroup);
   this.status1.text = "Waiting for light frames folder.";
   this.status1.wordWrapping = true;

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
   this.cometGroup.title = "2. Comet Nucleus & Automatic Stacking";

   this.step2Button = new PushButton(this.cometGroup);
   this.step2Button.text = "Mark Nucleus (First, then Last Frame) & Run";
   this.step2Button.enabled = false;
   setHighlight(this.step2Button, false);

   this.status2 = new Label(this.cometGroup);
   this.status2.text = "Complete step 1 to enable nucleus selection.";
   this.status2.wordWrapping = true;

   this.step2Button.onClick = function() {
      dlg.setControlsBusy(true);
      setHighlight(dlg.step2Button, false);
      try {
         let firstPath = dlg.orderedEntries[0].path;
         let lastPath = dlg.orderedEntries[dlg.orderedEntries.length - 1].path;

         dlg.log("Opening first frame for nucleus selection...");
         let r1 = pickNucleus(firstPath, "Mark comet nucleus", "Frame 1 of 2 (FIRST frame in chronological sequence)");
         if (!r1) {
            dlg.status2.text = "Cancelled on first frame.";
            dlg.log("Nucleus selection cancelled on first frame.");
            return;
         }
         dlg.nucleusFirst = r1;
         dlg.status2.text = "First: (" + r1[0].toFixed(1) + ", " + r1[1].toFixed(1) + ") — select last frame...";
         dlg.log("First nucleus marked at (" + r1[0].toFixed(1) + ", " + r1[1].toFixed(1) + ").");

         let r2 = pickNucleus(lastPath, "Mark comet nucleus", "Frame 2 of 2 (LAST frame in chronological sequence)");
         if (!r2) {
            dlg.status2.text = "Cancelled on last frame — click button again to redo both.";
            dlg.log("Nucleus selection cancelled on second frame.");
            return;
         }
         dlg.nucleusLast = r2;
         dlg.status2.text = "First: (" + r1[0].toFixed(1) + ", " + r1[1].toFixed(1) + ")  |  Last: (" + r2[0].toFixed(1) + ", " + r2[1].toFixed(1) + ")";
         dlg.log("Last nucleus marked at (" + r2[0].toFixed(1) + ", " + r2[1].toFixed(1) + "). Starting Comet Stack automatically...");
         processEvents();

         dlg.status2.text = "Running CometAlignment...";
         dlg.log("Running CometAlignment...");
         let caFiles = runCometAlignment(dlg.orderedEntries, dlg.workDir,
            dlg.nucleusFirst[0], dlg.nucleusFirst[1], dlg.nucleusLast[0], dlg.nucleusLast[1]);
         dlg.log("CometAlignment produced " + caFiles.length + " aligned frames.");

         dlg.status2.text = "Running StarNet2 on " + caFiles.length + " frames...";
         dlg.log("Removing stars with StarNet2...");
         let sn = runStarNet2Batch(caFiles, dlg.workDir, dlg.nucleusFirst[0], dlg.nucleusFirst[1], dlg.log);

         dlg.status2.text = "Integrating starless comet frames...";
         dlg.log("Running ImageIntegration on starless frames...");
         let cometWin = runIntegration(sn.files);

         dlg.status2.text = "Isolating stars and screen-blending...";
         dlg.log("Isolating reference stars and blending over comet stack...");
         let finalWin = combine(dlg.orderedEntries[0].path, cometWin, dlg.workDir);
         applyAutoSTF(finalWin.mainView, 2.8, 0.25);
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
         dlg.status2.text = "Stacking failed — see error dialog or log.";
         showErrorDialog("Comet Stack", e, dlg.log);
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

   this.logBox = new TextBox(this.logGroup);
   this.logBox.readOnly = true;
   this.logBox.setFixedHeight(165);
   this.logBox.styleSheet = "font-family: monospace; font-size: 9pt;";

   this.logGroup.sizer = new VerticalSizer;
   this.logGroup.sizer.margin = 10;
   this.logGroup.sizer.spacing = 6;
   this.logGroup.sizer.add(this.logBox);

   // Footer
   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   setHighlight(this.closeButton, false);
   this.closeButton.onClick = function() {
      if (!dlg.isRunning) dlg.ok();
   };

   let footerSizer = new HorizontalSizer;
   footerSizer.addStretch();
   footerSizer.add(this.closeButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 8;
   this.sizer.add(headerSizer);
   this.sizer.add(this.creditLabel);
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
