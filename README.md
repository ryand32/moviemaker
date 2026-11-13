# 🎬 ClipForge — Browser Video Editor

**ClipForge** is a zero-install, zero-dependency browser video editor (a fast, lightweight Windows Movie Maker alternative) built with plain HTML5 Canvas, Web Audio API, and `MediaRecorder`. Everything runs 100% locally in your browser — your videos and images are never uploaded anywhere.

---

## Quick Start

1. Open [`./index.html`](./index.html) in **Google Chrome** or **Microsoft Edge** (double-click `index.html` or open it via any local static server).
2. Click **`+ Media`** (or drag & drop video, image, and audio files anywhere into the window) to import clips.
3. Double-click a media card (or drag it onto a track) to add it to the timeline.
4. Edit, preview, and click **`Export MP4`** to render and download an H.264 `.mp4` video.

### Project Files

| File | Purpose |
| :--- | :--- |
| [`./index.html`](./index.html) | Editor layout, toolbar, preview stage, media/overlay library, timeline, and export dialog |
| [`./style.css`](./style.css) | Dark theme, multitrack timeline styling, cut-zone highlights, crop handles, and scrollbar layout |
| [`./app.js`](./app.js) | Timeline engine, media sync, Point A→B cutting & stitching, overlays/shapes, cropping, project save/load, and MP4/WebM export |

---

## Features

### 1. Media, Images, Logos, Stickers & Shapes
- **Videos, Images & Audio**: Import `.mp4`, `.webm`, `.mov`, `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.mp3`, `.wav`, `.m4a`, `.ogg`, and `.flac`.
- **One-Click `+ Image` Overlay**: Click **`+ Image`** to pick a photo, transparent PNG logo, or watermark and place it directly onto **`Overlay (V2)`** at the current playhead on top of your main video.
- **`Ctrl+V` Clipboard Paste**: Copy any screenshot (`Win+Shift+S`), image, or graphic to your clipboard and press **`Ctrl+V`** to paste it straight onto your video at the playhead.
- **Built-in Shapes, Callouts & Stickers**:
  - **Shapes**: Highlight **Box** (`⬜`), **Circle** (`⭕`), rotatable **Arrow** (`➜`), and solid **Censor / Blackout** bar (`⬛`) with customizable color, thickness, and aspect ratio.
  - **Callout Banners & Stickers**: Styled text callout boxes (`💬 Callout`) and scalable emoji stickers (`⭐`, `🔥`, `✅`, `⚠️`, `👍`).
- **Direct Preview Drag & Resize**:
  - Click and drag any image, text, callout, or shape **directly on the video preview canvas** to position it.
  - Scroll the mouse wheel over a selected overlay on the preview canvas to scale it up or down.
  - One-click **Placement Presets** in Properties: **`↖ Top-L`**, **`↗ Top-R`**, **`↙ Bot-L`**, **`↘ Bot-R`**, **`⌖ Center`**, **`⛶ Full`**, plus **`↔ Span Entire Video`** to turn any image or text into a full-video watermark.

### 2. Cutting Sections (`Point A → Point B`) & Trimming
- **Point A → Point B Slicing (`HH:MM:SS`)**:
  - **Method 1 — Drag on Clip**: Click **`✂ Drag-Cut Tool`** (`R`) or hold **`Shift`**, then click and drag from **Point A** to **Point B** directly across your video clip.
  - **Method 2 — Playhead Marks**: Move the play pointer to where the cut starts and click **`[ Cut Start (A)`** (`I` or `[`), move to where the cut ends and click **`Cut End (B) ]`** (`O` or `]`).
  - **Method 3 — Exact `HH:MM:SS` Timestamps**: Type exact `HH:MM:SS` timestamps (e.g. `00:01:15` to `00:02:05`) into **Point A** and **Point B** in the right-hand **Properties** panel.
- **Visual Red Cut Highlight**:
  - Sections marked for removal are highlighted in **red diagonal stripes** on the timeline and flagged on the preview stage (`✂ WILL BE REMOVED`) when scrubbed over.
  - Click **`✂ Cut & Stitch`** (right inside the red timeline box, in the toolbar, or press **`Enter`**) to delete `Point A → Point B` and seamlessly stitch the before and after segments together.
- **Start / End Trimming**:
  - **`⇥ Cut 0:00→Here`** & **`⇤ Cut Here→End`** select from the beginning or to the end of the video.
  - **`✂ Keep Only A→B`** crops the timeline to keep *only* `Point A → Point B` and discard both ends.
  - Dragging the left or right edge of any clip on the timeline trims that clip directly.

