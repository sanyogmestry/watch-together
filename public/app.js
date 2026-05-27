// Global State Variables
let socket = null;
let roomId = null;
let username = null;
let peers = []; // [{ socketId, username }]
let peerConnections = new Map(); // socketId -> RTCPeerConnection
let playlist = [];
let currentPlaylistVideo = null;
let currentLoadedVideo = null; // { name, streamUrl, isLocal }
let currentAudioTrack = 0;

// Local Media Stream state
let localStream = null;
let videoEnabled = true;
let audioEnabled = true;
let isCallActive = false;

// Video Playback Sync State
let isApplyingRemoteEvent = false;
let heartbeatInterval = null;
let pendingSyncTarget = null; // { time, playing }

// UI Elements Cache
const landingScreen = document.getElementById('landing-screen');
const loungeScreen = document.getElementById('lounge-screen');
const usernameInput = document.getElementById('username-input');
const roomIdInput = document.getElementById('room-id-input');
const tabCreate = document.getElementById('tab-create');
const tabJoin = document.getElementById('tab-join');
const createContent = document.getElementById('create-content');
const joinContent = document.getElementById('join-content');
const enterBtn = document.getElementById('enter-btn');
const roomDisplayId = document.getElementById('room-display-id');
const copyRoomLink = document.getElementById('copy-room-link');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const changeVideoBtn = document.getElementById('change-video-source-btn');

// Video Player Elements
const sourceSelector = document.getElementById('source-selector');
const videoFileInput = document.getElementById('video-file-input');
const browseFileBtn = document.getElementById('browse-file-btn');
const fileNameDisplay = document.getElementById('file-name-display');
const videoUrlInput = document.getElementById('video-url-input');
const loadUrlBtn = document.getElementById('load-url-btn');

const playerContainer = document.getElementById('player-container');
const video = document.getElementById('video-element');
const iframePlayer = document.getElementById('iframe-player');
const iframeSyncWarning = document.getElementById('iframe-sync-warning');
const playPauseBtn = document.getElementById('play-pause-btn');
const skipBackBtn = document.getElementById('skip-back-btn');
const skipForwardBtn = document.getElementById('skip-forward-btn');
const timeCurrentLbl = document.getElementById('time-current-lbl');
const timeDurationLbl = document.getElementById('time-duration-lbl');
const volumeBtn = document.getElementById('volume-btn');
const volumeSlider = document.getElementById('volume-slider');
const syncIndicator = document.getElementById('sync-indicator');
const manualResyncBtn = document.getElementById('manual-resync-btn');
const speedBtn = document.getElementById('speed-btn');
const speedMenu = document.getElementById('speed-menu');
const audioTrackContainer = document.getElementById('audio-track-container');
const audioTrackMenu = document.getElementById('audio-track-menu');
const theaterBtn = document.getElementById('theater-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const timelineContainer = document.getElementById('timeline-container');
const timelineCurrent = document.getElementById('timeline-current');
const timelineBuffered = document.getElementById('timeline-buffered');
const timelineScrubPreview = document.getElementById('timeline-scrub-preview');

// Overlay Dialogs inside Player
const playerLoadingOverlay = document.getElementById('player-loading-overlay');
const resyncAlertOverlay = document.getElementById('resync-alert-overlay');
const resyncAcceptBtn = document.getElementById('resync-accept-btn');
const resyncIgnoreBtn = document.getElementById('resync-ignore-btn');

// Sidebar Elements
const membersList = document.getElementById('members-list');
const consoleLogs = document.getElementById('console-logs');

// Playlist Elements Cache
const playlistContainer = document.getElementById('playlist-container');
const importFolderBtn = document.getElementById('import-folder-btn');
const folderImportOverlay = document.getElementById('folder-import-overlay');
const folderUrlInput = document.getElementById('folder-url-input');
const fetchFolderBtn = document.getElementById('fetch-folder-btn');
const fetchFolderSpinner = document.getElementById('fetch-folder-spinner');
const fetchBtnLbl = document.getElementById('fetch-btn-lbl');
const closeFolderImportBtn = document.getElementById('close-folder-import-btn');

// Banner elements for playlist video selection
const roomActiveVideoBanner = document.getElementById('room-active-video-banner');
const roomActiveVideoName = document.getElementById('room-active-video-name');
const playActiveStreamBtn = document.getElementById('play-active-stream-btn');

// WebRTC Floating Call Widget Elements
const callWidget = document.getElementById('webrtc-call-widget');
const dragHandle = document.getElementById('widget-drag-handle');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const localVideoWrapper = document.getElementById('local-video-wrapper');
const peerVideoWrapper = document.getElementById('peer-video-wrapper');
const peerAvatar = document.getElementById('peer-avatar');
const localAvatar = document.getElementById('local-avatar');
const peerLabel = document.getElementById('peer-label');

const toggleVideoBtn = document.getElementById('toggle-video-btn');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const startCallBtn = document.getElementById('start-call-btn');

// Ice Servers Configuration (STUN for NAT Traversal)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
};

// ==========================================
// 1. Landing Screen Tab & Initialization
// ==========================================

// Pre-fill fields from Query Params if joining a room via link
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const qRoomId = urlParams.get('room');
  
  if (qRoomId) {
    switchTab('join');
    roomIdInput.value = qRoomId;
    logToConsole(`Room link detected! Prefilled Room ID: ${qRoomId}`);
  }
});

function switchTab(mode) {
  if (mode === 'create') {
    tabCreate.classList.add('active');
    tabJoin.classList.remove('active');
    createContent.classList.remove('hidden');
    joinContent.classList.add('hidden');
  } else {
    tabCreate.classList.remove('active');
    tabJoin.classList.add('active');
    createContent.classList.add('hidden');
    joinContent.classList.remove('hidden');
  }
}

tabCreate.addEventListener('click', () => switchTab('create'));
tabJoin.addEventListener('click', () => switchTab('join'));

