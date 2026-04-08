// Clip Studio - client-side video editor
// Uses ffmpeg.wasm for video processing and transformers.js Whisper for captions.

import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";

// ---------- State ----------
const state = {
  ffmpeg: null,
  ffmpegReady: false,
  sourceFile: null,
  sourceDuration: 0,
  sourceName: "input.mp4",
  lutFile: null,
  lutName: null,
  captions: [], // [{start, end, text}]
  whisperPipeline: null,
};

const PLATFORM_PRESETS = {
  youtube: { w: 1920, h: 1080, fps: 30, label: "YouTube 16:9" },
  tiktok:  { w: 1080, h: 1920, fps: 30, label: "TikTok 9:16" },
  reels:   { w: 1080, h: 1920, fps: 30, label: "Reels 9:16" },
  shorts:  { w: 1080, h: 1920, fps: 30, label: "Shorts 9:16" },
  square:  { w: 1080, h: 1080, fps: 30, label: "Square 1:1" },
};

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $("renderLog");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
};

// ---------- Tab switching ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`.panel[data-panel="${btn.dataset.panel}"]`).classList.add("active");
  });
});

// ---------- FFmpeg bootstrap ----------
async function bootFFmpeg() {
  const statusEl = document.querySelector(".engine-status");
  const label = $("engineLabel");
  try {
    label.textContent = "Loading ffmpeg core…";
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      // Uncomment for verbose debug:
      // console.log("[ffmpeg]", message);
    });
    const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });
    state.ffmpeg = ffmpeg;
    state.ffmpegReady = true;
    statusEl.classList.add("ready");
    label.textContent = "Engine ready";
  } catch (e) {
    console.error(e);
    statusEl.classList.add("error");
    label.textContent = "Engine failed: " + (e.message || e);
  }
}
bootFFmpeg();

// ---------- File upload ----------
const dropzone = $("dropzone");
const fileInput = $("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadSource(f);
});
fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadSource(f);
});

function loadSource(file) {
  state.sourceFile = file;
  state.sourceName = file.name;
  const video = $("previewVideo");
  const url = URL.createObjectURL(file);
  video.src = url;
  video.onloadedmetadata = () => {
    state.sourceDuration = video.duration;
    $("previewEmpty").style.display = "none";
    $("sourceInfo").textContent =
      `File: ${file.name}\nSize: ${(file.size / 1024 / 1024).toFixed(2)} MB\n` +
      `Duration: ${formatTime(video.duration)}\nResolution: ${video.videoWidth}×${video.videoHeight}`;
    $("previewMeta").textContent =
      `${video.videoWidth}×${video.videoHeight} · ${formatTime(video.duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  };
}

// ---------- LUT upload ----------
const lutDrop = $("lutDrop");
const lutInput = $("lutInput");
lutDrop.addEventListener("click", () => lutInput.click());
lutInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.lutFile = f;
  state.lutName = f.name;
  $("lutEnabled").checked = true;
  $("lutInfo").textContent = `Loaded LUT: ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
});

// ---------- Live caption overlay ----------
const video = $("previewVideo");
const captionOverlay = $("captionOverlay");

video.addEventListener("timeupdate", updateLiveCaption);

function updateLiveCaption() {
  if (!state.captions.length) {
    captionOverlay.textContent = "";
    return;
  }
  const t = video.currentTime;
  const active = state.captions.find((c) => t >= c.start && t <= c.end);
  captionOverlay.textContent = active ? transformCase(active.text) : "";
  applyCaptionStyle(captionOverlay);
}

