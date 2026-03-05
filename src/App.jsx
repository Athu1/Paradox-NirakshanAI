import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';
import { CAMERAS, EMERGENCY_SERVICES, SCENARIOS, API_BASE, GOOGLE_MAPS_API_KEY } from './data.js';
import { haversineKm, findNearest, validateReport, formatTime, formatDateTimeISO } from './utils.js';

// ─── Clock ────────────────────────────────────────────────────────────────
function Clock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span className="clock">{formatTime(time)}</span>;
}

// ─── MoveNet MultiPose Loader ──────────────────────────────────────────────
let moveNetModel = null;
let moveNetLoading = false;
function loadMoveNet() {
  if (moveNetModel || moveNetLoading) return;
  moveNetLoading = true;

  const tf = document.createElement('script');
  tf.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.21.0/dist/tf-core.min.js';
  tf.onload = () => {
    const tfconv = document.createElement('script');
    tfconv.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter@4.21.0/dist/tf-converter.min.js';
    tfconv.onload = () => {
      const tfback = document.createElement('script');
      tfback.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.21.0/dist/tf-backend-webgl.min.js';
      tfback.onload = () => {
        const poseDetect = document.createElement('script');
        poseDetect.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js';
        poseDetect.onload = async () => {
          try {
            await window.tf.setBackend('webgl');
            await window.tf.ready();
            moveNetModel = await window.poseDetection.createDetector(
              window.poseDetection.SupportedModels.MoveNet,
              { modelType: window.poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING, enableTracking: true }
            );
            console.log('[MoveNet] ✅ Model ready!');
          } catch (e) { console.error('[MoveNet] load error:', e); }
        };
        document.head.appendChild(poseDetect);
      };
      document.head.appendChild(tfback);
    };
    document.head.appendChild(tfconv);
  };
  document.head.appendChild(tf);
}
loadMoveNet();

// ─── COCO-SSD Loader (reuses TF.js already loaded by MoveNet) ────────────
let cocoModel = null;
function loadCocoSSD() {
  // Wait for tf to be ready then load coco-ssd
  const tryLoad = () => {
    if (!window.tf || !window.tf.ready) { setTimeout(tryLoad, 500); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';
    s.onload = () => {
      window.cocoSsd.load({ base: 'lite_mobilenet_v2' }).then(m => {
        cocoModel = m;
        console.log('[COCO-SSD] ✅ Object detection model ready!');
      }).catch(e => console.error('[COCO-SSD] load error:', e));
    };
    document.head.appendChild(s);
  };
  setTimeout(tryLoad, 3000); // give TF.js time to initialise first
}
loadCocoSSD();

// ── Abandoned / Valuable objects (tracked by timer) ──────────────────────
const TRACKED_CLASSES = new Set([
  // Bags & carry items
  'backpack', 'handbag', 'suitcase',
  // Valuables — electronics
  'cell phone', 'laptop', 'keyboard', 'mouse', 'remote', 'tv',
  // Containers / drinks
  'bottle', 'cup', 'wine glass', 'bowl',
  // Personal accessories (COCO-SSD proxies for jewellery/specs/wallet)
  'tie', 'umbrella',
  // Documents and misc
  'book', 'clock', 'vase',
  // Sports
  'sports ball', 'frisbee', 'skis', 'snowboard',
]);

// ── Dangerous objects — IMMEDIATE CRITICAL  ─────────────────────
const DANGEROUS_CLASSES = new Set([
  'knife',        // Coco-SSD class — yes, detectable
  'scissors',     // Sharp object
  'baseball bat', // Blunt weapon
  'tennis racket', // Blunt weapon
  'fork',         // Improvised weapon
  'spoon',        // Improvised weapon
]);
// Note: ‘gun’/‘firearm’ is NOT in COCO-SSD’s 90 classes.
// A custom YOLOv8 model would be needed for gun detection.

// Dangerous class labels
const DANGER_LABEL = {
  'knife': '🔪 KNIFE — WEAPON',
  'scissors': '✂ SCISSORS — SHARP',
  'baseball bat': '🪺 BAT — BLUNT WEAPON',
  'tennis racket': '🎾 RACKET — BLUNT',
  'fork': '🍴 FORK — SHARP',
  'spoon': '🥄 SPOON — OBJECT',
};

// Valuable item friendly names
const CLASS_LABEL = {
  'handbag': 'BAG / WALLET',
  'backpack': 'BACKPACK',
  'suitcase': 'SUITCASE / LUGGAGE',
  'tie': 'JEWELLERY / ACC',
  'wine glass': 'GLASS / SPECS',
  'cell phone': 'PHONE',
  'laptop': 'LAPTOP',
  'tv': 'SCREEN',
  'bottle': 'BOTTLE',
  'umbrella': 'UMBRELLA',
  'clock': 'WATCH / CLOCK',
  'remote': 'REMOTE / DEVICE',
  'keyboard': 'KEYBOARD',
};

// Grid cell for centroid matching (reduces jitter false mismatches)
const gridCell = (x, y, w, h, G = 60) =>
  `${Math.round((x + w / 2) / G)}_${Math.round((y + h / 2) / G)}`;

// Draw an object box overlay
function drawObjectBox(ctx, bbox, label, state, ageMs) {
  const [x, y, w, h] = bbox;
  const ageSec = Math.floor(ageMs / 1000);
  const isAbandoned = state === 'ABANDONED';
  const isPending = state === 'PENDING';   // first seen, timer running

  const pulse = isAbandoned && Math.floor(Date.now() / 400) % 2 === 0;
  const color = isAbandoned ? (pulse ? '#ff3b30' : '#ff6b6b') : isPending ? '#ff9f0a' : '#30d158';

  ctx.strokeStyle = color;
  ctx.lineWidth = isAbandoned ? 3 : 2;
  ctx.strokeRect(x, y, w, h);

  // Corner ticks
  const t = 12;
  [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => {
    ctx.beginPath(); ctx.moveTo(cx, cy + (cy === y ? t : -t)); ctx.lineTo(cx, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + (cx === x ? t : -t), cy); ctx.lineTo(cx, cy); ctx.stroke();
  });

  // Label bar
  const tag = isAbandoned
    ? `🚨 ABANDONED ${label.toUpperCase()} ${ageSec}s`
    : `⌛ ${label.toUpperCase()} ${ageSec}s`;
  const tw = ctx.measureText(tag).width + 12;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 20, tw, 20);
  ctx.fillStyle = '#000';
  ctx.font = `bold 10px monospace`;
  ctx.fillText(tag, x + 6, y - 5);
}


// MoveNet keypoint indices
const KP = { nose: 0, lEye: 1, rEye: 2, lEar: 3, rEar: 4, lShoulder: 5, rShoulder: 6, lElbow: 7, rElbow: 8, lWrist: 9, rWrist: 10, lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnkle: 15, rAnkle: 16 };

