'use strict';

// OPTIONAL: disables TLS certificate verification. Only keep this if you are
// behind a TLS-intercepting corporate proxy; REMOVE it in normal environments.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const { BoxClient, BoxJwtAuth, JwtConfig } = require('box-node-sdk');
const { AssemblyAI } = require('assemblyai');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const BOX_FOLDER_ID          = process.env.BOX_FOLDER_ID;
const ASSEMBLYAI_KEY         = process.env.ASSEMBLYAI_API_KEY;
const TRANSCRIPT_MARKER      = 'Auto-Transcript-v2';
const VIDEO_EXTENSIONS       = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const BOX_COMMENT_LIMIT      = 9000;
const FFMPEG_THRESHOLD       = 2 * 1024 * 1024 * 1024; // 2 GB
const TIMESTAMP_INTERVAL_MS  = 10_000;                  // one label every 10 seconds

if (!BOX_FOLDER_ID || !ASSEMBLYAI_KEY) {
  console.error('ERROR: BOX_FOLDER_ID and ASSEMBLYAI_API_KEY must be set in .env');
  process.exit(1);
}

// Find ffmpeg: FFMPEG_PATH env var, local folder, system PATH, then ffmpeg-static.
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH))
    return process.env.FFMPEG_PATH;
  const local = path.join(__dirname, 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return execSync(cmd, { stdio: ['pipe','pipe','pipe'] }).toString().trim().split('\n')[0];
  } catch {}
  try { return require('ffmpeg-static'); } catch {}
  return null;
}
const FFMPEG_PATH = findFfmpeg();

// ─── Box JWT client ───────────────────────────────────────────────────────────

const _cfg  = JSON.parse(fs.readFileSync(path.join(__dirname, 'box_jwt_config.json'), 'utf8'));
const _app  = _cfg.boxAppSettings;
const _auth = new BoxJwtAuth({
  config: new JwtConfig({
    clientId:             _app.clientID,
    clientSecret:         _app.clientSecret,
    jwtKeyId:             _app.appAuth.publicKeyID,
    privateKey:           _app.appAuth.privateKey,
    privateKeyPassphrase: _app.appAuth.passphrase,
    enterpriseId:         _cfg.enterpriseID,
  }),
});
const box = new BoxClient({ auth: _auth });

// ─── Box helpers ──────────────────────────────────────────────────────────────

async function listFolder(folderId) {
  const result = await box.folders.getFolderItems(folderId, { queryParams: { fields: ['id', 'name', 'size', 'type'], limit: '1000' } });
  return result.entries || [];
}

async function getComments(fileId) {
  const result = await box.comments.getFileComments(fileId);
  return result.entries || [];
}