function applyCaptionStyle(el) {
  const font = $("fontFamily").value;
  const size = parseInt($("fontSize").value, 10);
  const color = $("fontColor").value;
  const stroke = $("strokeColor").value;
  const sw = parseInt($("strokeWidth").value, 10);
  const weight = $("fontWeight").value;
  const place = $("captionPlacement").value;
  const ox = parseInt($("captionOffsetX").value, 10);
  const oy = parseInt($("captionOffsetY").value, 10);

  el.style.fontFamily = `"${font}", sans-serif`;
  // Scale font down for preview stage (stage is ~720p max)
  const stageH = $("previewStage").clientHeight || 400;
  const previewScale = stageH / 1080;
  el.style.fontSize = Math.max(12, size * previewScale) + "px";
  el.style.color = color;
  el.style.fontWeight = weight;
  el.style.textShadow = `
    -${sw}px -${sw}px 0 ${stroke},
    ${sw}px -${sw}px 0 ${stroke},
    -${sw}px ${sw}px 0 ${stroke},
    ${sw}px ${sw}px 0 ${stroke},
    0 0 6px rgba(0,0,0,0.6)`;

  // Placement
  el.style.top = "auto"; el.style.bottom = "auto";
  if (place === "top") el.style.top = `${10 + oy}%`;
  else if (place === "center") el.style.top = `${45 + oy}%`;
  else el.style.bottom = `${10 - oy}%`;
  el.style.transform = `translateX(${ox}%)`;
}

function transformCase(text) {
  const mode = $("fontCase").value;
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text;
}

// Re-apply styles when user changes settings
["fontFamily","fontSize","fontColor","strokeColor","strokeWidth","fontWeight","fontCase","captionPlacement","captionOffsetX","captionOffsetY"]
  .forEach((id) => $(id).addEventListener("input", () => applyCaptionStyle(captionOverlay)));

// ---------- Whisper captions ----------
$("generateCaptionsBtn").addEventListener("click", generateCaptions);

async function generateCaptions() {
  if (!state.sourceFile) { alert("Upload footage first."); return; }
  const engine = $("captionEngine").value;
  if (engine === "manual") {
    parseManualTranscript();
    return;
  }
  const progress = $("captionProgress");
  progress.textContent = "Loading Whisper model (first run downloads ~40MB)…";
  try {
    // Extract audio to wav via ffmpeg first for accurate transcription
    if (!state.ffmpegReady) { progress.textContent = "Engine not ready"; return; }
    const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
    env.allowLocalModels = false;
    if (!state.whisperPipeline) {
      state.whisperPipeline = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
        progress_callback: (d) => {
          if (d.status === "progress") {
            progress.textContent = `Downloading ${d.file}: ${Math.round(d.progress || 0)}%`;
          }
        },
      });
    }
    progress.textContent = "Extracting audio…";
    const ffmpeg = state.ffmpeg;
    await ffmpeg.writeFile("src_for_audio", await fetchFile(state.sourceFile));
    await ffmpeg.exec(["-i", "src_for_audio", "-ac", "1", "-ar", "16000", "-f", "wav", "audio.wav"]);
    const wav = await ffmpeg.readFile("audio.wav");
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(ab);
    // Resample if context didn't honor 16kHz (Safari quirk)
    let samples = decoded.getChannelData(0);
    if (decoded.sampleRate !== 16000) {
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      samples = rendered.getChannelData(0);
    }

    progress.textContent = "Transcribing…";
    const result = await state.whisperPipeline(samples, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const chunks = result.chunks || [];
    state.captions = chunks
      .filter((c) => c.timestamp && c.timestamp[0] != null)
      .map((c) => ({
        start: c.timestamp[0],
        end: c.timestamp[1] ?? (c.timestamp[0] + 2),
        text: (c.text || "").trim(),
      }));
    renderTranscriptEditor();
    progress.textContent = `Done. ${state.captions.length} caption segments.`;
    try { ffmpeg.deleteFile("src_for_audio"); } catch {}
    try { ffmpeg.deleteFile("audio.wav"); } catch {}
  } catch (e) {
    console.error(e);
    progress.textContent = "Caption error: " + (e.message || e);
  }
}

function renderTranscriptEditor() {
  const ta = $("transcript");
  ta.value = state.captions
    .map((c) => `[${formatTime(c.start)} --> ${formatTime(c.end)}] ${c.text}`)
    .join("\n");
}