### 3. Playback Speed & Timeline Navigation
- **Live Preview Speeds**: Switch between **`0.5×`**, **`1×`**, **`1.5×`**, **`2×`**, and **`2.5×`** in the transport bar at any time (even mid-playback) with pitch-preserved audio.
- **Permanent Clip / Export Speeds**: Set **`0.5×`–`2.5×`** (or `0.25×`–`4×` slider) per clip or click **`Apply to all`** under *Audio & speed* in Properties to speed up the exported video itself.
- **Easy Long-Video Navigation**:
  - Drag the **red play pointer** directly on the timeline (auto-scrolls across pages at screen edges).
  - Use the **full-video scrub bar** right below the preview canvas to jump anywhere in multi-hour videos immediately.
  - Scroll horizontally with your **mouse wheel**, flip pages with **`◀ Page`** / **`Page ▶`** (`PageUp` / `PageDown`), jump to the play pointer with **`⌖ Pointer`**, or fit the entire movie onto one screen with **`↔ Fit`**.

### 4. Interactive Frame Cropping & Color Adjustments
- Click **`⌗ Crop Frame`** (`C`) to open draggable 8-handle frame cropping directly over the video preview with **`Freeform`**, **`16:9`**, **`9:16`**, **`1:1`**, and **`4:3`** presets, plus **`Apply start→finish`** to copy the frame crop to every clip in the project.
- Per-clip **Brightness**, **Contrast**, **Saturation**, **Grayscale**, **Blur**, **Opacity**, **Rotation**, **Flip H/V**, and **Fade In / Fade Out**.

### 5. Saving Projects & Exporting `.mp4`
- **Export MP4 / WebM**: Defaults to **`MP4 (.mp4)`** (H.264 + AAC in Chrome/Edge) or **`WebM (.webm)`**. Saves `<video-name>-edited.mp4` to your `Downloads` folder and provides a **`Save As…`** button to pick any folder on disk.
- **Save / Open Project (`.clipforge.json`)**: Saves your timeline edits, cuts, overlays, crops, text, shapes, and canvas resolution. Re-import source media files after reopening to auto-relink clips by filename.

---

## Track Layering

| Track | Role | Stacking |
| :--- | :--- | :--- |
| **Overlay (V2)** | Images, PNG logos/watermarks, text, callouts, stickers, shapes, PiP videos | Rendered **on top of** `Video 1` |
| **Video 1** | Primary video / slideshow track | Base visual layer |
| **Audio 1** | Music, voiceover, or detached audio | Mixed with video audio |
| **Audio 2** | Secondary music / sound effects | Mixed with `Audio 1` & video audio |

Use the **👁** (hide track) and **🔊** (mute track) toggles on each track header to solo or mute layers.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `I` or `[` | Set **Point A** (`Cut Start`) at play pointer |
| `O` or `]` | Set **Point B** (`Cut End`) at play pointer |
| `R` | Toggle **`✂ Drag-Cut Tool`** (drag directly on clips to mark `A → B`) |
| `Enter` | Apply **`✂ Cut & Stitch`** (or finish Frame Crop mode) |
| `X` | Cut `Point A → Point B` (`Shift+X` to lift without closing gap) |
| `S` | Split clip at play pointer |
| `C` | Toggle interactive **`⌗ Crop Frame`** mode |
| `Ctrl+V` | Paste image from clipboard onto `Overlay (V2)` at play pointer |
| `Ctrl+D` | Duplicate selected clip |
| `Delete` / `Backspace` | Delete selected clip (`Shift+Delete` to ripple-delete and close gap) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `←` / `→` | Step 1 frame back / forward (`Shift+←` / `Shift+→` for 1 second) |
| `PageUp` / `PageDown` | Scroll timeline 1 page left / right |
| `Home` / `End` | Jump to start (`00:00:00`) / end of video |
| `Escape` | Exit Crop / Drag-Cut mode or clear `Point A → B` marks |

---

## Mobile & Touch Support

- **Responsive Workspace Tabs (`<= 960px`)**: On phones and tablets, a bottom navigation bar switches cleanly between **`🎬 Editor`** (Video Preview + Timeline), **`📁 Media & Add`**, and **`⚙ Properties`** (with an active selection indicator dot), while desktop screens keep the full 3-column layout.
- **Touch Gestures**:
  - Tap any media card (or its **`+`** button) on mobile to place it onto the timeline and jump straight back to **`🎬 Editor`**.
  - **1-finger drag** moves overlays on the preview canvas, drags the red play pointer, adjusts `Point A` / `Point B` cut handles, and trims or repositions clips.
  - **2-finger pinch** on the timeline zooms in and out; **1-finger swipe** scrolls the timeline and single-row editing toolbar horizontally.
  - Adapts automatically to both **portrait** (`390×844`) and **landscape** (`844×390`) phone orientations.

---

## Notes & Browser Support

- Tested in **Google Chrome** and **Microsoft Edge** on Windows (both support native H.264/AAC `.mp4` export via `MediaRecorder`). Firefox falls back automatically to `.webm` export if `video/mp4` recording is unavailable.
- Exports render in real time via Canvas + Web Audio capture — keep the browser tab visible in the foreground while exporting so the browser does not throttle `requestAnimationFrame`.
