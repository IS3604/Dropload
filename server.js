const express = require('express');
const cors    = require('cors');
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3001;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Write cookies from env variable to a temp file on startup
const COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
  console.log('[cookies] Loaded YouTube cookies from environment variable');
} else {
  console.log('[cookies] No YOUTUBE_COOKIES env variable found');
}

function getCookieArgs() {
  if (fs.existsSync(COOKIES_FILE)) return ['--cookies', COOKIES_FILE];
  return [];
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ytDlp(args) {
  const isWin = process.platform === 'win32';
  const cmd   = isWin ? 'python' : 'yt-dlp';
  const argv  = isWin ? ['-m', 'yt_dlp', ...args] : args;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
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

function fmtDuration(secs) {
  if (!secs) return '-';
  const s = Math.round(Number(secs));
  if (isNaN(s)) return String(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B','KB','MB','GB'];
  let i = 0, b = Number(bytes);
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `~${b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`;
}

function buildFormats(info) {
  const formats = info.formats || [];
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
      } else if (hasAudio === exHasAudio && (f.filesize || 0) > (existing.filesize || 0)) {
        videoByHeight[h] = { ...f, hasAudio };
      }
    }
  }
  const heights = Object.keys(videoByHeight).map(Number).sort((a, b) => b - a).slice(0, 5);
  const result = heights.map(h => {
    const f = videoByHeight[h];
    const label = h >= 2160 ? `${h >= 4320 ? '8K' : '4K'} · MP4` : `${h}p · MP4`;
    return {
      formatId: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best[height<=${h}]`,
      label, badge: 'video',
      size: humanSize(f.filesize || f.filesize_approx) || `~${Math.round(h * 0.06)} MB`,
      height: h,
    };
  });
  const audioFormats = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  if (audioFormats.length > 0) {
    const best = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    result.push({ formatId: 'bestaudio/best', label: 'Audio only · MP3', badge: 'audio', size: humanSize(best.filesize || best.filesize_approx) || '~8 MB', height: null });
  }
  if (result.length === 0) {
    result.push(
      { formatId: 'bestvideo+bestaudio/best', label: 'Best Quality · MP4', badge: 'video', size: null, height: null },
      { formatId: 'bestaudio/best', label: 'Audio only · MP3', badge: 'audio', size: null, height: null }
    );
  }
  return result;
}

app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });
  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const json = await ytDlp([
      '--dump-json', '--no-playlist', '--no-warnings',
      '--user-agent', UA,
      '--extractor-args', 'youtube:player_client=tv_embedded,web',
      '--no-check-certificate',
      ...getCookieArgs(),
      parsed.href,
    ]);
    const info = JSON.parse(json);
    return res.json({
      title:     info.title    || 'Untitled',
      source:    info.uploader || info.channel || parsed.hostname.replace('www.', ''),
      duration:  fmtDuration(info.duration),
      thumbnail: info.thumbnail || null,
      formats:   buildFormats(info),
    });
  } catch (err) {
    console.error('[/api/info]', err.message);
    return res.status(422).json({ error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, formatId, filename } = req.query;
  if (!url || !formatId) return res.status(400).json({ error: 'url and formatId are required' });
  let parsed;
  try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const isAudio      = formatId === 'bestaudio/best';
  const safeFilename = (filename || 'download').replace(/[^a-z0-9 _\-\.]/gi, '_');
  const ext          = isAudio ? 'mp3' : 'mp4';
  const tmpDir       = os.tmpdir();
  const tmpBase      = path.join(tmpDir, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const tmpFile      = `${tmpBase}.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.${ext}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  const dlArgs = isAudio
    ? ['--no-playlist', '--no-warnings', '--user-agent', UA,
        '--extractor-args', 'youtube:player_client=tv_embedded,web',
        '--no-check-certificate',
        ...getCookieArgs(),
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '-o', `${tmpBase}.%(ext)s`, parsed.href]
    : ['--no-playlist', '--no-warnings', '--user-agent', UA,
        '--extractor-args', 'youtube:player_client=tv_embedded,web',
        '--no-check-certificate',
        ...getCookieArgs(),
        '-f', formatId,
        '--merge-output-format', 'mp4',
        '-o', tmpFile, parsed.href];

  try {
    console.log(`[download] Starting: ${formatId} → ${safeFilename}.${ext}`);
    await ytDlp(dlArgs);
    if (!fs.existsSync(tmpFile)) throw new Error('Output file not found after download');
    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => { fs.unlink(tmpFile, () => {}); console.log(`[download] Done: ${safeFilename}.${ext}`); });
    stream.on('error', e => { console.error(e); fs.unlink(tmpFile, () => {}); res.destroy(); });
  } catch (err) {
    console.error('[/api/download]', err.message);
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent) res.status(422).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🟠 DropLoad backend running at http://localhost:${PORT}\n`);
});