// Enter Lounge button trigger
enterBtn.addEventListener('click', () => {
  username = usernameInput.value.trim();
  if (!username) {
    alert('Please enter a username first!');
    usernameInput.focus();
    return;
  }

  const isJoining = tabJoin.classList.contains('active');
  if (isJoining) {
    let rawRoomInput = roomIdInput.value.trim();
    if (!rawRoomInput) {
      alert('Please enter a Room ID or paste a room link!');
      roomIdInput.focus();
      return;
    }
    // Extract Room ID if full URL was pasted
    try {
      const url = new URL(rawRoomInput);
      const qRoom = url.searchParams.get('room');
      roomId = qRoom || rawRoomInput;
    } catch (e) {
      roomId = rawRoomInput;
    }
  } else {
    // Create random 6-character room ID
    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  initializeLounge();
});

// ==========================================
// 2. Connect to Server & Join Room
// ==========================================

function initializeLounge() {
  logToConsole(`Connecting to server and entering Room: ${roomId}...`);
  
  // Connect to Socket.io server
  socket = io();

  socket.on('connect', () => {
    logToConsole('Connection established! Joining room...');
    socket.emit('join-room', { roomId, username });
  });

  socket.on('connect_error', (error) => {
    logToConsole(`Connection error: ${error.message}. Checking backup options...`, 'system');
  });

  // Handle Room Joined response
  socket.on('room-joined', ({ peers: existingPeers, username: serverUsername, roomId: serverRoomId, playlist: initialPlaylist, currentVideo }) => {
    roomId = serverRoomId;
    username = serverUsername;

    roomDisplayId.textContent = `Room: ${roomId}`;
    logToConsole(`Successfully entered Room ${roomId} as ${username}`, 'system');

    // Update query param in browser address bar (so they can copy address link directly)
    const newUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    window.history.replaceState({ path: newUrl }, '', newUrl);

    // Switch screen visibility
    landingScreen.classList.remove('active');
    loungeScreen.classList.add('active');

    // Keep track of peers and try to auto-initiate WebRTC if active peers exist
    peers = existingPeers;
    updateSidebarMembers();

    // Set initial playlist and video selection
    playlist = initialPlaylist || [];
    updatePlaylistUI();
    if (currentVideo) {
      applyRemoteVideoSelection(currentVideo);
    }

    // Start playback sync heartbeats
    startHeartbeatTimer();
  });

  // Handle user joining/leaving
  socket.on('user-joined', ({ socketId, username: peerName }) => {
    logToConsole(`${peerName} joined the room.`, 'user');
    
    // WebRTC: If a peer joins, we do not auto-create offer unless they choose to call.
    // However, if our local call is already active, we want to call them.
    if (isCallActive) {
      logToConsole(`Call is active. Initiating call to new peer ${peerName}...`);
      initiateWebRTCCall(socketId);
    }
  });

  socket.on('user-left', ({ socketId, username: peerName }) => {
    logToConsole(`${peerName || 'A friend'} left the room.`, 'system');
    closePeerConnection(socketId);
  });

  socket.on('room-members-update', (updatedMembers) => {
    // Exclude ourselves
    peers = updatedMembers.filter(m => m.socketId !== socket.id);
    updateSidebarMembers();
  });

  // Video State Synced Listener
  socket.on('video-state-change', (data) => {
    if (data.action === 'heartbeat') {
      handleRemoteHeartbeat(data);
    } else if (data.action === 'request-sync-anchor') {
      handleSyncAnchorRequest(data);
    } else {
      handleRemoteVideoState(data);
    }
  });

  // WebRTC Signal Listener
  socket.on('webrtc-signal', async ({ senderSocketId, senderUsername, signal, senderState }) => {
    await handleWebRTCSignal(senderSocketId, senderUsername, signal, senderState);
  });

  // WebRTC remote media toggle notify
  socket.on('peer-media-state-change', ({ socketId, mediaState }) => {
    handlePeerMediaStateChange(socketId, mediaState);
  });

  // Playlist sync listeners
  socket.on('playlist-update', (updatedPlaylist) => {
    playlist = updatedPlaylist || [];
    updatePlaylistUI();
    logToConsole('Lounge playlist updated.', 'system');
  });

  socket.on('video-selected', (videoInfo) => {
    applyRemoteVideoSelection(videoInfo);
  });
}

function leaveRoom() {
  if (confirm('Are you sure you want to leave the room?')) {
    location.reload();
  }
}

leaveRoomBtn.addEventListener('click', leaveRoom);

// Copy link function
copyRoomLink.addEventListener('click', () => {
  const roomUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  navigator.clipboard.writeText(roomUrl).then(() => {
    const originalText = copyRoomLink.querySelector('span').textContent;
    copyRoomLink.querySelector('span').textContent = 'Copied!';
    copyRoomLink.classList.add('success');
    
    setTimeout(() => {
      copyRoomLink.querySelector('span').textContent = originalText;
      copyRoomLink.classList.remove('success');
    }, 2000);
  }).catch(err => {
    alert(`Failed to copy. Link is: ${roomUrl}`);
  });
});

// ==========================================
// 3. Main Lounge: Video Source & Selection
// ==========================================

// Local file triggers
browseFileBtn.addEventListener('click', () => {
  videoFileInput.click();
});

videoFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  logToConsole(`Loading local video file: ${file.name}`);
  fileNameDisplay.textContent = file.name;
  
  // Create object URL
  const fileURL = URL.createObjectURL(file);
  loadVideoSource(fileURL, file.name, true);
});

// Drag and drop video file
const localFileBox = document.getElementById('local-file-box');
localFileBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  localFileBox.classList.add('dragover');
});

localFileBox.addEventListener('dragleave', () => {
  localFileBox.classList.remove('dragover');
});

localFileBox.addEventListener('drop', (e) => {
  e.preventDefault();
  localFileBox.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && (file.type.startsWith('video/') || file.name.endsWith('.mkv'))) {
    logToConsole(`Loaded dropped file: ${file.name}`);
    fileNameDisplay.textContent = file.name;
    const fileURL = URL.createObjectURL(file);
    loadVideoSource(fileURL, file.name, true);
  } else {
    alert('Please drop a valid video file (.mp4, .mkv, etc.)');
  }
});

// Web URL triggers
loadUrlBtn.addEventListener('click', () => {
  let url = videoUrlInput.value.trim();
  if (!url) {
    alert('Please enter a valid video stream URL.');
    return;
  }

  // Handle Google Drive Links
  url = parseGoogleDriveLink(url);

  logToConsole(`Loading web stream: ${url}`);
  loadVideoSource(url, 'Web Stream Link', false);
});

// Convert Google Drive share link to a proxy transcoding URL
function parseGoogleDriveLink(url) {
  // Pattern 1: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  // Pattern 2: https://drive.google.com/open?id=FILE_ID
  // Pattern 3: https://drive.google.com/uc?export=download&id=FILE_ID
  let fileId = null;
  const match1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match1) {
    fileId = match1[1];
  } else {
    const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match2) fileId = match2[1];
  }

  if (fileId) {
    logToConsole(`Google Drive file ID resolved: ${fileId}. Routing through transcoding proxy...`, 'system');
    return `/api/stream-video?id=${fileId}`;
  }
  return url;
}

// Extract Drive file ID from any Drive URL or proxy URL
function extractDriveFileId(url) {
  const proxyMatch = url.match(/\/api\/stream-video\?id=([a-zA-Z0-9_-]+)/);
  if (proxyMatch) return proxyMatch[1];
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  return null;
}

// Active transcoding poll timer
let _transcodePollTimer = null;