// ─── Fight Heuristics ─────────────────────────────────────────────────────
function analyzePosesForFight(poses, prevPoses) {
  if (!poses || poses.length === 0) return { score: 0, reason: '' };
  let score = 0;
  const reasons = [];

  poses.forEach((pose, pi) => {
    const kp = pose.keypoints;
    const conf = k => kp[k]?.score > 0.3;
    const y = k => kp[k]?.y;
    const x = k => kp[k]?.x;

    // 1. Arms raised aggressively above shoulders
    if (conf(KP.lWrist) && conf(KP.lShoulder) && y(KP.lWrist) < y(KP.lShoulder) - 30) { score += 25; reasons.push('left arm raised'); }
    if (conf(KP.rWrist) && conf(KP.rShoulder) && y(KP.rWrist) < y(KP.rShoulder) - 30) { score += 25; reasons.push('right arm raised'); }

    // 2. Elbow bent sharply (punching position)
    if (conf(KP.lElbow) && conf(KP.lWrist) && conf(KP.lShoulder)) {
      const armSpread = Math.abs(x(KP.lWrist) - x(KP.lShoulder));
      if (armSpread > 60) { score += 15; reasons.push('arm extended'); }
    }

    // 3. Rapid wrist movement vs prev frame
    if (prevPoses && prevPoses[pi]) {
      const prev = prevPoses[pi].keypoints;
      [KP.lWrist, KP.rWrist].forEach(k => {
        if (kp[k] && prev[k] && kp[k].score > 0.3) {
          const vel = Math.hypot(kp[k].x - prev[k].x, kp[k].y - prev[k].y);
          if (vel > 30) { score += 20; reasons.push(`rapid wrist movement: ${Math.round(vel)}px`); }
        }
      });
    }

    // 4. Torso tilt (body lean during struggle)
    if (conf(KP.lShoulder) && conf(KP.rShoulder) && conf(KP.lHip) && conf(KP.rHip)) {
      const shoulderAngle = Math.abs(y(KP.lShoulder) - y(KP.rShoulder));
      if (shoulderAngle > 40) { score += 15; reasons.push('torso tilt'); }
    }
  });

  // 5. Two people very close (within 150px — struggling)
  if (poses.length >= 2) {
    const p1 = poses[0].keypoints[KP.nose], p2 = poses[1].keypoints[KP.nose];
    if (p1?.score > 0.3 && p2?.score > 0.3) {
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (dist < 150) { score += 30; reasons.push(`persons close (${Math.round(dist)}px apart)`); }
    }
  }

  return { score: Math.min(score, 100), reason: reasons.join(', ') };
}

// Draw skeleton
function drawPose(ctx, pose, isAlert) {
  const kp = pose.keypoints;
  const color = isAlert ? '#ff3b30' : '#bf5af2';
  const bones = [[KP.lShoulder, KP.rShoulder], [KP.lShoulder, KP.lElbow], [KP.lElbow, KP.lWrist], [KP.rShoulder, KP.rElbow], [KP.rElbow, KP.rWrist], [KP.lShoulder, KP.lHip], [KP.rShoulder, KP.rHip], [KP.lHip, KP.rHip], [KP.lHip, KP.lKnee], [KP.lKnee, KP.lAnkle], [KP.rHip, KP.rKnee], [KP.rKnee, KP.rAnkle]];
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  bones.forEach(([a, b]) => {
    if (kp[a]?.score > 0.3 && kp[b]?.score > 0.3) {
      ctx.beginPath(); ctx.moveTo(kp[a].x, kp[a].y); ctx.lineTo(kp[b].x, kp[b].y); ctx.stroke();
    }
  });
  kp.forEach(k => {
    if (k.score > 0.3) {
      ctx.beginPath(); ctx.arc(k.x, k.y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = color; ctx.fill();
    }
  });
  // Bounding box
  const visible = kp.filter(k => k.score > 0.3);
  if (visible.length > 0) {
    const xs = visible.map(k => k.x), ys = visible.map(k => k.y);
    const [x1, y1, x2, y2] = [Math.min(...xs) - 15, Math.min(...ys) - 15, Math.max(...xs) + 15, Math.max(...ys) + 15];
    ctx.strokeStyle = color; ctx.lineWidth = isAlert ? 3 : 1.5;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = color;
    const lbl = isAlert ? '⚠ AGGRESSIVE' : 'PERSON';
    ctx.fillRect(x1, y1 - 18, ctx.measureText(lbl).width + 10, 18);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace'; ctx.fillText(lbl, x1 + 5, y1 - 4);
  }
}

// ─── Webcam Feed ──────────────────────────────────────────────────────────
function WebcamFeed({ active, cameraId, status, onIncidentDetected, onSituationClear }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const prevPosesRef = useRef(null);
  const fightCooldownRef = useRef(0);
  const lowScoreSinceRef = useRef(null);
  const objectTrackerRef = useRef(new Map()); // key -> {class, bbox, firstSeen, lastSeen, state, triggered}

  useEffect(() => {
    if (!active) return;
    navigator.mediaDevices?.getUserMedia({ video: true, audio: false })
      .then(stream => {
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;

          const drawLoop = async () => {
            if (!videoRef.current) return;
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (moveNetModel && video.readyState >= 2) {
              try {
                const poses = await moveNetModel.estimatePoses(video);
                const { score, reason } = analyzePosesForFight(poses, prevPosesRef.current);
                const alertThreshold = status === 'SUSPICIOUS' ? 50 : 60;
                const criticalThreshold = status === 'SUSPICIOUS' ? 65 : 80;
                const isAlert = score >= alertThreshold;

                poses.forEach(pose => drawPose(ctx, pose, isAlert));

                // ── Heads-up display ────────────────────────────────
                const now = Date.now();
                const barW = Math.round((canvas.width - 20) * score / 100);
                ctx.fillStyle = isAlert ? 'rgba(255,59,48,0.8)' : 'rgba(30,30,50,0.7)';
                ctx.fillRect(8, canvas.height - 34, canvas.width - 16, 26);
                ctx.fillStyle = isAlert ? '#ff453a' : '#30d158';
                ctx.fillRect(10, canvas.height - 32, barW - 4, 22);
                ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace';
                ctx.fillText(`FIGHT SCORE: ${score}%  ${isAlert ? '⚠ ALERT' : '● CLEAR'}  (${poses.length} person${poses.length !== 1 ? 's' : ''})`, 14, canvas.height - 16);

                // ── Fight trigger ────────────────────────────────────
                if (isAlert && onIncidentDetected && now - fightCooldownRef.current > 15000) {
                  fightCooldownRef.current = now;
                  lowScoreSinceRef.current = null;
                  const severity = score >= criticalThreshold ? 'CRITICAL' : 'SUSPICIOUS';
                  onIncidentDetected({ incidentDetected: true, type: 'Physical Fight', severity, confidence: score, description: `MoveNet — ${reason}` });
                }

                // ── Auto-clear ───────────────────────────────────────
                if (score < 20) {
                  if (!lowScoreSinceRef.current) lowScoreSinceRef.current = now;
                  else if (now - lowScoreSinceRef.current > 10000 && onSituationClear) {
                    lowScoreSinceRef.current = null;
                    fightCooldownRef.current = 0;
                    onSituationClear(cameraId);
                  }
                } else { lowScoreSinceRef.current = null; }

                prevPosesRef.current = poses;

                // ── Abandoned Object Detection (COCO-SSD) ────────────
                if (cocoModel) {
                  const objs = await cocoModel.detect(video);
                  const tracker = objectTrackerRef.current;
                  const seenKeys = new Set();

                  // Get person centroids from MoveNet for proximity check
                  const personCentroids = poses.map(p => {
                    const vk = p.keypoints.filter(k => k.score > 0.3);
                    if (!vk.length) return null;
                    return { x: vk.reduce((s, k) => s + k.x, 0) / vk.length, y: vk.reduce((s, k) => s + k.y, 0) / vk.length };
                  }).filter(Boolean);

                  const dangerCooldowns = objectTrackerRef.current._dangerCooldowns || (objectTrackerRef.current._dangerCooldowns = {});

                  objs.forEach(obj => {
                    const isDangerous = DANGEROUS_CLASSES.has(obj.class);
                    const isValuable = TRACKED_CLASSES.has(obj.class);
                    if (!isDangerous && !isValuable) return;

                    // \u2500\u2500 DANGEROUS OBJECT PATH \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
                    if (isDangerous && obj.score >= 0.15) {
                      const dangerLabel = DANGER_LABEL[obj.class] || `\u26a0 ${obj.class.toUpperCase()}`;
                      const [bx, by, bw, bh] = obj.bbox;

                      // Pulsing red box
                      const pulse = Math.floor(Date.now() / 250) % 2 === 0;
                      ctx.strokeStyle = pulse ? '#ff0000' : '#ff6b6b';
                      ctx.lineWidth = 4;
                      ctx.strokeRect(bx, by, bw, bh);
                      // Fill flash
                      ctx.fillStyle = pulse ? 'rgba(255,0,0,0.15)' : 'rgba(255,59,48,0.05)';
                      ctx.fillRect(bx, by, bw, bh);
                      // Warning bar
                      const tw = ctx.measureText(dangerLabel).width + 14;
                      ctx.fillStyle = '#ff0000';
                      ctx.fillRect(bx, by - 24, tw, 24);
                      ctx.fillStyle = '#fff';
                      ctx.font = 'bold 12px monospace';
                      ctx.fillText(dangerLabel, bx + 6, by - 6);

                      // Immediate CRITICAL incident (once per object per 20s)
                      const dkey = `danger_${obj.class}`;
                      if (!dangerCooldowns[dkey] || now - dangerCooldowns[dkey] > 20000) {
                        dangerCooldowns[dkey] = now;
                        console.log('[COCO-SSD] \ud83d\udea8 DANGEROUS OBJECT:', obj.class, Math.round(obj.score * 100) + '%');
                        if (onIncidentDetected) {
                          onIncidentDetected({
                            incidentDetected: true,
                            type: 'Dangerous Object',
                            severity: 'CRITICAL',
                            confidence: Math.round(obj.score * 100),
                            description: `${dangerLabel} detected in frame at camera ${cameraId} \u2014 immediate threat assessment required`
                          });
                        }
                      }
                      return; // don\u2019t also process as valuable
                    }

                    // \u2500\u2500 VALUABLE / ABANDONED object PATH \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
                    if (!isValuable || obj.score < 0.25) return;
                    const displayName = CLASS_LABEL[obj.class] || obj.class.toUpperCase();
                    const [bx, by, bw, bh] = obj.bbox;
                    const key = `${obj.class}_${gridCell(bx, by, bw, bh)}`;
                    seenKeys.add(key);

                    const cx = bx + bw / 2, cy = by + bh / 2;
                    const personNearby = personCentroids.some(p => Math.hypot(p.x - cx, p.y - cy) < 100);

                    if (tracker.has(key)) {
                      const t = tracker.get(key);
                      t.lastSeen = now;
                      t.bbox = obj.bbox;
                      if (personNearby) {
                        t.state = 'HELD'; t.firstSeen = now; t.triggered = false;
                      } else if (t.state !== 'ABANDONED') {
                        const age = now - t.firstSeen;
                        if (age > 30000) {
                          t.state = 'ABANDONED';
                          if (!t.triggered && onIncidentDetected) {
                            t.triggered = true;
                            onIncidentDetected({ incidentDetected: true, type: 'Abandoned Object', severity: 'SUSPICIOUS', confidence: Math.round(obj.score * 100), description: `Unattended ${displayName} detected for ${Math.round(age / 1000)}s at camera ${cameraId}` });
                          }
                        } else { t.state = 'PENDING'; }
                      }
                    } else {
                      tracker.set(key, { class: obj.class, bbox: obj.bbox, firstSeen: now, lastSeen: now, state: personNearby ? 'HELD' : 'PENDING', triggered: false });
                    }

                    const t = tracker.get(key);
                    if (t.state !== 'HELD') drawObjectBox(ctx, t.bbox, displayName, t.state, now - t.firstSeen);
                  });

                  // Remove stale tracked objects
                  for (const [k] of tracker) { if (k !== '_dangerCooldowns' && !seenKeys.has(k)) tracker.delete(k); }
                }
              } catch (e) { /* inference error */ }
            } else {
              ctx.fillStyle = 'rgba(30,30,50,0.8)'; ctx.fillRect(0, 0, canvas.width, 28);
              ctx.fillStyle = '#ff9f0a'; ctx.font = '11px monospace';
              ctx.fillText('⚙ Loading MoveNet AI model (first load ~5s)…', 8, 18);
            }

            rafRef.current = requestAnimationFrame(drawLoop);
          };
          drawLoop();
        };
      })
      .catch(e => console.error('[Webcam] error:', e));

    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, cameraId, status, onIncidentDetected, onSituationClear]);

  if (!active) return null;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <video ref={videoRef} autoPlay muted playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px', background: '#000' }} />
      <canvas ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', borderRadius: '4px' }} />
    </div>
  );
}