function parseManualTranscript() {
  const ta = $("transcript");
  const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
  const re = /^\[(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+(?:\.\d+)?)\]\s*(.+)$/;
  state.captions = [];
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    state.captions.push({
      start: parseInt(m[1]) * 60 + parseFloat(m[2]),
      end: parseInt(m[3]) * 60 + parseFloat(m[4]),
      text: m[5],
    });
  }
  $("captionProgress").textContent = `Parsed ${state.captions.length} captions.`;
}

$("transcript").addEventListener("blur", parseManualTranscript);

function formatTime(s) {
  if (!isFinite(s)) return "00:00.00";
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${sec}`;
}

// ---------- Clip planning ----------
function planClips() {
  const dur = state.sourceDuration;
  const mode = $("clipMode").value;
  let min = clampSec(parseInt($("clipMin").value, 10) || 30);
  let max = clampSec(parseInt($("clipMax").value, 10) || 60);
  if (max < min) max = min;

  const clips = [];
  if (mode === "fixed") {
    const len = min;
    for (let t = 0; t < dur; t += len) {
      const end = Math.min(t + len, dur);
      if (end - t >= Math.min(30, dur)) clips.push({ start: t, end });
    }
  } else if (mode === "range") {
    let t = 0;
    while (t < dur) {
      const len = min + Math.random() * (max - min);
      const end = Math.min(t + len, dur);
      if (end - t >= Math.min(30, dur - t)) clips.push({ start: t, end });
      t = end;
    }
  } else {
    // scene mode — we treat min/max as constraint bounds, fall back to fixed for now
    // Real scene detection would run a pre-pass; we provide a ffmpeg-based pass in render.
    const len = Math.floor((min + max) / 2);
    for (let t = 0; t < dur; t += len) {
      const end = Math.min(t + len, dur);
      if (end - t >= Math.min(30, dur)) clips.push({ start: t, end });
    }
  }
  return clips;
}

function clampSec(s) { return Math.max(30, Math.min(600, s)); }

// ---------- Subtitle file generation (ASS) ----------
function buildAssFile(captions, clipStart, clipEnd, preset) {
  const font = $("fontFamily").value;
  const size = parseInt($("fontSize").value, 10);
  const color = $("fontColor").value;
  const stroke = $("strokeColor").value;
  const sw = parseInt($("strokeWidth").value, 10);
  const weightVal = $("fontWeight").value;
  const bold = weightVal >= 700 ? -1 : 0;
  const place = $("captionPlacement").value;
  const ox = parseInt($("captionOffsetX").value, 10);
  const oy = parseInt($("captionOffsetY").value, 10);
  const anim = $("animEntrance").value;
  const speed = $("animSpeed").value;

  // Alignment: 2=bottom center, 5=top center, 8=center (ASS numpad)
  // Using ASS numpad style: 1..9 where 2=bottom, 5=middle, 8=top
  const alignMap = { bottom: 2, center: 5, top: 8 };
  const align = alignMap[place] || 2;

  // Margins
  const marginV = Math.round(preset.h * 0.1);
  const marginH = Math.round(preset.w * 0.05);

  // Colors to ASS BGR hex
  const primary = hexToAssColor(color);
  const outline = hexToAssColor(stroke);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${preset.w}
PlayResY: ${preset.h}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${font},${size},${primary},&H00FFFFFF,${outline},&H80000000,${bold},0,0,0,100,100,0,0,1,${sw},0,${align},${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const speedMs = { fast: 200, medium: 400, slow: 800 }[speed] || 400;

  // Shift captions into clip-relative time window
  const events = [];
  for (const c of captions) {
    if (c.end <= clipStart || c.start >= clipEnd) continue;
    const s = Math.max(0, c.start - clipStart);
    const e = Math.min(clipEnd - clipStart, c.end - clipStart);
    if (e <= s) continue;
    let text = transformCase(c.text).replace(/\n/g, "\\N");
    text = escapeAssText(text);
    // Apply entrance tag
    let tag = "";
    if (anim === "fade") tag = `{\\fad(${speedMs},0)}`;
    else if (anim === "slide-up") tag = `{\\move(${preset.w/2},${preset.h+100},${preset.w/2},${preset.h - marginV},0,${speedMs})}`;
    else if (anim === "pop") tag = `{\\fscx50\\fscy50\\t(0,${speedMs},\\fscx100\\fscy100)}`;
    else if (anim === "typewriter") {
      // Fake typewriter via char-by-char fade
      const per = Math.max(30, speedMs / Math.max(1, text.length));
      let out = "";
      for (let i = 0; i < text.length; i++) {
        out += `{\\alpha&HFF&\\t(${Math.round(i*per)},${Math.round(i*per+per)},\\alpha&H00&)}${text[i]}`;
      }
      text = out;
    } else if (anim === "karaoke") {
      // Basic karaoke-style word highlight
      const words = text.split(" ");
      const total = (e - s) * 100; // centiseconds
      const per = Math.round(total / Math.max(1, words.length));
      text = words.map((w) => `{\\k${per}}${w}`).join(" ");
    }

    events.push(
      `Dialogue: 0,${toAssTime(s)},${toAssTime(e)},Main,,${marginH},${marginH},${marginV},,${tag}${text}`
    );

    // Apply offset X/Y via \pos override if needed
    // (skipped for simplicity; margins + alignment cover the common cases)
  }
  return header + events.join("\n") + "\n";
}

function hexToAssColor(hex) {
  const h = hex.replace("#", "");
  const r = h.substring(0, 2);
  const g = h.substring(2, 4);
  const b = h.substring(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function escapeAssText(t) {
  return t.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function toAssTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}

// ---------- Build video filter chain ----------
function buildFilterChain(preset, hasAss, hasLut, lutIntensity) {
  const cropFocus = $("cropFocus").value;
  // scale to cover then crop to target aspect
  let y = "(ih-oh)/2";
  if (cropFocus === "top") y = "0";
  if (cropFocus === "bottom") y = "ih-oh";

  const parts = [];
  parts.push(`scale=${preset.w}:${preset.h}:force_original_aspect_ratio=increase`);
  parts.push(`crop=${preset.w}:${preset.h}:(iw-ow)/2:${y}`);
  parts.push(`fps=${preset.fps}`);
  parts.push("setsar=1");

  if (hasLut) {
    // lut3d filter — uses simple filename form for max compatibility
    parts.push(`lut3d=lut.cube`);
  }

  // Clip entrance/exit
  const ce = $("clipEntrance").value;
  const cex = $("clipExit").value;
  const speed = { fast: 0.2, medium: 0.4, slow: 0.8 }[$("animSpeed").value] || 0.4;
  if (ce === "fade") parts.push(`fade=t=in:st=0:d=${speed}`);
  if (ce === "zoom") parts.push(`zoompan=z='min(zoom+0.002,1.1)':d=1:s=${preset.w}x${preset.h}`);
  if (cex === "fade") parts.push(`fade=t=out:st=MAX_END:d=${speed}`); // placeholder replaced per-clip

  if (hasAss) parts.push("ass=subs.ass");

  return parts.join(",");
}

// ---------- Render / export pipeline ----------
$("exportBtn").addEventListener("click", renderClips);

async function renderClips() {
  if (!state.sourceFile) { alert("Upload footage first."); return; }
  if (!state.ffmpegReady) { alert("Engine not ready yet."); return; }
  const btn = $("exportBtn");
  btn.disabled = true;
  $("renderLog").textContent = "";
  $("renderResults").innerHTML = "";

  try {
    const ffmpeg = state.ffmpeg;
    const preset = PLATFORM_PRESETS[getPlatform()];
    const clips = planClips();
    log(`Planned ${clips.length} clip(s) for