function loadVideoSource(sourceUrl, name, isLocal = false) {
  // Clear any previous transcoding poll
  if (_transcodePollTimer) { clearInterval(_transcodePollTimer); _transcodePollTimer = null; }

  // Reset audio track selection state
  currentAudioTrack = 0;
  audioTrackContainer.classList.add('hidden');
  audioTrackMenu.innerHTML = '';

  // Route Drive URLs through local transcoding proxy if not already done
  let resolvedUrl = sourceUrl;
  const fileId = !isLocal ? extractDriveFileId(sourceUrl) : null;
  if (!isLocal && fileId) {
    resolvedUrl = `/api/stream-video?id=${fileId}`;
  }

  // Hide iframe, clear old video
  iframePlayer.src = '';
  iframePlayer.classList.add('hidden');
  iframeSyncWarning.classList.add('hidden');
  video.removeAttribute('src');
  video.load();

  sourceSelector.classList.add('hidden');
  const shareUrl = isLocal ? '' : resolvedUrl;
  currentLoadedVideo = { name, streamUrl: shareUrl, isLocal };

  // Emit video selection to room immediately
  if (!isApplyingRemoteEvent && socket) {
    socket.emit('video-selected', { name, streamUrl: shareUrl });
  }

  // Fetch audio tracks list if it is a Google Drive web stream
  if (!isLocal && fileId) {
    fetchAndPopulateAudioTracks(fileId, resolvedUrl, name);
  } else if (isLocal) {
    // Local file: check native audioTracks (Safari)
    const onMetadata = () => {
      if (video.audioTracks && video.audioTracks.length > 1) {
        populateNativeAudioTracks(video.audioTracks);
      }
    };
    video.addEventListener('loadedmetadata', onMetadata, { once: true });
  }

  // If it's a proxy URL, poll until transcoding is done before loading
  if (!isLocal && resolvedUrl.startsWith('/api/stream-video') && fileId) {
    _showTranscodeProgress(fileId, name, resolvedUrl);
  } else {
    // Local file or non-proxy URL — load directly
    _playVideoUrl(resolvedUrl, name);
  }
}