// ─── Camera Feed Tile ─────────────────────────────────────────────────────
function CameraTile({ camera, status, incident, onClick, onExpand, isExpanded, onIncidentDetected, onSituationClear }) {
  const cls = status === 'CRITICAL' ? 'critical' : status === 'SUSPICIOUS' ? 'suspicious' : '';
  const isWebcam = camera.cameraType === 'Webcam' || camera.streamUrl === 'webcam';
  return (
    <div className={`camera-tile ${cls} ${isExpanded ? 'expanded' : ''}`} onClick={onClick}>
      <div className="camera-feed" style={isExpanded ? { height: '600px' } : undefined}>
        {isExpanded && (
          <button className="collapse-btn" onClick={(e) => { e.stopPropagation(); onExpand(null); }}>
            ✕ CLOSE FULLSCREEN
          </button>
        )}
        {!isExpanded && (
          <button className="expand-btn" onClick={(e) => { e.stopPropagation(); onExpand(camera.id); }}>
            ⛶
          </button>
        )}
        {isWebcam ? (
          <WebcamFeed active={true} cameraId={camera.id} status={status}
            onIncidentDetected={(data) => onIncidentDetected && onIncidentDetected(data, camera.id)}
            onSituationClear={onSituationClear} />
        ) : (
          <>
            <div className="camera-noise" />
            <div className="camera-feed-placeholder">
              <span className="cam-placeholder-icon">📷</span>
              <span className="cam-placeholder-id">{camera.id}</span>
            </div>
          </>
        )}
        <div className="camera-rec"><div className="rec-dot" />REC</div>
        <div className={`camera-status-badge ${status}`}>{status}</div>
        {isWebcam && <div className="camera-status-badge" style={{ top: 'auto', bottom: '6px', left: '6px', right: 'auto', background: 'rgba(10,132,255,0.85)', fontSize: '8px' }}>WEBCAM</div>}
        {cls && <div className="pulse-ring" />}
      </div>
      <div className="camera-meta">
        <div className="camera-name">{camera.name}</div>
        <div className="camera-coords">{camera.lat.toFixed(4)}°N {camera.lon.toFixed(4)}°E • {camera.zone}</div>
      </div>
    </div>
  );
}

