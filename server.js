import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// Google Drive Video Transcoding Proxy
// Transcodes H.265/MKV → H.264/MP4 in background, then serves as a seekable file
// ==========================================
const FFMPEG_PATH = process.env.FFMPEG_PATH || (os.platform() === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE_PATH = process.env.FFPROBE_PATH || (os.platform() === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
const VIDEO_ENCODER = os.platform() === 'darwin' ? 'h264_videotoolbox' : 'libx264';
const CACHE_DIR = join(os.tmpdir(), 'watchtogether-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Track in-progress transcoding jobs: jobId -> { status, progress, error, process }
const transcodingJobs = new Map();
const videoTracksCache = new Map();

// Helper: resolve actual download URL, handling Google Drive virus-scan confirmation page
async function resolveGDriveDownloadUrl(fileId) {
  const baseUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;

  const resp = await fetch(baseUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT }
  });

  const contentType = resp.headers.get('content-type') || '';

  // If we got the actual binary file directly, return the URL
  if (!contentType.includes('text/html')) {
    return { url: baseUrl, cookies: resp.headers.get('set-cookie') || '' };
  }

  // Parse the HTML confirmation page to extract uuid token
  const html = await resp.text();
  const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
  const uuid = uuidMatch ? uuidMatch[1] : null;

  if (!uuid) {
    console.error('[proxy] Could not find uuid in confirmation page. Trying legacy URL...');
    return { url: `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`, cookies: '' };
  }

  console.log(`[proxy] Got uuid=${uuid}`);
  const confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&uuid=${uuid}`;
  const cookies = resp.headers.get('set-cookie') || '';

  // Pre-flight check to verify the confirmUrl is a binary stream and not an HTML error page (like Quota Exceeded)
  const cookieHeader = cookies
    ? cookies.split(',').map(c => c.split(';')[0].trim()).join('; ')
    : '';

  const headers = { 'User-Agent': USER_AGENT };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  console.log(`[proxy] Pre-flight checking: ${confirmUrl}`);
  const checkResp = await fetch(confirmUrl, {
    headers,
    redirect: 'follow'
  });

  const checkContentType = checkResp.headers.get('content-type') || '';
  if (checkContentType.includes('text/html')) {
    const errorHtml = await checkResp.text();
    if (errorHtml.includes('Quota exceeded') || errorHtml.includes('Too many users have viewed or downloaded')) {
      throw new Error('Google Drive download quota exceeded for this file. Please try again later.');
    }
    if (errorHtml.includes('Access Denied') || errorHtml.includes('Sign in') || errorHtml.includes('login')) {
      throw new Error('Google Drive Access Denied. Make sure file sharing is set to "Anyone with link can view".');
    }
    throw new Error('Google Drive returned an HTML error page instead of the video stream.');
  }

  return { url: confirmUrl, cookies };
}

// Start background transcoding (non-blocking, fire-and-forget)
async function startTranscodingJob(fileId, cachedFile, audioTrack = 0) {
  const jobId = `${fileId}_at${audioTrack}`;
  if (transcodingJobs.has(jobId) && transcodingJobs.get(jobId).status === 'processing') return;

  transcodingJobs.set(jobId, { status: 'processing', progress: 0, error: null });
  console.log(`[proxy] Starting background transcoding for ${fileId} (Audio Track ${audioTrack})`);

  try {
    const { url: downloadUrl, cookies } = await resolveGDriveDownloadUrl(fileId);
    console.log(`[proxy] ffmpeg will download directly from: ${downloadUrl}`);

    const tmpFile = join(CACHE_DIR, `${jobId}.tmp.mp4`);

    // Build cookie header string for ffmpeg
    const cookieHeader = cookies
      ? cookies.split(',').map(c => c.split(';')[0].trim()).join('; ')
      : '';

    // ffmpeg downloads the URL directly (handles seeking, no pipe issues)
    // -map 0:v:0 and -map 0:a:audioTrack? select the stream. The ? makes the audio map optional.
    // -ac 2 downmixes 5.1/7.1 surround to stereo for browser compatibility
    const ffArgs = [
      '-user_agent', USER_AGENT,
      ...(cookieHeader ? ['-headers', `Cookie: ${cookieHeader}\r\n`] : []),
      '-i', downloadUrl,
      '-map', '0:v:0',
      '-map', `0:a:${audioTrack}?`,
      '-vf', 'scale=-2:720',
      '-c:v', VIDEO_ENCODER,
      '-b:v', '2500k',
      '-c:a', 'aac',
      '-ac', '2',           // downmix surround to stereo
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',                  // overwrite without asking
      tmpFile
    ];

    console.log(`[proxy] Spawning ffmpeg for ${jobId}`);
    const ff = spawn(FFMPEG_PATH, ffArgs);
    const jobRef = transcodingJobs.get(jobId);
    if (jobRef) jobRef.process = ff;

    // Parse ffmpeg stderr for progress
    let durationSecs = 0;
    ff.stderr.on('data', (d) => {
      const text = d.toString();
      const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (durMatch) {
        durationSecs = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
      }
      const timeMatch = text.match(/time=\s*(\d+):(\d+):(\d+)/);
      if (timeMatch && durationSecs > 0) {
        const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
        const pct = Math.min(99, Math.round((current / durationSecs) * 100));
        const job = transcodingJobs.get(jobId);
        if (job) job.progress = pct;
      }
      // Log errors
      if (text.toLowerCase().includes('error') || text.includes('frame=')) {
        process.stdout.write('[ffmpeg] ' + text.split('\n')[0] + '\n');
      }
    });

    ff.on('close', (code) => {
      const job = transcodingJobs.get(jobId);
      if (code === 0) {
        try { renameSync(tmpFile, cachedFile); } catch (e) {
          console.error('[proxy] rename failed:', e.message);
        }
        if (job) { job.status = 'done'; job.progress = 100; }
        console.log(`[proxy] ✅ Transcoding complete for ${jobId}`);
      } else {
        if (job) { job.status = 'error'; job.error = `ffmpeg exited with code ${code}`; }
        console.error(`[proxy] ❌ ffmpeg failed (code ${code}) for ${jobId}`);
        try { unlinkSync(tmpFile); } catch {}
      }
    });

    ff.on('error', (err) => {
      const job = transcodingJobs.get(jobId);
      if (job) { job.status = 'error'; job.error = err.message; }
      console.error('[proxy] ffmpeg spawn error:', err.message);
    });

  } catch (err) {
    const job = transcodingJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
    console.error('[proxy] Error starting transcode:', err.message);
  }
}

// GET /api/video-tracks?id=FILE_ID
// Extract and return audio tracks available in the source file
app.get('/api/video-tracks', async (req, res) => {
  const fileId = req.query.id;
  if (!fileId) return res.status(400).json({ error: 'Missing id' });

  // Return cached result if available
  if (videoTracksCache.has(fileId)) {
    return res.json({ tracks: videoTracksCache.get(fileId) });
  }

  try {
    let downloadUrl = '';
    let cookies = '';

    // Check if it's a Drive ID or a standard direct URL
    if (fileId.length >= 10 && !fileId.startsWith('http')) {
      const resolved = await resolveGDriveDownloadUrl(fileId);
      downloadUrl = resolved.url;
      cookies = resolved.cookies;
    } else {
      downloadUrl = fileId;
    }

    const cookieHeader = cookies
      ? cookies.split(',').map(c => c.split(';')[0].trim()).join('; ')
      : '';

    const ffprobeArgs = [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index:stream_tags=language,title',
      '-of', 'json',
      '-user_agent', USER_AGENT,
      ...(cookieHeader ? ['-headers', `Cookie: ${cookieHeader}\r\n`] : []),
      downloadUrl
    ];

    const fp = spawn(FFPROBE_PATH, ffprobeArgs);
    let stdout = '';
    let stderr = '';

    fp.stdout.on('data', d => stdout += d.toString());
    fp.stderr.on('data', d => stderr += d.toString());

    fp.on('close', code => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          const tracks = streams.map((stream, idx) => {
            const lang = stream.tags ? (stream.tags.language || 'und') : 'und';
            const title = stream.tags ? (stream.tags.title || stream.tags.language || `Track ${idx + 1}`) : `Track ${idx + 1}`;
            return {
              index: idx,
              language: lang,
              title: title
            };
          });
          videoTracksCache.set(fileId, tracks);
          res.json({ tracks });
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse ffprobe output: ' + e.message });
        }
      } else {
        res.status(500).json({ error: `ffprobe failed with code ${code}: ${stderr}` });
      }
    });

    fp.on('error', err => {
      res.status(500).json({ error: 'ffprobe spawn failed: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video-status?id=FILE_ID
// Returns { status: 'not_started'|'processing'|'done'|'error', progress: 0-100 }
app.get('/api/video-status', (req, res) => {
  const fileId = req.query.id;
  const audioTrack = parseInt(req.query.audioTrack || '0', 10);
  if (!fileId) return res.status(400).json({ error: 'Missing id' });

  const cachedFile = join(CACHE_DIR, `${fileId}_at${audioTrack}.mp4`);
  if (existsSync(cachedFile)) return res.json({ status: 'done', progress: 100 });

  const jobId = `${fileId}_at${audioTrack}`;
  if (transcodingJobs.has(jobId)) {
    const job = transcodingJobs.get(jobId);
    return res.json({ status: job.status, progress: job.progress, error: job.error });
  }
  return res.json({ status: 'not_started', progress: 0 });
});

// GET /api/stream-video?id=FILE_ID&audioTrack=INDEX
// If ready → serve with range requests. If not → start transcoding and return 202.
app.get('/api/stream-video', async (req, res) => {
  const fileId = req.query.id;
  const audioTrack = parseInt(req.query.audioTrack || '0', 10);
  if (!fileId || fileId.length < 10) {
    return res.status(400).json({ error: 'Missing or invalid Google Drive file ID' });
  }

  const cachedFile = join(CACHE_DIR, `${fileId}_at${audioTrack}.mp4`);

  // Serve completed file with proper range request support
  if (existsSync(cachedFile)) {
    const { createReadStream } = await import('fs');
    const stat = statSync(cachedFile);
    const total = stat.size;
    const rangeHeader = req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': chunkSize,
      });
      createReadStream(cachedFile, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      createReadStream(cachedFile).pipe(res);
    }
    return;
  }

  // Start transcoding in background (or reset errored job)
  const jobId = `${fileId}_at${audioTrack}`;
  const existingJob = transcodingJobs.get(jobId);
  if (!existingJob || existingJob.status === 'error') {
    transcodingJobs.delete(jobId);
    startTranscodingJob(fileId, cachedFile, audioTrack); // fire and forget
  }

  const job = transcodingJobs.get(jobId) || { status: 'processing', progress: 0 };
  return res.status(202).json({
    status: job.status,
    progress: job.progress,
    message: 'Video is being transcoded. Poll /api/video-status for progress.'
  });
});

// Google Drive Folder Scraper API
app.get('/api/gdrive-folder', async (req, res) => {
  const folderUrl = req.query.url;
  if (!folderUrl) {
    return res.status(400).json({ error: 'URL query parameter is required' });
  }

  try {
    const matchId = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    const folderId = matchId ? matchId[1] : folderUrl;

    if (!folderId || folderId.length < 10) {
      return res.status(400).json({ error: 'Invalid Google Drive Folder ID or URL' });
    }

    const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
    const resPage = await fetch(driveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!resPage.ok) {
      return res.status(resPage.status).json({ error: 'Failed to access Google Drive. Folder may be private or invalid.' });
    }

    const html = await resPage.text();

    const match = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)'/);
    if (!match) {
      if (html.includes('Sign in') || html.includes('login')) {
        return res.status(403).json({ error: 'Access Denied. Please make sure the Google Drive folder sharing is set to "Anyone with link can view".' });
      }
      return res.status(404).json({ error: 'No files found. Verify this is a public Google Drive folder link.' });
    }

    const rawStr = match[1];
    let decoded = rawStr.replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    decoded = decoded.replace(/\\"/g, '"');

    const data = JSON.parse(decoded);
    const files = [];

    function traverse(obj) {
      if (Array.isArray(obj)) {
        if (obj.length >= 4 && typeof obj[0] === 'string' && obj[0].length > 15 && typeof obj[2] === 'string' && typeof obj[3] === 'string') {
          const id = obj[0];
          const name = obj[2];
          const mimeType = obj[3];
          const size = obj[13] || 0;

          if (mimeType.startsWith('video/') || name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.webm')) {
            if (!files.some(f => f.id === id)) {
              files.push({
                id,
                name,
                mimeType,
                size,
                streamUrl: `/api/stream-video?id=${id}`
              });
            }
          }
        }
        for (let item of obj) {
          traverse(item);
        }
      } else if (obj && typeof obj === 'object') {
        for (let key in obj) {
          traverse(obj[key]);
        }
      }
    }

    traverse(data);
    res.json({ folderId, files });

  } catch (error) {
    console.error('Error scraping Drive folder:', error);
    res.status(500).json({ error: 'Internal server error resolving folder contents.' });
  }
});

// Catch-all route to serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// Socket.IO Room Management
// ==========================================
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  let currentRoom = null;
  let currentUsername = null;

  socket.on('join-room', ({ roomId, username }) => {
    const cleanRoomId = String(roomId).trim().substring(0, 30);
    const cleanUsername = String(username).trim().substring(0, 20) || 'Anonymous';

    currentRoom = cleanRoomId;
    currentUsername = cleanUsername;

    socket.join(cleanRoomId);
    console.log(`${cleanUsername} (${socket.id}) joined room: ${cleanRoomId}`);

    if (!rooms.has(cleanRoomId)) {
      rooms.set(cleanRoomId, {
        users: new Map(),
        playlist: [],
        currentVideo: null
      });
    }
    const room = rooms.get(cleanRoomId);
    const roomUsers = room.users;

    const existingPeers = [];
    roomUsers.forEach((user, socketId) => {
      existingPeers.push({ socketId, username: user.username });
    });

    roomUsers.set(socket.id, { username: cleanUsername, socketId: socket.id });

    socket.to(cleanRoomId).emit('user-joined', { socketId: socket.id, username: cleanUsername });

    socket.emit('room-joined', {
      peers: existingPeers,
      username: cleanUsername,
      roomId: cleanRoomId,
      playlist: room.playlist,
      currentVideo: room.currentVideo
    });

    io.to(cleanRoomId).emit('room-members-update', Array.from(roomUsers.values()));
  });

  socket.on('playlist-update', (playlist) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.playlist = playlist;
    socket.to(currentRoom).emit('playlist-update', playlist);
  });

  socket.on('video-selected', (videoInfo) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.currentVideo = videoInfo;
    socket.to(currentRoom).emit('video-selected', videoInfo);
  });

  socket.on('video-state-change', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('video-state-change', {
      ...data,
      senderSocketId: socket.id,
      senderUsername: currentUsername
    });
  });

  socket.on('webrtc-signal', ({ targetSocketId, signal, senderState }) => {
    if (!currentRoom) return;
    io.to(targetSocketId).emit('webrtc-signal', {
      senderSocketId: socket.id,
      senderUsername: currentUsername,
      signal,
      senderState
    });
  });

  socket.on('media-state-change', (mediaState) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('peer-media-state-change', {
      socketId: socket.id,
      mediaState
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const roomUsers = room.users;
      roomUsers.delete(socket.id);

      socket.to(currentRoom).emit('user-left', { socketId: socket.id, username: currentUsername });

      if (roomUsers.size === 0) {
        rooms.delete(currentRoom);
        console.log(`Room ${currentRoom} is now empty and has been removed.`);
      } else {
        io.to(currentRoom).emit('room-members-update', Array.from(roomUsers.values()));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Watch Together server running on http://localhost:${PORT}`);
});

// Clean up child processes on exit/restart
function cleanupActiveJobs() {
  console.log('[proxy] Cleaning up active transcoding processes...');
  transcodingJobs.forEach((job, fileId) => {
    if (job.process) {
      try {
        job.process.kill('SIGKILL');
        console.log(`[proxy] Killed ffmpeg process for ${fileId}`);
      } catch (e) {}
    }
  });
}
process.on('exit', cleanupActiveJobs);
process.on('SIGINT', () => { cleanupActiveJobs(); process.exit(0); });
process.on('SIGTERM', () => { cleanupActiveJobs(); process.exit(0); });