function _showTranscodeProgress(fileId, name, proxyUrl, targetSeekTime = 0, autoPlay = false) {
  // Show transcoding overlay over the player
  const overlay = document.getElementById('player-loading-overlay');
  const overlayMsg = overlay ? overlay.querySelector('p') : null;
  video.classList.remove('hidden');
  document.getElementById('custom-controls').classList.remove('hidden');
  if (overlay) overlay.classList.remove('hidden');

  // Clean up any stale error state
  const spinner = overlay ? overlay.querySelector('.loading-spinner') : null;
  if (spinner) spinner.style.display = '';
  const dismissBtn = document.getElementById('transcode-error-dismiss-btn');
  if (dismissBtn) dismissBtn.remove();
  let progressWrap = document.getElementById('transcode-progress-wrap');
  if (progressWrap) {
    progressWrap.style.display = '';
    progressWrap.remove();
    progressWrap = null;
  }

  // Create or update progress bar inside the overlay
  if (!progressWrap && overlay) {
    progressWrap = document.createElement('div');
    progressWrap.id = 'transcode-progress-wrap';
    progressWrap.style.cssText = 'width:260px;margin-top:12px;';
    progressWrap.innerHTML = `
      <div style="height:6px;background:rgba(255,255,255,0.15);border-radius:4px;overflow:hidden;">
        <div id="transcode-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#06b6d4);border-radius:4px;transition:width 0.4s ease;"></div>
      </div>
      <div id="transcode-progress-label" style="margin-top:6px;font-size:12px;color:rgba(255,255,255,0.6);text-align:center;">Starting...</div>
    `;
    overlay.appendChild(progressWrap);
  }

  if (overlayMsg) overlayMsg.textContent = `Preparing "${name}"...`;

  logToConsole(`⏳ Transcoding "${name}" — preparing for playback...`, 'system');

  // Kick off the transcoding by hitting the proxy endpoint once
  fetch(proxyUrl).catch(() => {});

  // Poll status every 2 seconds (querying the specific audioTrack)
  _transcodePollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/video-status?id=${fileId}&audioTrack=${currentAudioTrack}`);
      const data = await resp.json();

      const bar = document.getElementById('transcode-progress-bar');
      const label = document.getElementById('transcode-progress-label');

      if (bar) bar.style.width = `${data.progress || 0}%`;

      if (data.status === 'done') {
        clearInterval(_transcodePollTimer);
        _transcodePollTimer = null;
        if (label) label.textContent = 'Ready!';
        if (bar) bar.style.width = '100%';
        setTimeout(() => {
          if (overlay) overlay.classList.add('hidden');
          if (progressWrap) progressWrap.remove();
          _playVideoUrl(proxyUrl, name, targetSeekTime, autoPlay);
        }, 300);

      } else if (data.status === 'error') {
        clearInterval(_transcodePollTimer);
        _transcodePollTimer = null;
        
        // Render detailed error screen directly in overlay
        if (overlay) {
          if (spinner) spinner.style.display = 'none';
          if (overlayMsg) {
            overlayMsg.innerHTML = `
              <span style="color:#ef4444;font-weight:600;display:block;margin-bottom:8px;font-size:1.1rem;">❌ Transcoding Failed</span>
              <span style="font-size:0.875rem;color:rgba(255,255,255,0.8);max-width:280px;display:block;margin:0 auto;line-height:1.4;">${data.error}</span>
            `;
          }
          if (progressWrap) progressWrap.style.display = 'none';
          
          let dismiss = document.getElementById('transcode-error-dismiss-btn');
          if (!dismiss) {
            dismiss = document.createElement('button');
            dismiss.id = 'transcode-error-dismiss-btn';
            dismiss.className = 'secondary-btn btn-sm';
            dismiss.style.cssText = 'margin-top:16px;width:auto;display:inline-flex;padding:6px 16px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);';
            dismiss.textContent = 'Dismiss';
            dismiss.addEventListener('click', () => {
              overlay.classList.add('hidden');
              if (spinner) spinner.style.display = '';
              if (overlayMsg) overlayMsg.textContent = 'Syncing video playback...';
              if (progressWrap) {
                progressWrap.style.display = '';
                progressWrap.remove();
              }
              dismiss.remove();
            });
            overlay.appendChild(dismiss);
          }
        }
        logToConsole(`❌ Transcoding failed: ${data.error}`, 'system');

      } else {
        const pct = data.progress || 0;
        if (label) label.textContent = pct > 0 ? `Transcoding... ${pct}%` : 'Downloading from Google Drive...';
      }
    } catch (e) {
      // Network hiccup — keep polling
    }
  }, 2000);
}

function _playVideoUrl(url, name, targetSeekTime = 0, autoPlay = false) {
  video.src = url;
  video.load();
  video.classList.remove('hidden');
  document.getElementById('custom-controls').classList.remove('hidden');
  logToConsole(`▶ Video ready: ${name}`, 'system');

  if (targetSeekTime > 0 || autoPlay) {
    const onMetadata = () => {
      runProgrammaticUpdate(() => {
        video.currentTime = targetSeekTime;
        if (autoPlay) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      });
    };
    video.addEventListener('loadedmetadata', onMetadata, { once: true });
  }

  // Request sync anchor from peers if this wasn't a remote event trigger
  if (!isApplyingRemoteEvent && socket) {
    setTimeout(() => {
      socket.emit('video-state-change', {
        action: 'request-sync-anchor',
        timestamp: Date.now()
      });
      logToConsole('Requested synchronization anchor from peers...', 'action');
    }, 800);
  }
}

// Fetch tracks from API and render dropdown options
async function fetchAndPopulateAudioTracks(fileId, baseStreamUrl, name) {
  audioTrackContainer.classList.add('hidden');
  audioTrackMenu.innerHTML = '';

  try {
    const resp = await fetch(`/api/video-tracks?id=${encodeURIComponent(fileId)}`);
    if (!resp.ok) throw new Error('API failed');
    const data = await resp.json();
    const tracks = data.tracks || [];

    if (tracks.length > 1) {
      // Clear menu
      audioTrackMenu.innerHTML = '';

      tracks.forEach(track => {
        const opt = document.createElement('div');
        opt.className = 'audio-option';
        if (track.index === currentAudioTrack) {
          opt.className += ' active';
        }
        opt.textContent = `${track.title || track.language} (${track.language.toUpperCase()})`;
        opt.addEventListener('click', () => {
          if (track.index === currentAudioTrack) return;
          switchAudioTrack(fileId, baseStreamUrl, name, track.index);
        });
        audioTrackMenu.appendChild(opt);
      });

      audioTrackContainer.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('Failed to fetch audio tracks metadata:', err);
  }
}

// Render dropdown options using Safari's native AudioTrackList API
function populateNativeAudioTracks(audioTracks) {
  audioTrackMenu.innerHTML = '';
  
  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    const opt = document.createElement('div');
    opt.className = 'audio-option';
    if (track.enabled) {
      opt.className += ' active';
      currentAudioTrack = i;
    }
    opt.textContent = `${track.label || track.language || `Track ${i + 1}`} (${(track.language || 'und').toUpperCase()})`;
    
    opt.addEventListener('click', () => {
      // Disable all tracks, then enable this one
      for (let j = 0; j < audioTracks.length; j++) {
        audioTracks[j].enabled = (j === i);
      }
      
      // Update active UI classes
      const options = audioTrackMenu.querySelectorAll('.audio-option');
      options.forEach((el, idx) => {
        if (idx === i) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
      
      currentAudioTrack = i;
      logToConsole(`Switched local audio track to: ${track.label || track.language || `Track ${i + 1}`}`, 'system');
    });
    audioTrackMenu.appendChild(opt);
  }
  
  audioTrackContainer.classList.remove('hidden');
}

// Swaps transcoded audio streams seamlessly
function switchAudioTrack(fileId, baseStreamUrl, name, index) {
  currentAudioTrack = index;

  // Update active UI class
  const options = audioTrackMenu.querySelectorAll('.audio-option');
  options.forEach((opt, idx) => {
    if (idx === index) {
      opt.classList.add('active');
    } else {
      opt.classList.remove('active');
    }
  });

  const curTime = video.currentTime;
  const wasPlaying = !video.paused;

  logToConsole(`Switching audio language to track ${index + 1}...`, 'system');

  if (_transcodePollTimer) {
    clearInterval(_transcodePollTimer);
    _transcodePollTimer = null;
  }

  // Construct target proxy stream URL with audioTrack query param
  const newStreamUrl = `/api/stream-video?id=${fileId}&audioTrack=${index}`;

  // Reset video source
  video.removeAttribute('src');
  video.load();

  // Show loading / transcoding progress
  _showTranscodeProgress(fileId, name, newStreamUrl, curTime, wasPlaying);
}

changeVideoBtn.addEventListener('click', () => {
  sourceSelector.classList.remove('hidden');
  video.pause();
});

// ==========================================
// 4. Custom Video Player Controls Logic
// ==========================================

// Autohide controls on idle
let controlsTimeout;
playerContainer.addEventListener('mousemove', showControlsAndResetTimer);
playerContainer.addEventListener('touchstart', showControlsAndResetTimer);

function showControlsAndResetTimer() {
  playerContainer.classList.remove('idle');
  clearTimeout(controlsTimeout);
  if (!video.paused) {
    controlsTimeout = setTimeout(() => {
      playerContainer.classList.add('idle');
    }, 3500);
  }
}

// 4.1 Play / Pause
function togglePlayPause() {
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

playPauseBtn.addEventListener('click', togglePlayPause);
// Play click directly on video tag
video.addEventListener('click', togglePlayPause);

// 4.2 Skip Back & Forward (10 seconds)
skipBackBtn.addEventListener('click', () => {
  let target = Math.max(0, video.currentTime - 10);
  video.currentTime = target;
  broadcastStateChange('seek', target);
});

skipForwardBtn.addEventListener('click', () => {
  let target = Math.min(video.duration || 0, video.currentTime + 10);
  video.currentTime = target;
  broadcastStateChange('seek', target);
});

// 4.3 Timeline & Seek
timelineContainer.addEventListener('click', seekVideo);
let isDraggingTimeline = false;

timelineContainer.addEventListener('mousedown', (e) => {
  isDraggingTimeline = true;
  seekVideo(e);
});

window.addEventListener('mousemove', (e) => {
  if (isDraggingTimeline) seekVideo(e);
});

window.addEventListener('mouseup', () => {
  isDraggingTimeline = false;
});

function seekVideo(e) {
  if (!video.duration) return;
  const rect = timelineContainer.getBoundingClientRect();
  let pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  
  const targetTime = pct * video.duration;
  video.currentTime = targetTime;
  
  // Show quick handle jump
  timelineCurrent.style.width = `${pct * 100}%`;
  
  // Broadcast seek immediately
  broadcastStateChange('seek', targetTime);
}

// Timeline scrub preview
timelineContainer.addEventListener('mousemove', (e) => {
  if (!video.duration) return;
  const rect = timelineContainer.getBoundingClientRect();
  let pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  const time = pct * video.duration;
  
  timelineScrubPreview.textContent = formatTime(time);
  timelineScrubPreview.style.left = `${(e.clientX - rect.left)}px`;
});

// 4.4 Volume
volumeSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  video.volume = val;
  video.muted = (val === 0);
  updateVolumeUI();
});

volumeBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  updateVolumeUI();
});

function updateVolumeUI() {
  if (video.muted || video.volume === 0) {
    document.querySelector('.volume-high-icon').classList.add('hidden');
    document.querySelector('.volume-mute-icon').classList.remove('hidden');
    volumeSlider.value = 0;
  } else {
    document.querySelector('.volume-high-icon').classList.remove('hidden');
    document.querySelector('.volume-mute-icon').classList.add('hidden');
    volumeSlider.value = video.volume;
  }
}

// 4.5 Speed options
document.querySelectorAll('.speed-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    const rate = parseFloat(e.target.getAttribute('data-speed'));
    video.playbackRate = rate;
    speedBtn.textContent = `${rate === 1.0 ? 'Normal' : rate + 'x'}`;
    
    // Toggle active classes
    document.querySelectorAll('.speed-option').forEach(o => o.classList.remove('active'));
    e.target.classList.add('active');

    broadcastStateChange('rate', video.currentTime, rate);
  });
});

// 4.6 Fullscreen & Theater mode
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    playerContainer.requestFullscreen().catch(err => {
      alert(`Error trying to enable full-screen: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
});