// ─── Google Maps City Map ─────────────────────────────────────────────────
function CityMap({ cameras, services, highlightCam }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (window.google && window.google.maps) {
      initMap();
      return;
    }
    if (document.getElementById('gmaps-script')) return;
    const script = document.createElement('script');
    script.id = 'gmaps-script';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&callback=__nirakshan_map_init`;
    script.async = true;
    window.__nirakshan_map_init = initMap;
    document.head.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function initMap() {
    if (!mapRef.current || mapInstanceRef.current) return;
    const center = { lat: 18.5204, lng: 73.8567 };
    const map = new window.google.maps.Map(mapRef.current, {
      center,
      zoom: 12,
      mapTypeId: 'roadmap',
      styles: [
        { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
        { elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
        { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
        { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c54' }] },
        { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
        { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3a6e' }] },
        { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a1a' }] },
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      ],
    });
    mapInstanceRef.current = map;

    // Camera markers
    cameras.forEach(cam => {
      const isHighlit = highlightCam?.includes(cam.id);
      const marker = new window.google.maps.Marker({
        position: { lat: cam.lat, lng: cam.lon },
        map,
        title: `${cam.id} — ${cam.name}`,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: isHighlit ? 10 : 7,
          fillColor: isHighlit ? '#bf5af2' : '#ff2d55',
          fillOpacity: 0.9,
          strokeColor: '#fff',
          strokeWeight: 1.5,
        },
        label: { text: cam.id, color: '#fff', fontSize: '9px', fontWeight: 'bold' },
      });
      markersRef.current.push(marker);
    });

    // Emergency service markers
    const svcColors = { Police: '#0a84ff', Fire: '#ff9f0a', Hospital: '#30d158' };
    services.forEach(svc => {
      new window.google.maps.Marker({
        position: { lat: svc.lat, lng: svc.lon },
        map,
        title: `${svc.unit}`,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: svcColors[svc.type],
          fillOpacity: 0.8,
          strokeColor: '#fff',
          strokeWeight: 1,
        },
      });
    });
  }

  // Update marker colors when highlight changes
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    markersRef.current.forEach((marker, i) => {
      const cam = cameras[i];
      if (!cam) return;
      const isHighlit = highlightCam?.includes(cam.id);
      marker.setIcon({
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: isHighlit ? 12 : 7,
        fillColor: isHighlit ? '#bf5af2' : '#ff2d55',
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 1.5,
      });
    });
  }, [highlightCam, cameras]);

  return (
    <div className="map-container">
      <div className="map-title">🗺 City Surveillance Map — Pune Metro Region (Google Maps)</div>
      <div ref={mapRef} style={{ width: '100%', height: '280px', borderRadius: '8px' }} />
      <div className="map-legend">
        <div className="legend-item"><div className="legend-dot" style={{ background: '#ff2d55' }} />Camera</div>
        <div className="legend-item"><div className="legend-dot" style={{ background: '#0a84ff' }} />Police 🚔</div>
        <div className="legend-item"><div className="legend-dot" style={{ background: '#ff9f0a' }} />Fire 🚒</div>
        <div className="legend-item"><div className="legend-dot" style={{ background: '#30d158' }} />Hospital 🚑</div>
        <div className="legend-item"><div className="legend-dot" style={{ background: '#bf5af2' }} />Active Alert</div>
      </div>
    </div>
  );
}

// ─── Pipeline Steps ───────────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { key: 'PATTERN_ANALYSIS', label: 'YML Pattern Analysis', icon: '🔍' },
  { key: 'CLOUD_UPLOAD', label: 'Cloud Evidence Upload', icon: '☁️' },
  { key: 'EMERGENCY_NOTIFY', label: 'Emergency Dispatch', icon: '🚨' },
  { key: 'AI_REPORT', label: 'AI Report Generation', icon: '🤖' },
  { key: 'HALLUCINATION_GUARD', label: 'Hallucination Guard', icon: '🛡️' },
];

// ─── Incident Modal ───────────────────────────────────────────────────────
function IncidentModal({ incident, onClose, onResolve, addLog }) {
  const cam = CAMERAS.find(c => c.id === incident.cameraId) || CAMERAS[0];
  const nearestCams = findNearest(cam.lat, cam.lon, CAMERAS.filter(c => c.id !== cam.id), 3)
    .map(c => ({ ...c, distanceM: Math.round(haversineKm(cam.lat, cam.lon, c.lat, c.lon) * 1000) }));
  const nearestSvcs = {
    Police: findNearest(cam.lat, cam.lon, EMERGENCY_SERVICES.filter(s => s.type === 'Police'), 1)[0],
    Fire: findNearest(cam.lat, cam.lon, EMERGENCY_SERVICES.filter(s => s.type === 'Fire'), 1)[0],
    Hospital: findNearest(cam.lat, cam.lon, EMERGENCY_SERVICES.filter(s => s.type === 'Hospital'), 1)[0],
  };
  const scenario = SCENARIOS.find(s => s.id === incident.scenarioId);
  const requiredSvcTypes = scenario?.requiredServices || ['Police'];
  const notifyServices = requiredSvcTypes.map(t => nearestSvcs[t]).filter(Boolean)
    .map(s => ({ ...s, distance: haversineKm(cam.lat, cam.lon, s.lat, s.lon) }));

  const [pipelineState, setPipelineState] = useState({});
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [aiReport, setAiReport] = useState('');
  const [guardResult, setGuardResult] = useState(null);
  const [evidenceData, setEvidenceData] = useState(null);
  const [dispatchData, setDispatchData] = useState(null);

  const confScore = incident.confidence;
  const confClass = confScore >= 85 ? 'high' : confScore >= 70 ? 'medium' : 'low';

  const runPipeline = useCallback(async () => {
    if (pipelineRunning) return;
    setPipelineRunning(true);
    setPipelineState({ PATTERN_ANALYSIS: 'running' });
    addLog('🔍 Starting autonomous agent pipeline…', 'agent');
    const resp = await fetch(`${API_BASE}/api/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incident: { type: incident.type, cameraId: incident.cameraId, location: `${cam.lat}, ${cam.lon}`, confidence: incident.confidence, severity: incident.severity },
        cameras: nearestCams.map(c => ({ id: c.id, distance: c.distanceM })),
        services: notifyServices.map(s => ({ type: s.type, unit: s.unit, phone: s.phone, distance: +s.distance.toFixed(2) }))
      })
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          const { step, status, ...rest } = obj;
          setPipelineState(prev => ({ ...prev, [step]: status, [`${step}_data`]: rest }));
          if (step === 'CLOUD_UPLOAD' && status === 'done') { setEvidenceData(rest); addLog(`☁️ Evidence uploaded: ${rest.chunkId}`, 'agent'); }
          if (step === 'EMERGENCY_NOTIFY' && status === 'done') { setDispatchData(rest); addLog(`🚨 ${rest.units} unit(s) dispatched`, incident.severity === 'CRITICAL' ? 'critical' : 'suspicious'); }
          if (step === 'AI_REPORT' && status === 'done') { setAiReport(rest.reportText || ''); addLog('🤖 AI incident report generated', 'agent'); }
          if (step === 'HALLUCINATION_GUARD' && status === 'done') {
            const validation = validateReport(rest.reportText || aiReport, { type: incident.type, confidence: incident.confidence });
            const merged = { warnings: [...(rest.warnings || []), ...validation.warnings], passed: rest.passed && validation.passed };
            setGuardResult(merged);
            addLog(`🛡️ Guard — ${merged.warnings.length} warning(s)`, merged.passed ? 'clear' : 'suspicious');
          }
          if (step === 'COMPLETE' && status === 'done') addLog('✅ Pipeline complete', 'clear');
        } catch { /* skip */ }
      }
    }
    setPipelineRunning(false);
  }, [pipelineRunning, incident, cam, nearestCams, notifyServices, addLog]);

  const getStepStatus = key => pipelineState[key] || 'pending';
  const getStepSub = key => {
    const d = pipelineState[`${key}_data`];
    if (!d) return '';
    if (key === 'CLOUD_UPLOAD' && d.chunkId) return d.chunkId;
    if (key === 'AI_REPORT') return d.reportText ? `${d.reportText.slice(0, 60)}…` : '';
    if (key === 'HALLUCINATION_GUARD') return d.passed ? 'All checks passed' : `${(d.warnings || []).length} warning(s) flagged`;
    if (key === 'EMERGENCY_NOTIFY') return d.units ? `${d.units} units dispatched` : '';
    if (key === 'PATTERN_ANALYSIS') return d.result || '';
    return '';
  };

  return (
    <div className="modal-overlay" onClick={e => e.target.classList.contains('modal-overlay') && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title-row">
            <span className="modal-emoji">{incident.emoji}</span>
            <div>
              <div className="modal-title">{incident.type}</div>
              <div className="modal-sub">{incident.cameraId} • {cam.name} • {formatDateTimeISO(incident.timestamp)}</div>
            </div>
            <span className={`tag ${incident.severity === 'CRITICAL' ? 'critical' : 'suspicious'}`}>{incident.severity}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Live Feed */}
          <div className="modal-section">
            <div className="modal-section-title">Live Feed — {incident.cameraId}</div>
            <div className="modal-cam-feed">
              {(cam.cameraType === 'Webcam' || cam.streamUrl === 'webcam') ? (
                <WebcamFeed active={true} />
              ) : (
                <div className="modal-cam-feed-inner">
                  <span className="cam-icon">📷</span>
                  <span className="cam-id">{cam.name} • SECTOR {cam.sector}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>LIVE FEED SIMULATION</span>
                </div>
              )}
            </div>
          </div>
          <div className="modal-2col">
            <div className="modal-section">
              <div className="modal-section-title">Incident Details</div>
              <div className="info-row"><span className="info-label">TYPE</span><span className="info-val">{incident.type}</span></div>
              <div className="info-row"><span className="info-label">CAMERA</span><span className="info-val" style={{ color: 'var(--agent)' }}>{incident.cameraId}</span></div>
              <div className="info-row"><span className="info-label">COORDINATES</span><span className="info-val">{cam.lat.toFixed(4)}, {cam.lon.toFixed(4)}</span></div>
              <div className="info-row"><span className="info-label">ZONE</span><span className="info-val">{cam.zone}</span></div>
              <div className="info-row"><span className="info-label">SEVERITY</span><span className={`info-val ${incident.severity.toLowerCase()}`}>{incident.severity}</span></div>
            </div>
            <div className="modal-section">
              <div className="modal-section-title">AI Confidence Score</div>
              <div className="confidence-meter">
                <div className="confidence-label">
                  <span>{confScore < 85 ? '⚠ UNVERIFIED' : '✓ VERIFIED'}</span>
                  <span style={{ color: confClass === 'high' ? 'var(--clear)' : confClass === 'medium' ? 'var(--suspicious)' : 'var(--critical)' }}>{confScore}%</span>
                </div>
                <div className="confidence-bar-wrap">
                  <div className={`confidence-bar ${confClass}`} style={{ width: `${confScore}%` }} />
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>
                  {confScore >= 85 ? 'High confidence — verified' : confScore >= 70 ? 'Medium — cross-verify recommended' : 'Low — manual review required'}
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="info-row"><span className="info-label">DESCRIPTION</span></div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-secondary)', lineHeight: '1.6', marginTop: '4px' }}>{incident.description}</div>
              </div>
            </div>
          </div>

          {/* Nearest Cameras */}
          <div className="modal-section">
            <div className="modal-section-title">Nearest CCTV Cameras (Haversine)</div>
            <div className="modal-3col">
              {nearestCams.map(c => (
                <div key={c.id} className="cam-card">
                  <div className="cam-id">{c.id}</div>
                  <div className="cam-name">{c.name}</div>
                  <div className="cam-dist">📍 {c.distanceM}m away • {c.zone}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Emergency Services */}
          <div className="modal-section">
            <div className="modal-section-title">Emergency Services — Auto-Dispatched</div>
            <div className={`modal-${notifyServices.length === 1 ? '2col' : '3col'}`} style={{ gridTemplateColumns: `repeat(${notifyServices.length},1fr)` }}>
              {notifyServices.map(svc => (
                <div key={svc.id} className="service-card">
                  <div className="svc-type">{svc.emoji} {svc.type}</div>
                  <div className="svc-name">{svc.unit}</div>
                  <div className="svc-meta">
                    <span>📞 {svc.phone}</span>
                    <span>📍 {svc.distance.toFixed(2)} km</span>
                    <span>⏱ ETA ~{Math.ceil(svc.distance * 3 + 2)} min</span>
                  </div>
                  {dispatchData
                    ? <div className="svc-badge">✓ DISPATCHED</div>
                    : <div className="svc-badge" style={{ background: 'var(--info-bg)', color: 'var(--info)', borderColor: 'rgba(10,132,255,0.3)' }}>STANDBY</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Evidence */}
          {evidenceData && (
            <div className="modal-section">
              <div className="modal-section-title">Cloud Evidence</div>
              <div className="evidence-box">
                <div>✅ {evidenceData.fileSizeMB}MB · Chunk: {evidenceData.chunkId}</div>
                <div className="evidence-url">{evidenceData.evidenceUrl}</div>
              </div>
            </div>
          )}

          {/* Pipeline */}
          <div className="modal-section">
            <div className="modal-section-title">Autonomous Agent Pipeline</div>
            <button className="pipeline-cta" onClick={runPipeline} disabled={pipelineRunning}>
              {pipelineRunning ? '⚙ PIPELINE RUNNING…' : '⚡ RUN AGENT PIPELINE'}
            </button>
            <div className="pipeline-tracker" style={{ marginTop: '12px' }}>
              {PIPELINE_STEPS.map(step => {
                const st = getStepStatus(step.key);
                const sub = getStepSub(step.key);
                return (
                  <div key={step.key} className={`pipeline-step ${st}`}>
                    <div className={`step-indicator ${st}`}>{st === 'pending' ? '' : st === 'running' ? '◌' : st === 'done' ? '✓' : '✗'}</div>
                    <div className="step-info">
                      <div className="step-name">{step.icon} {step.label}</div>
                      {sub && <div className="step-sub">{sub}</div>}
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1px', color: st === 'running' ? 'var(--agent)' : st === 'done' ? 'var(--clear)' : st === 'failed' ? 'var(--critical)' : 'var(--text-tertiary)' }}>
                      {st.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hallucination Guard */}
          {guardResult && (
            <div className="modal-section">
              <div className="modal-section-title">🛡 Hallucination Guard Results</div>
              <div className={`guard-panel ${guardResult.passed ? 'pass' : guardResult.warnings.some(w => w.severity === 'error' || w.code?.includes('TYPE') || w.code?.includes('MISSING')) ? 'fail' : 'warn'}`}>
                <div className="guard-status-row">
                  {guardResult.passed
                    ? <><span style={{ color: 'var(--clear)' }}>✓</span><span style={{ color: 'var(--clear)' }}>ALL CHECKS PASSED</span></>
                    : <><span style={{ color: 'var(--suspicious)' }}>⚠</span><span style={{ color: 'var(--suspicious)' }}>{guardResult.warnings.length} ISSUE(S) FLAGGED</span></>}
                </div>
                {guardResult.warnings.length > 0 && (
                  <div className="guard-warnings">
                    {guardResult.warnings.map((w, i) => (
                      <div key={i} className={`guard-warning ${w.code?.includes('MATCH') || w.code?.includes('MISSING') ? 'error' : ''}`}>
                        <span>{w.code?.includes('MATCH') || w.code?.includes('MISSING') ? '✗' : '⚠'}</span>
                        <span>[{w.code}] {w.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AI Report */}
          <div className="modal-section">
            <div className="modal-section-title">🤖 AI Incident Report (Claude)</div>
            {aiReport
              ? <div className="ai-report">{aiReport}</div>
              : <div className="ai-report-placeholder">Run the Agent Pipeline to generate the AI incident report.</div>}
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button className="btn btn-resolve" onClick={() => { onResolve(incident.id); onClose(); }}>✓ MARK RESOLVED</button>
            <button className="btn btn-ghost" onClick={onClose}>CLOSE</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Map Location Picker (inside Add Camera modal) ───────────────────────
function MapLocationPicker({ onLocationPick, initialLat, initialLon }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    const init = () => {
      if (!mapRef.current || mapInstanceRef.current) return;
      const startLat = initialLat || 18.5204;
      const startLon = initialLon || 73.8567;

      const map = new window.google.maps.Map(mapRef.current, {
        center: { lat: startLat, lng: startLon },
        zoom: 13,
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c54' }] },
          { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3a6e' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a1a' }] },
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        ],
      });
      mapInstanceRef.current = map;

      // If editing, place initial marker
      if (initialLat && initialLon) {
        markerRef.current = new window.google.maps.Marker({
          position: { lat: initialLat, lng: initialLon }, map, draggable: true,
          icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#bf5af2', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
        });
        markerRef.current.addListener('dragend', e => {
          onLocationPick(e.latLng.lat(), e.latLng.lng());
        });
      }

      // Click on map to drop pin
      map.addListener('click', e => {
        const lat = e.latLng.lat(), lng = e.latLng.lng();
        if (markerRef.current) markerRef.current.setMap(null);
        markerRef.current = new window.google.maps.Marker({
          position: { lat, lng }, map, draggable: true, animation: window.google.maps.Animation.DROP,
          icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#bf5af2', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
        });
        markerRef.current.addListener('dragend', ev => {
          onLocationPick(ev.latLng.lat(), ev.latLng.lng());
        });
        onLocationPick(lat, lng);
      });

      // Places Autocomplete search
      if (searchRef.current && window.google.maps.places) {
        const autocomplete = new window.google.maps.places.Autocomplete(searchRef.current, { types: ['geocode'] });
        autocomplete.bindTo('bounds', map);
        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (!place.geometry) return;
          map.setCenter(place.geometry.location);
          map.setZoom(16);
          const lat = place.geometry.location.lat(), lng = place.geometry.location.lng();
          if (markerRef.current) markerRef.current.setMap(null);
          markerRef.current = new window.google.maps.Marker({
            position: { lat, lng }, map, draggable: true, animation: window.google.maps.Animation.DROP,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#bf5af2', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
          });
          markerRef.current.addListener('dragend', ev => {
            onLocationPick(ev.latLng.lat(), ev.latLng.lng());
          });
          onLocationPick(lat, lng);
        });
      }
    };

    if (window.google && window.google.maps) { init(); }
    else {
      const existing = document.getElementById('gmaps-picker-script');
      if (existing) { window.__nirakshan_picker_init = init; return; }
      const script = document.createElement('script');
      script.id = 'gmaps-picker-script';
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=__nirakshan_picker_init`;
      script.async = true;
      window.__nirakshan_picker_init = init;
      document.head.appendChild(script);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (mapInstanceRef.current) {
          const map = mapInstanceRef.current;
          map.setCenter({ lat, lng });
          map.setZoom(16);
          if (markerRef.current) markerRef.current.setMap(null);
          markerRef.current = new window.google.maps.Marker({
            position: { lat, lng }, map, draggable: true, animation: window.google.maps.Animation.DROP,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#bf5af2', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
          });
          markerRef.current.addListener('dragend', ev => {
            onLocationPick(ev.latLng.lat(), ev.latLng.lng());
          });
          onLocationPick(lat, lng);
        }
      },
      () => alert("Unable to retrieve your location. Please check browser permissions.")
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input ref={searchRef} className="form-input" placeholder="🔍 Search address or location…" style={{ fontSize: '12px', flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={handleCurrentLocation} style={{ fontSize: '12px', padding: '0 12px', whiteSpace: 'nowrap' }} title="Use Current GPS Location">
          📍 Current
        </button>
      </div>
      <div ref={mapRef} style={{ width: '100%', height: '220px', borderRadius: '8px', border: '1px solid var(--border)' }} />
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>
        Search or click on the map to set camera location. You can also drag the pin to fine-tune.
      </div>
    </div>
  );
}

// ─── Camera Management (CAMERAS Tab) ─────────────────────────────────────
const EMPTY_FORM = { id: '', name: '', lat: '', lon: '', zone: '', sector: '', streamUrl: '', cameraType: 'Demo', status: 'online' };

function CameraManagement({ cameras, onAdd, onEdit, onDelete, addLog }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErr, setFormErr] = useState('');

  const openAdd = () => { setForm(EMPTY_FORM); setEditId(null); setFormErr(''); setShowForm(true); };
  const openEdit = cam => { setForm({ ...cam, lat: String(cam.lat), lon: String(cam.lon) }); setEditId(cam.id); setFormErr(''); setShowForm(true); };

  const handleSave = () => {
    if (!form.id.trim() || !form.name.trim() || !form.lat || !form.lon) { setFormErr('Camera ID, Name, and a map location are required.'); return; }
    const latN = parseFloat(form.lat), lonN = parseFloat(form.lon);
    if (isNaN(latN) || isNaN(lonN)) { setFormErr('Please pick a location on the map.'); return; }
    if (!editId && cameras.find(c => c.id === form.id.trim())) { setFormErr('Camera ID already exists.'); return; }
    const cam = { ...form, id: form.id.trim().toUpperCase(), lat: latN, lon: lonN };
    if (editId) { onEdit(cam); addLog(`✏️ Camera ${cam.id} updated`, 'agent'); }
    else { onAdd(cam); addLog(`📷 Camera ${cam.id} added — ${cam.name}`, 'agent'); }
    setShowForm(false);
  };

  const handleDelete = cam => {
    if (window.confirm(`Delete ${cam.id} — ${cam.name}?`)) { onDelete(cam.id); addLog(`🗑️ Camera ${cam.id} removed`, 'agent'); }
  };

  const handleLocationPick = (lat, lng) => {
    setForm(p => ({ ...p, lat: lat.toFixed(6), lon: lng.toFixed(6) }));
  };

  const typeColor = t => t === 'Webcam' ? '#0a84ff' : t === 'IP' ? '#30d158' : '#636366';
  const statusColor = s => s === 'online' ? 'var(--clear)' : 'var(--critical)';

  return (
    <div>
      <div className="monitor-top">
        <div>
          <div className="monitor-heading">📷 Camera Management</div>
          <div className="monitor-sub" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>
            {cameras.length} cameras registered • {cameras.filter(c => c.status === 'online').length} online
          </div>
        </div>
        <button className="btn btn-resolve" onClick={openAdd} style={{ alignSelf: 'center' }}>+ Add Camera</button>
      </div>

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={e => e.target.classList.contains('modal-overlay') && setShowForm(false)}>
          <div className="modal" style={{ maxWidth: '640px' }}>
            <div className="modal-header">
              <div className="modal-title">{editId ? `✏️ Edit ${editId}` : '📷 Add New Camera'}</div>
              <button className="modal-close" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <div className="modal-body">

              {/* Map location picker */}
              <div className="modal-section">
                <div className="modal-section-title">📍 Pick Camera Location on Map</div>
                <MapLocationPicker
                  onLocationPick={handleLocationPick}
                  initialLat={parseFloat(form.lat) || null}
                  initialLon={parseFloat(form.lon) || null}
                />
                {form.lat && form.lon && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--agent)', marginTop: '6px' }}>
                    📌 Selected: {parseFloat(form.lat).toFixed(5)}°N, {parseFloat(form.lon).toFixed(5)}°E
                  </div>
                )}
              </div>

              {/* Camera Details */}
              <div className="modal-section" style={{ marginTop: '4px' }}>
                <div className="modal-section-title">Camera Details</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-field">
                    <label className="form-label">Camera ID *</label>
                    <input className="form-input" placeholder="CAM-007" value={form.id}
                      onChange={e => setForm(p => ({ ...p, id: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Location Name *</label>
                    <input className="form-input" placeholder="Baner Road Junction" value={form.name}
                      onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Zone</label>
                    <input className="form-input" placeholder="North" value={form.zone}
                      onChange={e => setForm(p => ({ ...p, zone: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Sector</label>
                    <input className="form-input" placeholder="G7" value={form.sector}
                      onChange={e => setForm(p => ({ ...p, sector: e.target.value }))} />
                  </div>
                </div>
                <div className="form-field" style={{ marginTop: '12px' }}>
                  <label className="form-label">Stream URL — RTSP / HTTP (leave blank for demo, type "webcam" for laptop cam)</label>
                  <input className="form-input" placeholder="rtsp://192.168.1.50:554/stream  OR  webcam" value={form.streamUrl}
                    onChange={e => setForm(p => ({ ...p, streamUrl: e.target.value }))} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                  <div className="form-field">
                    <label className="form-label">Camera Type</label>
                    <select className="form-input" value={form.cameraType} onChange={e => setForm(p => ({ ...p, cameraType: e.target.value }))}>
                      <option value="Demo">Demo (Simulated)</option>
                      <option value="Webcam">Webcam (Laptop)</option>
                      <option value="IP">IP Camera (RTSP)</option>
                      <option value="USB">USB Camera</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label className="form-label">Status</label>
                    <select className="form-input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                      <option value="online">Online</option>
                      <option value="offline">Offline</option>
                    </select>
                  </div>
                </div>
              </div>

              {formErr && <div style={{ color: 'var(--critical)', fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '4px' }}>⚠ {formErr}</div>}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button className="btn btn-resolve" onClick={handleSave}>💾 Save Camera</button>
                <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {cameras.length === 0 && (
        <div className="empty-state" style={{ marginTop: '40px' }}>
          <div className="empty-icon">📷</div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>No cameras added yet</div>
          <div style={{ fontSize: '11px', opacity: 0.6 }}>Click "+ Add Camera" to register your first camera using the map</div>
          <button className="btn btn-resolve" onClick={openAdd} style={{ marginTop: '12px' }}>+ Add Your First Camera</button>
        </div>
      )}

      {/* Camera List */}
      <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {cameras.map(cam => (
          <div key={cam.id} className="incident-card" style={{ cursor: 'default', display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{ minWidth: '60px', textAlign: 'center', background: typeColor(cam.cameraType) + '22', border: `1px solid ${typeColor(cam.cameraType)}55`, borderRadius: '6px', padding: '4px 8px', fontSize: '10px', color: typeColor(cam.cameraType), fontFamily: 'var(--font-mono)' }}>
              {cam.cameraType}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--agent)', fontWeight: 700 }}>{cam.id}</span>
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{cam.name}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '3px' }}>
                📍 {cam.lat.toFixed(5)}°N, {cam.lon.toFixed(5)}°E • Zone: {cam.zone || '—'} • Sector: {cam.sector || '—'}
              </div>
              {cam.streamUrl && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--suspicious)', marginTop: '2px' }}>
                  🔗 {cam.streamUrl}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: statusColor(cam.status) }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: statusColor(cam.status) }}>{cam.status.toUpperCase()}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: '11px' }} onClick={() => openEdit(cam)}>✏️ Edit</button>
              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: '11px', color: 'var(--critical)', borderColor: 'rgba(255,45,85,0.3)' }} onClick={() => handleDelete(cam)}>🗑️</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('MONITOR');
  const [cameras, setCameras] = useState(CAMERAS);
  const [incidents, setIncidents] = useState([]);
  const [logs, setLogs] = useState([
    { id: 1, time: formatTime(new Date()), msg: '🚀 Nirakshan AI system initialized', type: 'agent' },
    { id: 2, time: formatTime(new Date()), msg: `📡 ${CAMERAS.length} cameras online and streaming`, type: 'info' },
    { id: 3, time: formatTime(new Date()), msg: '🛡 Hallucination guard active', type: 'agent' },
    { id: 4, time: formatTime(new Date()), msg: '🗺 Google Maps city view loaded', type: 'info' },
  ]);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [cameraStatuses, setCameraStatuses] = useState(
    Object.fromEntries(CAMERAS.map(c => [c.id, 'CLEAR']))
  );
  const [highlightCams, setHighlightCams] = useState([]);
  const [expandedCameraId, setExpandedCameraId] = useState(null);
  const logRef = useRef(null);
  const incidentCounter = useRef(100);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(prev => [{ id: Date.now(), time: formatTime(new Date()), msg, type }, ...prev.slice(0, 99)]);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = 0; }, [logs]);

  // Camera CRUD handlers
  const handleAddCamera = useCallback(cam => {
    setCameras(prev => [...prev, cam]);
    setCameraStatuses(prev => ({ ...prev, [cam.id]: 'CLEAR' }));
  }, []);

  const handleEditCamera = useCallback(cam => {
    setCameras(prev => prev.map(c => c.id === cam.id ? cam : c));
  }, []);

  const handleDeleteCamera = useCallback(id => {
    setCameras(prev => prev.filter(c => c.id !== id));
    setCameraStatuses(prev => { const s = { ...prev }; delete s[id]; return s; });
    setHighlightCams(prev => prev.filter(c => c !== id));
  }, []);

  const aiIncidentActiveRef = useRef({});

  const handleAIIncident = useCallback((aiData, cameraId) => {
    // Prevent spamming — cooldown per camera (30s)
    const now = Date.now();
    if (aiIncidentActiveRef.current[cameraId] && now - aiIncidentActiveRef.current[cameraId] < 30000) {
      console.log('[Vision] cooldown active for', cameraId, '— skipping');
      return;
    }
    aiIncidentActiveRef.current[cameraId] = now;

    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) { console.warn('[Vision] camera not found:', cameraId); return; }

    const id = `INC-${++incidentCounter.current}`;
    const type = aiData.type || 'AI Detected Anomaly';
    const severity = aiData.severity || 'CRITICAL';
    const confidence = aiData.confidence || 90;
    const description = aiData.description || 'Live AI Vision analysis flagged an event.';

    const newIncident = {
      id, scenarioId: 'SC-AI-VISION', type, emoji: '👁️',
      severity, confidence, description,
      cameraId: cam.id, status: severity, timestamp: new Date(),
    };

    // All state updates flat — no nesting
    setIncidents(prev => [newIncident, ...prev]);
    setCameraStatuses(prev => ({ ...prev, [cam.id]: severity }));
    setHighlightCams(prev => [...new Set([...prev, cam.id])]);

    addLog(`🚨 AI VISION: [${severity}] ${type} at ${cam.id} — ${cam.name}`, severity === 'CRITICAL' ? 'critical' : 'suspicious');
    addLog(`👁️ ${description.slice(0, 80)}`, 'agent');
    console.log('[Vision] Incident created:', id, 'for camera', cam.id);
  }, [cameras, addLog]);
  const handleSituationClear = useCallback((cameraId) => {
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) return;

    setCameraStatuses(prev => {
      if (prev[cameraId] === 'CLEAR') return prev; // Already clear
      return { ...prev, [cameraId]: 'CLEAR' };
    });

    setIncidents(prev => {
      const activeInc = prev.find(i => i.cameraId === cameraId && i.status !== 'RESOLVED');
      if (activeInc) {
        addLog(`✅ Scene calm at ${cam.id}. Auto-resolving incident ${activeInc.id}`, 'clear');
        return prev.map(i => i.id === activeInc.id ? { ...i, status: 'RESOLVED' } : i);
      }
      return prev;
    });

    setHighlightCams(prev => prev.filter(c => c !== cameraId));
  }, [cameras, addLog]);

  const [targetTriggerCamId, setTargetTriggerCamId] = useState('random');

  const triggerScenario = useCallback((scenario) => {
    let cam;
    if (targetTriggerCamId === 'random') {
      cam = cameras[Math.floor(Math.random() * cameras.length)];
    } else {
      cam = cameras.find(c => c.id === targetTriggerCamId) || cameras[0];
    }

    const id = `INC-${++incidentCounter.current}`;
    const newIncident = {
      id, scenarioId: scenario.id, type: scenario.type, emoji: scenario.emoji,
      severity: scenario.severity, confidence: scenario.confidence,
      description: scenario.description, cameraId: cam.id,
      status: scenario.severity, timestamp: new Date(),
    };
    setIncidents(prev => [newIncident, ...prev]);
    setCameraStatuses(prev => ({ ...prev, [cam.id]: scenario.severity }));
    setHighlightCams(prev => [...new Set([...prev, cam.id])]);
    addLog(`${scenario.emoji} [${scenario.severity}] ${scenario.type} detected at ${cam.id} — ${cam.name}`, scenario.severity === 'CRITICAL' ? 'critical' : 'suspicious');
    addLog(`📍 Location: ${cam.lat.toFixed(4)}°N, ${cam.lon.toFixed(4)}°E`, 'agent');
    addLog('🔍 Initiating YML behavioral pattern analysis pipeline…', 'agent');
    const steps = [
      '  ↳ Step 1/5: Frame extraction — 45 fps buffer captured',
      '  ↳ Step 2/5: Object detection — persons tracked: 2-4',
      '  ↳ Step 3/5: Pose estimation — anomalous posture detected [INFERRED]',
      '  ↳ Step 4/5: Trajectory analysis — erratic movement pattern',
      `  ↳ Step 5/5: Confidence scored at ${scenario.confidence}% — threshold met`,
    ];
    steps.forEach((s, i) => setTimeout(() => addLog(s, 'agent'), 400 * (i + 1)));
    setTimeout(() => addLog(`✅ Pattern analysis complete for ${id}`, 'clear'), 400 * 6);
    if (tab !== 'MONITOR') setTab('MONITOR');
  }, [cameras, tab, addLog, targetTriggerCamId]);

  const resolveIncident = useCallback(id => {
    setIncidents(prev => prev.map(i => i.id === id ? { ...i, status: 'RESOLVED' } : i));
    const inc = incidents.find(i => i.id === id);
    if (inc) {
      setCameraStatuses(prev => ({ ...prev, [inc.cameraId]: 'CLEAR' }));
      setHighlightCams(prev => prev.filter(c => c !== inc.cameraId));
      addLog(`✅ Incident ${id} resolved and cleared`, 'clear');
    }
  }, [incidents, addLog]);

  const stats = {
    total: incidents.length,
    critical: incidents.filter(i => i.severity === 'CRITICAL' && i.status !== 'RESOLVED').length,
    suspicious: incidents.filter(i => i.severity === 'SUSPICIOUS' && i.status !== 'RESOLVED').length,
    resolved: incidents.filter(i => i.status === 'RESOLVED').length,
  };

  const TABS = [
    { key: 'MONITOR', label: '📺 Monitor Room' },
    { key: 'CAMERAS', label: '📷 Cameras' },
    { key: 'INCIDENTS', label: '🚨 Incidents' },
    { key: 'AGENT_LOG', label: '🤖 Agent Log' },
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <div className="header-logo">🎯</div>
          <div>
            <div className="header-title">NIRAKSHAN<span> AI</span></div>
            <div className="header-subtitle">निरक्षण • Autonomous Surveillance Intelligence</div>
          </div>
        </div>
        <div className="header-stats">
          <div className="stat-pill"><span className="stat-val">{cameras.length}</span><span className="stat-lbl">Cameras</span></div>
          <div className="stat-pill critical"><span className="stat-val">{stats.critical}</span><span className="stat-lbl">Critical</span></div>
          <div className="stat-pill suspicious"><span className="stat-val">{stats.suspicious}</span><span className="stat-lbl">Suspicious</span></div>
          <div className="stat-pill resolved"><span className="stat-val">{stats.resolved}</span><span className="stat-lbl">Resolved</span></div>
        </div>
        <div className="header-right">
          <div className="live-badge"><div className="live-dot" />LIVE</div>
          <Clock />
        </div>
      </header>

      <div className="tab-bar">
        {TABS.map(t => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="main-content">
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-title">⚡ Trigger Scenario</div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)', display: 'block', marginBottom: '6px' }}>TARGET CAMERA</label>
              <select
                className="form-input"
                value={targetTriggerCamId}
                onChange={e => setTargetTriggerCamId(e.target.value)}
                style={{ padding: '6px 10px', fontSize: '11px', background: 'var(--bg-2)' }}
              >
                <option value="random">Random Selection</option>
                {cameras.map(c => (
                  <option key={c.id} value={c.id}>{c.id} — {c.name} {c.cameraType === 'Webcam' ? '(Webcam)' : ''}</option>
                ))}
              </select>
            </div>
            {SCENARIOS.map(sc => (
              <button key={sc.id} className="scenario-btn" onClick={() => triggerScenario(sc)}>
                <span className="sc-emoji">{sc.emoji}</span>
                <div className="sc-info">
                  <div className="sc-name">{sc.type}</div>
                  <div className={`sc-sev ${sc.colorClass}`}>{sc.severity}</div>
                </div>
                <span className="sc-trigger">FIRE</span>
              </button>
            ))}
          </div>
          <div className="sidebar-section" style={{ borderBottom: 'none' }}>
            <div className="sidebar-title">📟 Agent Activity</div>
          </div>
          <div className="agent-log-sidebar" ref={logRef}>
            {logs.map(log => (
              <div key={log.id} className={`log-entry ${log.type}`}>
                <span className="log-time">{log.time}</span>
                <span className="log-msg">{log.msg}</span>
              </div>
            ))}
          </div>
        </aside>

        <main className="tab-content">
          {/* MONITOR */}
          {tab === 'MONITOR' && (
            <div>
              <div className="monitor-top">
                <div>
                  <div className="monitor-heading">📺 CCTV Monitor Room</div>
                  <div className="monitor-sub" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>
                    {cameras.length} feeds active • Real-time behavioral analysis
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {stats.critical > 0 && <span className="tag critical">⚠ {stats.critical} CRITICAL</span>}
                  {stats.suspicious > 0 && <span className="tag suspicious">{stats.suspicious} SUSPICIOUS</span>}
                  <button className="btn btn-ghost" style={{ fontSize: '11px', padding: '5px 12px' }} onClick={() => setTab('CAMERAS')}>+ Add Camera</button>
                </div>
              </div>
              <div className="camera-grid">
                {cameras.map(cam => {
                  if (expandedCameraId && cam.id !== expandedCameraId) return null;
                  const status = cameraStatuses[cam.id] || 'CLEAR';
                  const relatedInc = incidents.find(i => i.cameraId === cam.id && i.status !== 'RESOLVED');
                  return (
                    <CameraTile key={cam.id} camera={cam} status={status} incident={relatedInc}
                      isExpanded={expandedCameraId === cam.id}
                      onExpand={setExpandedCameraId}
                      onClick={() => relatedInc ? setSelectedIncident(relatedInc) : null}
                      onIncidentDetected={handleAIIncident}
                      onSituationClear={handleSituationClear} />
                  );
                })}
              </div>
              <div style={{ marginTop: '20px' }}>
                <CityMap cameras={cameras} services={EMERGENCY_SERVICES} highlightCam={highlightCams} />
              </div>
            </div>
          )}

          {/* CAMERAS */}
          {tab === 'CAMERAS' && (
            <CameraManagement cameras={cameras} onAdd={handleAddCamera} onEdit={handleEditCamera} onDelete={handleDeleteCamera} addLog={addLog} />
          )}

          {/* INCIDENTS */}
          {tab === 'INCIDENTS' && (
            <div>
              <div className="monitor-top">
                <div>
                  <div className="monitor-heading">🚨 Incident Log</div>
                  <div className="monitor-sub" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>{incidents.length} total incidents</div>
                </div>
              </div>
              {incidents.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🔍</div>
                  <div>No incidents detected yet</div>
                  <div style={{ fontSize: '10px', opacity: .6 }}>Trigger a scenario from the sidebar to begin</div>
                </div>
              ) : (
                <div className="incidents-list">
                  {incidents.map(inc => (
                    <div key={inc.id} className={`incident-card ${inc.severity === 'CRITICAL' ? 'critical' : 'suspicious'} ${inc.status === 'RESOLVED' ? 'resolved' : ''}`}
                      onClick={() => setSelectedIncident(inc)}>
                      <span className="incident-emoji">{inc.emoji}</span>
                      <div className="incident-info">
                        <div className="incident-type">{inc.type}</div>
                        <div className="incident-meta">{inc.id} • {inc.cameraId} • {formatDateTimeISO(inc.timestamp)}</div>
                        <div className="incident-meta" style={{ marginTop: '2px' }}>{inc.description.slice(0, 80)}…</div>
                      </div>
                      <div className="incident-sev" style={{ ...(inc.status === 'RESOLVED' ? { background: 'var(--bg-3)', color: 'var(--text-tertiary)' } : {}) }}>
                        {inc.status === 'RESOLVED' ? 'RESOLVED' : inc.severity}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AGENT LOG */}
          {tab === 'AGENT_LOG' && (
            <div>
              <div className="monitor-top">
                <div>
                  <div className="monitor-heading">🤖 Agent Activity Log</div>
                  <div className="monitor-sub" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-tertiary)' }}>{logs.length} entries</div>
                </div>
              </div>
              <div className="agent-log-full">
                {logs.map(log => (
                  <div key={log.id} className="agent-log-entry-full">
                    <span className="ts">{log.time}</span>
                    <span className={`cat ${log.type}`}>{log.type.toUpperCase()}</span>
                    <span className="msg">{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {selectedIncident && (
        <IncidentModal incident={selectedIncident} onClose={() => setSelectedIncident(null)} onResolve={resolveIncident} addLog={addLog} />
      )}
    </div>
  );
}