// Gets the pre-signed download URL by following the Box redirect.
async function getDownloadUrl(fileId) {
  const tokenInfo = await _auth.retrieveToken();
  const res = await axios.get(`https://api.box.com/2.0/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
    maxRedirects: 0,
    validateStatus: s => s === 302,
  });
  return res.headers.location;
}

async function postComment(fileId, text) {
  await box.comments.createComment({ message: text, item: { id: fileId, type: 'file' } });
}

// ─── Transcript check ─────────────────────────────────────────────────────────

async function isAlreadyTranscribed(fileId) {
  const comments = await getComments(fileId);
  return comments.some(c => c.message && c.message.includes(TRANSCRIPT_MARKER));
}

// ─── Timestamp formatter ──────────────────────────────────────────────────────

// Converts milliseconds to HH:MM:SS label.
function msToLabel(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `[${h}:${m}:${s}]`;
}

// Groups AssemblyAI word objects into intervalMs-wide windows.
// Each window becomes one line: "[HH:MM:SS] word word word..."
function formatWithTimestamps(words, intervalMs = TIMESTAMP_INTERVAL_MS) {
  if (!words || words.length === 0) return '';

  const lines = [];
  let lineWords   = [];
  let label       = null;
  let nextBoundary = 0;

  for (const word of words) {
    if (label === null || word.start >= nextBoundary) {
      if (lineWords.length > 0) lines.push(`${label} ${lineWords.join(' ')}`);
      lineWords    = [];
      label        = msToLabel(word.start);
      nextBoundary = Math.floor(word.start / intervalMs) * intervalMs + intervalMs;
    }
    lineWords.push(word.text);
  }

  if (lineWords.length > 0) lines.push(`${label} ${lineWords.join(' ')}`);
  return lines.join('\n');
}

// ─── Comment chunker ──────────────────────────────────────────────────────────

function buildCommentChunks(text) {
  const header = `${TRANSCRIPT_MARKER}\nGenerated by AssemblyAI\n\n`;
  if ((header + text).length <= BOX_COMMENT_LIMIT) return [header + text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    const ph = `${TRANSCRIPT_MARKER} (part ${chunks.length + 1})\nGenerated by AssemblyAI\n\n`;
    const avail = BOX_COMMENT_LIMIT - ph.length;
    if (remaining.length <= avail) { chunks.push(ph + remaining); break; }
    // Prefer splitting at a newline (timestamp boundary) to keep lines intact.
    let cut = avail;
    const nl = remaining.lastIndexOf('\n', cut);
    if (nl > avail * 0.6) cut = nl + 1;
    else {
      const dot = remaining.lastIndexOf('. ', cut);
      if (dot > avail * 0.6) cut = dot + 2;
      else { const sp = remaining.lastIndexOf(' ', cut); if (sp > 0) cut = sp; }
    }
    chunks.push(ph + remaining.substring(0, cut).trimEnd());
    remaining = remaining.substring(cut).trimStart();
  }
  return chunks.map((c, i) =>
    c.replace(`(part ${i + 1})`, `(part ${i + 1} of ${chunks.length})`)
  );
}

// ─── ffmpeg audio extraction ──────────────────────────────────────────────────

function extractAudio(downloadUrl) {
  const tmp = path.join(os.tmpdir(), `bt_audio_${Date.now()}.mp3`);
  return new Promise((res, rej) => {
    const proc = spawn(FFMPEG_PATH, [
      '-i', downloadUrl, '-vn', '-acodec', 'libmp3lame', '-ac', '1', '-ab', '64k', '-y', tmp
    ]);
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? res(tmp) : rej(new Error(`ffmpeg exited ${code}`)));
    proc.on('error', err => rej(new Error(`ffmpeg not found: ${err.message}`)));
  });
}

// ─── AssemblyAI transcription ─────────────────────────────────────────────────

const aai = new AssemblyAI({ apiKey: ASSEMBLYAI_KEY });

// Returns { text, words } — words carry per-word timestamps from AssemblyAI.
async function transcribeFile(downloadUrl, fileSize) {
  const params = { punctuate: true, speech_models: ['universal-2'] };

  if (fileSize > FFMPEG_THRESHOLD && FFMPEG_PATH) {
    console.log('  File >2 GB — extracting audio via ffmpeg...');
    let audioPath;
    try {
      audioPath = await extractAudio(downloadUrl);
      const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
      console.log(`  Audio extracted: ${sizeMB} MB — uploading to AssemblyAI...`);
      const uploadUrl = await aai.files.upload(fs.readFileSync(audioPath));
      const result = await aai.transcripts.transcribe({ audio_url: uploadUrl, ...params });
      if (result.status === 'error') {
        if (result.error?.includes('no spoken audio')) return null;
        throw new Error(`AssemblyAI: ${result.error}`);
      }
      return { text: result.text, words: result.words || [] };
    } finally {
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  }

  console.log('  Sending to AssemblyAI (waiting for transcript)...');
  const result = await aai.transcripts.transcribe({ audio_url: downloadUrl, ...params });
  if (result.status === 'error') {
    if (result.error?.includes('no spoken audio')) return null;
    throw new Error(`AssemblyAI: ${result.error}`);
  }
  return { text: result.text, words: result.words || [] };
}

// ─── Process one file ─────────────────────────────────────────────────────────

async function processFile(file) {
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  console.log(`\n[${file.name}] (${sizeMB} MB)`);

  console.log('  Checking for existing transcript...');
  if (await isAlreadyTranscribed(file.id)) {
    console.log('  Already transcribed — skipping.');
    return 'skipped';
  }

  console.log('  Getting Box download URL...');
  const url = await getDownloadUrl(file.id);

  const transcript = await transcribeFile(url, file.size);

  if (!transcript) {
    console.log('  No spoken audio detected — skipping comment.');
    return 'no_audio';
  }

  const { text, words } = transcript;
  console.log(`  Transcript ready (${text.length} chars, ${words.length} words)`);

  const formatted = words.length > 0
    ? formatWithTimestamps(words)
    : text; // fallback: plain text if AssemblyAI returned no word data

  console.log(`  Formatted with ${words.length > 0 ? '10-second timestamps' : 'plain text (no word data)'}.`);

  const chunks = buildCommentChunks(formatted);
  console.log(`  Posting ${chunks.length} comment(s) to Box...`);
  for (const chunk of chunks) await postComment(file.id, chunk);
  console.log('  Done.');
  return 'done';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('============================================');
  console.log('   Box Video Transcriber  (v2 — timestamps)');
  console.log('============================================');
  console.log(`Box folder : ${BOX_FOLDER_ID}`);
  console.log(`ffmpeg     : ${FFMPEG_PATH || 'not found (only needed for files >2 GB)'}`);
  console.log(`Timestamps : every ${TIMESTAMP_INTERVAL_MS / 1000}s`);
  console.log('');

  console.log('Scanning folder...');
  const items  = await listFolder(BOX_FOLDER_ID);
  const videos = items.filter(f =>
    f.type === 'file' &&
    VIDEO_EXTENSIONS.has((f.name.split('.').pop() || '').toLowerCase())
  );

  if (videos.length === 0) {
    console.log('No video files found in the folder. Nothing to do.');
    return;
  }

  console.log(`Found ${videos.length} video(s):`);
  videos.forEach(f => console.log(`  - ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`));

  const counts = { done: 0, skipped: 0, no_audio: 0, failed: 0 };
  for (const file of videos) {
    try {
      const result = await processFile(file);
      counts[result]++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      counts.failed++;
    }
  }

  console.log('\n============================================');
  console.log('  Transcribed : ' + counts.done);
  console.log('  Skipped     : ' + counts.skipped + ' (already had transcript)');
  console.log('  No audio    : ' + counts.no_audio);
  console.log('  Failed      : ' + counts.failed);
  console.log('============================================');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