theaterBtn.addEventListener('click', () => {
  playerContainer.classList.toggle('theater-mode');
  document.body.classList.toggle('theater-mode');
});

// Keybinds (Space for play/pause, Arrow keys for skips)
window.addEventListener('keydown', (e) => {
  // Only register if target is body (not typing in inputs)
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    togglePlayPause();
  } else if (e.key === 'ArrowRight') {
    let target = Math.min(video.duration || 0, video.currentTime + 5);
    video.currentTime = target;
    broadcastStateChange('seek', target);
  } else if (e.key === 'ArrowLeft') {
    let target = Math.max(0, video.currentTime - 5);
    video.currentTime = target;
    broadcastStateChange('seek', target);
  } else if (e.key === 'f' || e.key === 'F') {
    fullscreenBtn.click();
  } else if (e.key === 't' || e.key === 'T') {
    theaterBtn.click();
  }
});

// 4.7 Video Element Event Handlers for Synchronization
video.addEventListener('play', () => {
  playPauseBtn.querySelector('.play-icon').classList.add('hidden');
  playPauseBtn.querySelector('.pause-icon').classList.remove('hidden');
  showControlsAndResetTimer();
  
  if (isApplyingRemoteEvent) return;
  broadcastStateChange('play', video.currentTime);
});

video.addEventListener('pause', () => {
  playPauseBtn.querySelector('.play-icon').classList.remove('hidden');
  playPauseBtn.querySelector('.pause-icon').classList.add('hidden');
  
  if (isApplyingRemoteEvent) return;
  broadcastStateChange('pause', video.currentTime);
});

video.addEventListener('timeupdate', () => {
  if (isDraggingTimeline) return;
  
  // Update progress bar
  const duration = video.duration || 0;
  const current = video.currentTime || 0;
  if (duration > 0) {
    const pct = (current / duration) * 100;
    timelineCurrent.style.width = `${pct}%`;
  }
  timeCurrentLbl.textContent = formatTime(current);
});

video.addEventListener('durationchange', () => {
  timeDurationLbl.textContent = formatTime(video.duration || 0);
});

video.addEventListener('progress', () => {
  // Update buffer bar
  if (video.buffered.length > 0 && video.duration) {
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    const pct = (bufferedEnd / video.duration) * 100;
    timelineBuffered.style.width = `${pct}%`;
  }
});

video.addEventListener('error', () => {
  const err = video.error;
  const code = err ? err.code : '?';
  const msg = err ? err.message : 'Unknown error';

  if (currentLoadedVideo && currentLoadedVideo.streamUrl && currentLoadedVideo.streamUrl.startsWith('/api/stream-video')) {
    // Proxy stream failed — likely Google Drive access issue or server restart
    logToConsole(`❌ Proxy stream failed (code ${code}): ${msg}. The server may still be transcoding — try again in a moment.`, 'system');
    const retryBtn = document.getElementById('manual-resync-btn');
    if (retryBtn) retryBtn.title = 'Retry loading video';
  } else if (currentLoadedVideo && currentLoadedVideo.isLocal) {
    logToConsole(`Local playback failed for: ${currentLoadedVideo.name}. Your browser may not support this codec.`, 'system');
    alert(`Format Error: Cannot decode "${currentLoadedVideo.name}". Please use an .mp4 (H.264) file, or drag the file into the Watch Together window.`);
  } else {
    logToConsole(`Video error (code ${code}): ${msg}`, 'system');
  }
});

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  
  if (h > 0) {
    return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ==========================================
// 5. Video Playback Synchronization Mechanics
// ==========================================

let pendingProgrammaticUpdate = null;

function runProgrammaticUpdate(fn) {
  isApplyingRemoteEvent = true;
  try {
    fn();
  } catch (error) {
    console.error('Error in programmatic update:', error);
  } finally {
    setTimeout(() => {
      isApplyingRemoteEvent = false;
    }, 250);
  }
}

// Broadcast client changes to server
function broadcastStateChange(action, time, speed = null) {
  if (!socket) return;
  
  socket.emit('video-state-change', {
    action,
    time,
    speed: speed || video.playbackRate,
    timestamp: Date.now()
  });
  
  logToConsole(`Broadcasted local action: ${action} at ${formatTime(time)}`, 'action');
}

function applyVideoState(time, shouldPlay) {
  pendingProgrammaticUpdate = { time, shouldPlay };
  
  const apply = () => {
    if (!pendingProgrammaticUpdate) return;
    
    video.removeEventListener('loadedmetadata', apply);
    
    const targetTime = pendingProgrammaticUpdate.time;
    const playState = pendingProgrammaticUpdate.shouldPlay;
    pendingProgrammaticUpdate = null;

    runProgrammaticUpdate(() => {
      if (targetTime !== null && targetTime !== undefined && isFinite(targetTime)) {
        const duration = video.duration || 0;
        const target = duration > 0 ? Math.max(0, Math.min(duration, targetTime)) : targetTime;
        video.currentTime = target;
      }
      if (playState) {
        video.play().catch(e => console.log('Autoplay blocked: ', e));
      } else {
        video.pause();
      }
    });
  };

  if (video.readyState >= 1) {
    apply();
  } else {
    video.removeEventListener('loadedmetadata', apply);
    video.addEventListener('loadedmetadata', apply);
  }
}

// Receive remote state changes from room
function handleRemoteVideoState(data) {
  const { action, time, speed, timestamp, senderUsername } = data;
  
  // Calculate latency delay to adjust seek time slightly
  const delay = (Date.now() - timestamp) / 1000;
  const latencyAdjustedTime = time + (action === 'play' ? delay : 0);

  logToConsole(`Received remote action from ${senderUsername}: ${action} at ${formatTime(time)}`, 'user');

  if (action === 'play') {
    applyVideoState(latencyAdjustedTime, true);
    setSyncIndicator('synced');
  } else if (action === 'pause') {
    applyVideoState(time, false);
    setSyncIndicator('synced');
  } else if (action === 'seek') {
    const playState = data.playing !== undefined ? data.playing : !video.paused;
    applyVideoState(latencyAdjustedTime, playState);
    setSyncIndicator('synced');
  } else if (action === 'rate') {
    runProgrammaticUpdate(() => {
      video.playbackRate = speed;
      // Update UI speed text
      speedBtn.textContent = `${speed === 1.0 ? 'Normal' : speed + 'x'}`;
    });
  }
}

// Heartbeat Loop to monitor latency drift / disconnects
function startHeartbeatTimer() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  
  heartbeatInterval = setInterval(() => {
    if (!socket || video.paused || !video.src || isApplyingRemoteEvent) return;
    
    // Broadcast heartbeat with current status
    socket.emit('video-state-change', {
      action: 'heartbeat',
      time: video.currentTime,
      speed: video.playbackRate,
      timestamp: Date.now()
    });
  }, 4000);
}

