/**
 * DropLoad Backend — server.js
 * Powered by yt-dlp for real media info & downloads
 *
 * Endpoints:
 *   GET  /api/info?url=<media-url>          → returns title, source, duration, formats
 *   GET  /api/download?url=<url>&format=<f> → streams the media file to the client
 *   GET  /health                            → uptime check
 */

const express = require('express');
const cors    = require('cors');
const { spawn, execFile } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend from the same directory if present
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run yt-dlp with the given args and return stdout as a string.
 * On Windows, uses "python -m yt_dlp" since the yt-dlp executable
 * may not be on PATH after a pip install.
 */
function ytDlp(args) {
  const isWin = process.platform === 'win32';
  const cmd   = isWin ? 'python' : 'yt-dlp';
  const argv  = isWin ? ['-m', 'yt_dlp', ...args] : args;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(cmd, argv);
    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
      else resolve(stdout.trim());
    });
    proc.on('error', err => reject(err));
  });
}

/**
 * Convert seconds (number or string) → "H:MM:SS" or "M:SS"
 */
function fmtDuration(secs) {
  if (!secs) return '–';
  const s = Math.round(Number(secs));
  if (isNaN(s)) return String(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Rough human-readable file size from bytes.
 */
function humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B','KB','MB','GB'];
  let i = 0, b = Number(bytes);
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `~${b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Build a clean list of download formats from yt-dlp JSON.
 * We surface the most useful quality tiers rather than all 40+ raw formats.
 */
function buildFormats(info) {
  const formats = info.formats || [];

  // ── Video formats: pick best for each height ─────────────────────────
  const videoByHeight = {};
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    if (!f.height) continue;
    const h = f.height;
    const existing = videoByHeight[h];
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (!existing) {
      videoByHeight[h] = { ...f, hasAudio };
    } else {
      const exHasAudio = existing.hasAudio;
      if (hasAudio && !exHasAudio) {
        videoByHeight[h] = { ...f, hasAudio };
      } else if (hasAudio === exHasAudio) {
        if ((f.filesize || 0) > (existing.filesize || 0)) {
          videoByHeight[h] = { ...f, hasAudio };
        }
      }
    }
  }

  // Sort heights descending, keep up to 5 tiers
  const heights = Object.keys(videoByHeight)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 5);

  const result = heights.map(h => {
    const f = videoByHeight[h];
    const label = h >= 2160 ? `${h >= 4320 ? '8K' : '4K'} · MP4`
                : h >= 1080 ? `${h}p · MP4`
                : `${h}p · MP4`;
    return {
      formatId: f.format_id,
      label,
      badge: 'video',
      size:  humanSize(f.filesize || f.filesize_approx) || `~${Math.round(h * 0.06)} MB`,
      height: h,
    };
  });

  // ── Audio-only: best audio format ────────────────────────────────────
  const audioFormats = formats.filter(f =>
    (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none'
  );
  if (audioFormats.length > 0) {
    const best = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    result.push({
      formatId: 'bestaudio/best',
      label:    'Audio only · MP3',
      badge:    'audio',
      size:     humanSize(best.filesize || best.filesize_approx) || '~8 MB',
      height:   null,
    });
  }

  // Fallback if we got nothing useful
  if (result.length === 0) {
    result.push(
      { formatId: 'bestvideo+bestaudio/best', label: 'Best Quality · MP4', badge: 'video', size: null, height: null },
      { formatId: 'bestaudio/best',           label: 'Audio only · MP3',   badge: 'audio', size: null, height: null },
    );
  }

  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Health check */
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/**
 * GET /api/info?url=<media-url>
 * Returns JSON with title, source, duration, thumbnail, formats[].
 */
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const json = await ytDlp([
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--flat-playlist',
      parsed.href,
    ]);

    const info = JSON.parse(json);
    const formats = buildFormats(info);

    return res.json({
      title:     info.title     || 'Untitled',
      source:    info.uploader  || info.channel || parsed.hostname.replace('www.', ''),
      duration:  fmtDuration(info.duration),
      thumbnail: info.thumbnail || null,
      formats,
    });
  } catch (err) {
    console.error('[/api/info]', err.message);
    return res.status(422).json({ error: err.message });
  }
});

/**
 * GET /api/download?url=<media-url>&formatId=<id>&filename=<name>
 * Streams the requested format directly to the client.
 * For audio-only, we post-process to MP3 via yt-dlp's built-in converter.
 */
app.get('/api/download', async (req, res) => {
  const { url, formatId, filename } = req.query;
  if (!url || !formatId) {
    return res.status(400).json({ error: 'url and formatId are required' });
  }

  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const isAudio = formatId === 'bestaudio/best';
  const safeFilename = (filename || 'download').replace(/[^a-z0-9 _\-\.]/gi, '_');
  const ext = isAudio ? 'mp3' : 'mp4';

  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.${ext}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  const isWin = process.platform === 'win32';

  if (isAudio) {
    const tmpDir  = os.tmpdir();
    const tmpBase = path.join(tmpDir, `dl_${Date.now()}`);
    const tmpFile = `${tmpBase}.mp3`;

    const dlArgs = [
      '--no-playlist', '--no-warnings',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', `${tmpBase}.%(ext)s`,
      parsed.href,
    ];

    try {
      await ytDlp(dlArgs);
      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);
      stream.on('end', () => fs.unlink(tmpFile, () => {}));
      stream.on('error', e => { console.error(e); res.destroy(); });
    } catch (err) {
      console.error('[/api/download audio]', err.message);
      if (!res.headersSent) res.status(422).json({ error: err.message });
    }
    return;
  }

  // Video: stream stdout directly
  const cmd  = isWin ? 'python' : 'yt-dlp';
  const argv = isWin
    ? ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', '-f', formatId, '-o', '-', parsed.href]
    : ['--no-playlist', '--no-warnings', '-f', formatId, '-o', '-', parsed.href];

  const proc = spawn(cmd, argv);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('[yt-dlp stderr]', d.toString().trim()));
  proc.on('error', err => {
    console.error('[/api/download spawn]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to start download' });
  });
  req.on('close', () => proc.kill());
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟠 DropLoad backend running at http://localhost:${PORT}`);
  console.log(`   GET /api/info?url=<media-url>                   → fetch formats`);
  console.log(`   GET /api/download?url=<url>&formatId=<id>       → stream download\n`);
});