// Handle incoming heartbeats from other peers
// If drift is detected (> 2.0 seconds), flag as lagging and display resync modal
function handleRemoteHeartbeat(data) {
  if (!video.src || isApplyingRemoteEvent || isDraggingTimeline) return;

  const localTime = video.currentTime;
  const remoteTime = data.time;
  const drift = Math.abs(localTime - remoteTime);

  if (drift > 2.0) {
    setSyncIndicator('lagging');
    
    // Store target sync coordinates
    pendingSyncTarget = {
      time: remoteTime + (Date.now() - data.timestamp) / 1000,
      playing: true
    };
    
    // Auto-prompt sync consent
    showResyncPrompt();
  }
}

// Manual Resync Trigger
manualResyncBtn.addEventListener('click', () => {
  if (!socket) return;
  
  // Ask other peers to broadcast their current coordinates
  socket.emit('video-state-change', {
    action: 'request-sync-anchor',
    timestamp: Date.now()
  });
  
  logToConsole('Requested synchronization anchor from peers...', 'action');
});

// Handle sync anchor requests
function handleSyncAnchorRequest(data) {
  if (!socket) return;
  // Reply back immediately with our time and status so requesting peer can sync
  socket.emit('video-state-change', {
    action: 'seek',
    time: video.currentTime,
    playing: !video.paused,
    timestamp: Date.now()
  });
}

function setSyncIndicator(state) {
  if (state === 'synced') {
    syncIndicator.classList.remove('lagging');
    syncIndicator.querySelector('.sync-text').textContent = 'Synced';
  } else {
    syncIndicator.classList.add('lagging');
    syncIndicator.querySelector('.sync-text').textContent = 'Lagging';
  }
}

function showResyncPrompt() {
  // Show user consent overlay inside video container
  resyncAlertOverlay.classList.remove('hidden');
}

resyncAcceptBtn.addEventListener('click', () => {
  if (pendingSyncTarget) {
    logToConsole(`Syncing video with room host to ${formatTime(pendingSyncTarget.time)}`);
    runProgrammaticUpdate(() => {
      video.currentTime = pendingSyncTarget.time;
      if (pendingSyncTarget.playing) {
        video.play().catch(err => console.log(err));
      } else {
        video.pause();
      }
    });
    setSyncIndicator('synced');
  }
  resyncAlertOverlay.classList.add('hidden');
  pendingSyncTarget = null;
});

resyncIgnoreBtn.addEventListener('click', () => {
  resyncAlertOverlay.classList.add('hidden');
  pendingSyncTarget = null;
});

// ==========================================
// 6. WebRTC floating call widget (Real-time Audio & Video)
// ==========================================

// Request video and audio stream
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 160 },
        height: { ideal: 160 },
        facingMode: 'user'
      },
      audio: true
    });
    
    localVideo.srcObject = localStream;
    localVideoWrapper.querySelector('.badge-avatar').classList.add('hidden');
    
    isCallActive = true;
    callWidget.classList.remove('inactive');
    startCallBtn.classList.add('hidden');
    
    logToConsole('Camera and Microphone activated.', 'system');

    // If there are already peers in the room, call them!
    peers.forEach(peer => {
      initiateWebRTCCall(peer.socketId);
    });

  } catch (err) {
    console.error('Error accessing local media: ', err);
    alert('Could not start video call. Please ensure camera/microphone permissions are granted.');
  }
}

startCallBtn.addEventListener('click', startLocalMedia);

// Establish connection with a specific peer
function initiateWebRTCCall(peerSocketId) {
  if (peerConnections.has(peerSocketId)) return;

  logToConsole(`Establishing WebRTC connection with peer: ${peerSocketId}...`, 'system');
  
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(peerSocketId, pc);

  // Add our local media tracks to peer connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // Handle remote track arriving
  pc.ontrack = (event) => {
    logToConsole(`Received video stream from peer: ${peerSocketId}`);
    remoteVideo.srcObject = event.streams[0];
    peerAvatar.classList.add('hidden');
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit('webrtc-signal', {
        targetSocketId: peerSocketId,
        signal: { ice: event.candidate }
      });
    }
  };

  // Create WebRTC Offer
  pc.createOffer().then(offer => {
    return pc.setLocalDescription(offer);
  }).then(() => {
    socket.emit('webrtc-signal', {
      targetSocketId: peerSocketId,
      signal: { sdp: pc.localDescription },
      senderState: { videoEnabled, audioEnabled }
    });
  }).catch(err => {
    console.error('Failed to create WebRTC offer:', err);
  });
}

// Receive signal relays from server
async function handleWebRTCSignal(senderSocketId, senderUsername, signal, senderState) {
  // Lazy init connection if it doesn't exist
  if (!peerConnections.has(senderSocketId)) {
    // If we receive an offer but haven't started local media, we prompt them to start local media
    // or we create a receive-only connection. Let's create the connection.
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(senderSocketId, pc);

    // Feed local tracks if available
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      peerAvatar.classList.add('hidden');
      peerLabel.textContent = senderUsername;
      callWidget.classList.remove('inactive');
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', {
          targetSocketId: senderSocketId,
          signal: { ice: event.candidate }
        });
      }
    };
  }

  const pc = peerConnections.get(senderSocketId);

  // Apply signaling data
  if (signal.sdp) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      
      // If we received an Offer, we need to create an Answer
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', {
          targetSocketId: senderSocketId,
          signal: { sdp: pc.localDescription },
          senderState: { videoEnabled, audioEnabled }
        });
        logToConsole(`Connected with ${senderUsername}!`, 'system');
      }
    } catch (e) {
      console.error('Signaling transaction error: ', e);
    }
  } else if (signal.ice) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.ice));
    } catch (e) {
      console.error('Failed to add remote ICE candidate: ', e);
    }
  }

  // Set peer visual states
  if (senderState) {
    handlePeerMediaStateChange(senderSocketId, senderState);
  }
}

// Clean connection on peer exit
function closePeerConnection(socketId) {
  if (peerConnections.has(socketId)) {
    const pc = peerConnections.get(socketId);
    pc.close();
    peerConnections.delete(socketId);
  }
  
  // Clean streams
  remoteVideo.srcObject = null;
  peerAvatar.classList.remove('hidden');
  peerLabel.textContent = 'Friend';
  
  if (peerConnections.size === 0) {
    // If no other calls, show widget inactive
    callWidget.classList.add('inactive');
  }
}

// Toggle Local Video / Voice mute
toggleVideoBtn.addEventListener('click', () => {
  if (!localStream) return;
  
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach(track => {
    track.enabled = videoEnabled;
  });

  if (videoEnabled) {
    toggleVideoBtn.classList.remove('muted');
    toggleVideoBtn.querySelector('.video-on-icon').classList.remove('hidden');
    toggleVideoBtn.querySelector('.video-off-icon').classList.add('hidden');
    localVideoWrapper.querySelector('.badge-avatar').classList.add('hidden');
  } else {
    toggleVideoBtn.classList.add('muted');
    toggleVideoBtn.querySelector('.video-on-icon').classList.add('hidden');
    toggleVideoBtn.querySelector('.video-off-icon').classList.remove('hidden');
    localVideoWrapper.querySelector('.badge-avatar').classList.remove('hidden');
  }

  // Notify server
  socket.emit('media-state-change', { videoEnabled, audioEnabled });
});

toggleAudioBtn.addEventListener('click', () => {
  if (!localStream) return;
  
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = audioEnabled;
  });

  if (audioEnabled) {
    toggleAudioBtn.classList.remove('muted');
    toggleAudioBtn.querySelector('.audio-on-icon').classList.remove('hidden');
    toggleAudioBtn.querySelector('.audio-off-icon').classList.add('hidden');
    localVideoWrapper.classList.remove('camera-muted');
  } else {
    toggleAudioBtn.classList.add('muted');
    toggleAudioBtn.querySelector('.audio-on-icon').classList.add('hidden');
    toggleAudioBtn.querySelector('.audio-off-icon').classList.remove('hidden');
    localVideoWrapper.classList.add('camera-muted');
  }

  // Notify server
  socket.emit('media-state-change', { videoEnabled, audioEnabled });
});

function handlePeerMediaStateChange(socketId, mediaState) {
  const { videoEnabled: pVideo, audioEnabled: pAudio } = mediaState;
  
  if (pVideo) {
    peerAvatar.classList.add('hidden');
  } else {
    peerAvatar.classList.remove('hidden');
  }
  
  // Show glowing neon indicator based on voice activity simulation or just muted states
  if (pAudio) {
    callWidget.classList.remove('speaking');
  } else {
    // If muted, flash border red or dim
  }
}

// ==========================================
// 7. Draggable Circle Badge Logic (Mouse & Touch)
// ==========================================

let isDragging = false;
let startX, startY;
let initialX, initialY;

callWidget.addEventListener('mousedown', dragStart);
callWidget.addEventListener('touchstart', dragStart, { passive: true });

function dragStart(e) {
  // Ignore dragging if they clicked control buttons (Mute, Camera toggle, Start Call)
  if (e.target.closest('.call-ctrl-btn')) return;

  isDragging = true;
  
  // Support both mouse and touch coords
  const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
  const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
  
  startX = clientX;
  startY = clientY;
  
  const rect = callWidget.getBoundingClientRect();
  initialX = rect.left;
  initialY = rect.top;

  // Change cursor styling on active drag
  callWidget.style.transition = 'none';

  if (e.type === 'mousedown') {
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', dragEnd);
  } else {
    document.addEventListener('touchmove', dragMove, { passive: false });
    document.addEventListener('touchend', dragEnd);
  }
}

function dragMove(e) {
  if (!isDragging) return;
  if (e.type === 'touchmove') e.preventDefault(); // Prevent standard page scroll during touch-drag
  
  const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
  const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
  
  const dx = clientX - startX;
  const dy = clientY - startY;
  
  let newX = initialX + dx;
  let newY = initialY + dy;
  
  // Viewport bounds locking
  const widgetRect = callWidget.getBoundingClientRect();
  const maxX = window.innerWidth - widgetRect.width;
  const maxY = window.innerHeight - widgetRect.height;
  
  newX = Math.max(0, Math.min(newX, maxX));
  newY = Math.max(0, Math.min(newY, maxY));
  
  callWidget.style.left = `${newX}px`;
  callWidget.style.top = `${newY}px`;
  callWidget.style.right = 'auto'; // Remove standard positioning values
  callWidget.style.bottom = 'auto';
}

function dragEnd() {
  isDragging = false;
  callWidget.style.transition = 'box-shadow 0.3s ease, border-color 0.3s ease, opacity 0.3s';
  
  document.removeEventListener('mousemove', dragMove);
  document.removeEventListener('mouseup', dragEnd);
  document.removeEventListener('touchmove', dragMove);
  document.removeEventListener('touchend', dragEnd);
}

// Recalculate call widget boundaries on window resize or fullscreen toggle
function adjustWidgetPositionBounds() {
  setTimeout(() => {
    const rect = callWidget.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;
    
    if (callWidget.style.left) {
      let currentLeft = parseFloat(callWidget.style.left);
      let currentTop = parseFloat(callWidget.style.top);
      
      let newLeft = Math.max(0, Math.min(currentLeft, maxX));
      let newTop = Math.max(0, Math.min(currentTop, maxY));
      
      callWidget.style.left = `${newLeft}px`;
      callWidget.style.top = `${newTop}px`;
    }
  }, 100);
}

document.addEventListener('fullscreenchange', adjustWidgetPositionBounds);
document.addEventListener('webkitfullscreenchange', adjustWidgetPositionBounds);
window.addEventListener('resize', adjustWidgetPositionBounds);

// ==========================================
// 8. Console/Activity Logging & Sidebar Details
// ==========================================

function logToConsole(message, type = 'system') {
  const entry = document.createElement('div');
  entry.classList.add('log-entry');
  
  if (type === 'system') {
    entry.classList.add('system-log');
    entry.textContent = `[System] ${message}`;
  } else if (type === 'action') {
    entry.classList.add('action-log');
    entry.textContent = `[Action] ${message}`;
  } else if (type === 'user') {
    entry.classList.add('user-log');
    entry.textContent = `${message}`;
  }
  
  consoleLogs.appendChild(entry);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

function updateSidebarMembers() {
  membersList.innerHTML = '';
  
  // Always include ourselves
  const selfItem = createMemberItem(username, true);
  membersList.appendChild(selfItem);
  
  // Include other peers
  peers.forEach(peer => {
    const item = createMemberItem(peer.username, false);
    membersList.appendChild(item);
  });
}

function createMemberItem(name, isSelf) {
  const item = document.createElement('div');
  item.classList.add('member-item');
  
  const info = document.createElement('div');
  info.classList.add('member-info');
  
  const avatar = document.createElement('div');
  avatar.classList.add('member-avatar');
  avatar.textContent = name.substring(0, 1).toUpperCase();
  
  const nameLbl = document.createElement('span');
  nameLbl.textContent = isSelf ? `${name} (You)` : name;
  
  info.appendChild(avatar);
  info.appendChild(nameLbl);
  
  item.appendChild(info);
  return item;
}

// ==========================================
// 9. Playlist & Folder Import Logic
// ==========================================

// Toggle Folder Import Overlay
importFolderBtn.addEventListener('click', () => {
  folderImportOverlay.classList.remove('hidden');
  folderUrlInput.focus();
});

closeFolderImportBtn.addEventListener('click', () => {
  folderImportOverlay.classList.add('hidden');
  folderUrlInput.value = '';
});

// Fetch Folder button trigger
fetchFolderBtn.addEventListener('click', async () => {
  const url = folderUrlInput.value.trim();
  if (!url) {
    alert('Please enter a Google Drive folder URL or ID.');
    folderUrlInput.focus();
    return;
  }

  // Show loading state
  fetchFolderSpinner.classList.remove('hidden');
  fetchBtnLbl.textContent = 'Fetching Folder...';
  fetchFolderBtn.disabled = true;

  try {
    const res = await fetch(`/api/gdrive-folder?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch folder contents');
    }

    if (!data.files || data.files.length === 0) {
      alert('No video files found in this folder. Make sure the folder sharing is public and contains video files.');
    } else {
      playlist = data.files;
      updatePlaylistUI();
      
      // Sync playlist with room
      socket.emit('playlist-update', playlist);
      logToConsole(`Imported playlist: ${playlist.length} videos found.`, 'system');
      
      // Close overlay
      folderImportOverlay.classList.add('hidden');
      folderUrlInput.value = '';
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    // Hide loading state
    fetchFolderSpinner.classList.add('hidden');
    fetchBtnLbl.textContent = 'Load Folder Videos';
    fetchFolderBtn.disabled = false;
  }
});

function updatePlaylistUI() {
  playlistContainer.innerHTML = '';
  
  if (playlist.length === 0) {
    playlistContainer.innerHTML = `<div class="playlist-empty-state">No videos in playlist. Click "Import" to load a Google Drive folder.</div>`;
    return;
  }

  playlist.forEach((file) => {
    const item = document.createElement('div');
    item.classList.add('playlist-item');
    if (currentPlaylistVideo && currentPlaylistVideo.id === file.id) {
      item.classList.add('active');
    }

    // Convert size to human readable MB
    const sizeMB = file.size ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'Size unknown';

    item.innerHTML = `
      <div class="playlist-item-icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="23 7 16 12 23 17 23 7"></polygon>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
        </svg>
      </div>
      <div class="playlist-item-info">
        <span class="playlist-item-name" title="${file.name}">${file.name}</span>
        <span class="playlist-item-meta">${sizeMB}</span>
      </div>
    `;

    item.addEventListener('click', () => {
      selectPlaylistVideo(file);
    });

    playlistContainer.appendChild(item);
  });
}

function selectPlaylistVideo(file) {
  currentPlaylistVideo = file;
  updatePlaylistUI();

  // Show selection banner in source-selector
  roomActiveVideoName.textContent = file.name;
  roomActiveVideoBanner.classList.remove('hidden');
  
  // Show source-selector overlay so user can choose Local File vs Web Stream
  sourceSelector.classList.remove('hidden');

  // Sync selection with room
  if (socket) {
    socket.emit('video-selected', file);
  }

  logToConsole(`Selected room video: ${file.name}. Please select local file or stream it.`, 'action');
}

function applyRemoteVideoSelection(videoInfo) {
  // If the incoming streamUrl is empty, check if we can retrieve it from the playlist
  if (!videoInfo.streamUrl && playlist) {
    const playlistItem = playlist.find(item => item.name === videoInfo.name);
    if (playlistItem && playlistItem.streamUrl) {
      videoInfo.streamUrl = playlistItem.streamUrl;
    }
  }

  // If the exact same video is already loaded, keep the source selector closed and return
  const isAlreadyLoaded = currentLoadedVideo && currentLoadedVideo.name === videoInfo.name;
  if (isAlreadyLoaded) {
    sourceSelector.classList.add('hidden');
    return;
  }

  currentPlaylistVideo = videoInfo;
  updatePlaylistUI();

  logToConsole(`Room peer selected video: ${videoInfo.name}`, 'system');

  // Show selection banner in source-selector
  roomActiveVideoName.textContent = videoInfo.name;
  roomActiveVideoBanner.classList.remove('hidden');
  
  // Show source-selector overlay
  sourceSelector.classList.remove('hidden');

  // If a streamUrl is available, automatically load the stream for the peer if not already loaded
  if (videoInfo.streamUrl) {
    const isAlreadyLoaded = currentLoadedVideo && 
                            currentLoadedVideo.name === videoInfo.name && 
                            currentLoadedVideo.streamUrl === videoInfo.streamUrl;
    if (!isAlreadyLoaded) {
      logToConsole(`Automatically loading web stream for: ${videoInfo.name}`, 'system');
      const wasApplying = isApplyingRemoteEvent;
      isApplyingRemoteEvent = true;
      try {
        loadVideoSource(videoInfo.streamUrl, videoInfo.name, false);
      } finally {
        isApplyingRemoteEvent = wasApplying;
      }
    }
  }
}

// Bind click handler for Web Stream button in room selection banner
playActiveStreamBtn.addEventListener('click', () => {
  if (currentPlaylistVideo) {
    let streamUrl = currentPlaylistVideo.streamUrl;
    if (!streamUrl && playlist) {
      const match = playlist.find(item => item.name === currentPlaylistVideo.name);
      if (match && match.streamUrl) {
        streamUrl = match.streamUrl;
      }
    }
    if (streamUrl) {
      loadVideoSource(streamUrl, currentPlaylistVideo.name, false);
      logToConsole(`Playing web stream for: ${currentPlaylistVideo.name}`, 'action');
    } else {
      alert('No web stream URL found for this video. Please enter it manually in Method 2.');
    }
  }
});
