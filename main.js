// ╔══════════════════════════════════════════════════════════╗
// ║   POSEAI  —  main.js  —  Production Build v3.0          ║
// ╚══════════════════════════════════════════════════════════╝

// ══════════════════════════════════════════
// GLOBALS
// ══════════════════════════════════════════
let viewMode   = 'real';   // 'real' | 'avatar'
let modelReady = false;

// ══════════════════════════════════════════
// SETTINGS STATE
// ══════════════════════════════════════════
const CFG = {
  skeleton: true,
  dots:     true,
  glow:     true,
  face:     false,
  sound:    true,
  voice:    true,
};

// ══════════════════════════════════════════
// AUDIO ENGINE
// ══════════════════════════════════════════
let _ac = null;
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}

function beep(hz, type, dur, vol) {
  if (!CFG.sound) return;
  hz = hz || 440; type = type || 'sine'; dur = dur || 0.12; vol = vol || 0.2;
  try {
    const c = getAC();
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.type = type; o.frequency.value = hz;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.start(c.currentTime);
    o.stop(c.currentTime + dur);
  } catch(e) { /* silent fail */ }
}

function say(txt) {
  if (!CFG.voice || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  u.rate = 1.15; u.pitch = 1.05; u.volume = 0.9;
  // pick a voice if available
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes('Google') || v.name.includes('Natural'));
  if (preferred) u.voice = preferred;
  speechSynthesis.speak(u);
}

// ══════════════════════════════════════════
// GAME STATE — XP, LEVELS, HISTORY
// ══════════════════════════════════════════
const LEVELS = [
  {name:'Beginner',  xp:0},
  {name:'Trainee',   xp:100},
  {name:'Athlete',   xp:300},
  {name:'Fighter',   xp:600},
  {name:'Champion',  xp:1000},
  {name:'Elite',     xp:1500},
  {name:'Legend',    xp:2500},
];

const SAVE_KEY = 'poseai_save_v3';
let GAME = loadGame();

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return {
    xp: 0,
    totalPunches: 0,
    totalReps: 0,
    totalSigns: 0,
    sessions: 0,
  };
}
function saveGame() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(GAME)); } catch(e) {}
}

function addXP(amount) {
  const prevLevel = getLevel();
  GAME.xp += amount;
  saveGame();
  const newLevel = getLevel();
  if (newLevel.name !== prevLevel.name) {
    say('Level up! You are now ' + newLevel.name);
    beep(880, 'sine', 0.3, 0.3);
  }
  updateXPUI();
}

function getLevel() {
  let lv = LEVELS[0];
  for (const l of LEVELS) { if (GAME.xp >= l.xp) lv = l; }
  return lv;
}
function getNextLevel() {
  const cur = LEVELS.indexOf(getLevel());
  return LEVELS[cur + 1] || null;
}

function updateXPUI() {
  const cur  = getLevel();
  const next = getNextLevel();
  const idx  = LEVELS.indexOf(cur);
  document.getElementById('xp-level').textContent = 'Lv.' + (idx + 1);
  document.getElementById('xp-title').textContent = cur.name;
  document.getElementById('xp-cur').textContent   = GAME.xp;
  document.getElementById('xp-max').textContent   = next ? next.xp : '∞';
  const pct = next ? Math.min(100, ((GAME.xp - cur.xp) / (next.xp - cur.xp)) * 100) : 100;
  document.getElementById('xp-bar').style.width = pct + '%';
}

// ══════════════════════════════════════════
// SESSION STATE
// ══════════════════════════════════════════
const SS = {
  mode:   'explore',
  active: false,
  fps: 0, _fc: 0, _ft: 0,
};

// BOXING STATE — carefully designed to prevent false positives
const BOX = {
  punches: 0, left: 0, right: 0,
  jab: 0, cross: 0, hook: 0, upper: 0,

  // State machine per arm: 'idle' → 'extended' → 'retracted' → 'idle'
  // This prevents counting the same punch multiple times
  leftState:  'idle',  // 'idle' | 'extending' | 'peak' | 'retracting'
  rightState: 'idle',

  // Smoothed distances to reduce noise
  leftDistSmooth:  0,
  rightDistSmooth: 0,
  leftAngleSmooth: 0,
  rightAngleSmooth: 0,

  // Lock prevents double-counting
  leftLock:  false,
  rightLock: false,
  leftLockTimer:  null,
  rightLockTimer: null,

  headDir: '—',
  flashLabel: '',
  flashTimer: null,
  combo: [],
  comboTimer: null,
};

// WORKOUT STATE
const WORK = {
  reps: 0, ex: 'squat', phase: 'up', cal: 0,
  angleSmooth: 0,
  inRep: false,
  lastRepTime: 0,
  repCooldown: 800, // ms between reps
};

// SIGN STATE — deterministic based on finger state, not random
const SIGN = {
  detected: '—',
  confidence: 0,
  sentence: '',
  lastDetectTime: 0,
  detectCooldown: 1500,
  holdTimer: null,
  holdCount: 0,
  holdRequired: 10, // frames to hold before confirming
  lastGesture: null,
};

// ══════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════
const video      = document.getElementById('video');
const canvas     = document.getElementById('canvas');
const CTX        = canvas.getContext('2d');
const hudEl      = document.getElementById('hud');
const rightPanel = document.getElementById('right-panel');
const modeLabelEl= document.getElementById('mode-label');
const statusDot  = document.getElementById('status-dot');
const statusTxt  = document.getElementById('status-txt');
const fpsChip    = document.getElementById('fps-chip');
const lmLabel    = document.getElementById('lm-label');
const sessionBtn = document.getElementById('session-btn');
const tmBody     = document.getElementById('tm-body');
const tmHands    = document.getElementById('tm-hands');
const tmTotal    = document.getElementById('tm-total');

// ══════════════════════════════════════════
// DRAWING
// ══════════════════════════════════════════
const COL = {
  explore: { body:'#00ff88', larm:'#00ff88', rarm:'#00ff88', leg:'#00cc66' },
  boxing:  { body:'#4da6ff', larm:'#ff3e6c', rarm:'#00ff88', leg:'#2255aa' },
  workout: { body:'#ffb800', larm:'#ffb800', rarm:'#ffb800', leg:'#cc8800' },
  sign:    { body:'#ff6eb4', larm:'#ff6eb4', rarm:'#ff6eb4', leg:'#cc3388' },
};

const BODY_LINES = [
  [11,12,'body'],[11,23,'body'],[12,24,'body'],[23,24,'body'],
  [11,13,'larm'],[13,15,'larm'],
  [12,14,'rarm'],[14,16,'rarm'],
  [23,25,'leg'],[25,27,'leg'],[27,29,'leg'],[27,31,'leg'],
  [24,26,'leg'],[26,28,'leg'],[28,30,'leg'],[28,32,'leg'],
  [15,17,'larm'],[15,19,'larm'],[15,21,'larm'],
  [16,18,'rarm'],[16,20,'rarm'],[16,22,'rarm'],
  [0,1,'body'],[1,2,'body'],[2,3,'body'],[3,7,'body'],
  [0,4,'body'],[4,5,'body'],[5,6,'body'],[6,8,'body'],
  [9,10,'body'],
];
const HAND_LINES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];
const LANDMARK_SIZES = {0:7,11:7,12:7,13:6,14:6,15:6,16:6,23:5,24:5,25:5,26:5,27:5,28:5};

function resize() {
  const w = canvas.offsetWidth || canvas.parentElement.offsetWidth || 640;
  const h = canvas.offsetHeight || canvas.parentElement.offsetHeight || 480;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
}

function lx(lm) { return lm.x * canvas.width; }
function ly(lm) { return lm.y * canvas.height; }
function lv(lm) { return !lm ? false : lm.visibility === undefined ? true : lm.visibility > 0.15; }

function hex2rgba(hex, a) {
  const n = parseInt(hex.replace('#',''), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

function drawLine(x1, y1, x2, y2, col, w) {
  CTX.beginPath();
  CTX.moveTo(x1, y1); CTX.lineTo(x2, y2);
  CTX.strokeStyle = col; CTX.lineWidth = w || 2; CTX.lineCap = 'round';
  if (CFG.glow) { CTX.shadowColor = col; CTX.shadowBlur = 8; }
  CTX.stroke();
  CTX.shadowBlur = 0;
}

function drawDot(x, y, col, r) {
  CTX.beginPath();
  CTX.arc(x, y, r || 5, 0, Math.PI * 2);
  CTX.fillStyle = col;
  if (CFG.glow) { CTX.shadowColor = col; CTX.shadowBlur = 12; }
  CTX.fill();
  CTX.shadowBlur = 0;
}

function renderSkeleton(pose, lh, rh) {
  if (!pose) return;
  const c = COL[SS.mode] || COL.explore;

  if (CFG.skeleton) {
    for (const [a, b, ck] of BODY_LINES) {
      const A = pose[a], B = pose[b];
      if (!lv(A) || !lv(B)) continue;
      drawLine(lx(A), ly(A), lx(B), ly(B), hex2rgba(c[ck], 0.82), 2);
    }
    if (lh) for (const [a, b] of HAND_LINES) {
      if (!lh[a] || !lh[b]) continue;
      drawLine(lx(lh[a]), ly(lh[a]), lx(lh[b]), ly(lh[b]), hex2rgba(c.larm, 0.75), 1.5);
    }
    if (rh) for (const [a, b] of HAND_LINES) {
      if (!rh[a] || !rh[b]) continue;
      drawLine(lx(rh[a]), ly(rh[a]), lx(rh[b]), ly(rh[b]), hex2rgba(c.rarm, 0.75), 1.5);
    }
  }

  if (CFG.dots) {
    for (let i = 0; i < pose.length; i++) {
      const lm = pose[i];
      if (!lv(lm)) continue;
      let col = c.body, r = LANDMARK_SIZES[i] || 4;
      if (i === 0)                col = '#ffffff';
      else if (i === 11 || i === 12) col = '#ffb800';
      else if ([15,17,19,21].includes(i)) col = c.larm;
      else if ([16,18,20,22].includes(i)) col = c.rarm;
      else if (i >= 23)           col = c.leg;
      drawDot(lx(lm), ly(lm), col, r);
    }
    if (lh) lh.forEach((lm, i) => {
      if (!lm) return;
      drawDot(lx(lm), ly(lm), c.larm, i === 0 ? 6 : i % 4 === 0 ? 4 : 3);
    });
    if (rh) rh.forEach((lm, i) => {
      if (!lm) return;
      drawDot(lx(rh[i]), ly(rh[i]), c.rarm, i === 0 ? 6 : i % 4 === 0 ? 4 : 3);
    });
  }
}

function renderFaceMesh(face) {
  if (!face || !CFG.face) return;
  CTX.fillStyle = 'rgba(168,85,247,0.45)';
  face.forEach(lm => {
    CTX.beginPath();
    CTX.arc(lm.x * canvas.width, lm.y * canvas.height, 1, 0, Math.PI * 2);
    CTX.fill();
  });
}

// ══════════════════════════════════════════
// MATH
// ══════════════════════════════════════════
function angleDeg(A, B, C) {
  if (!A || !B || !C) return 0;
  const ab = { x: A.x - B.x, y: A.y - B.y };
  const cb = { x: C.x - B.x, y: C.y - B.y };
  const dot   = ab.x * cb.x + ab.y * cb.y;
  const cross = ab.x * cb.y - ab.y * cb.x;
  return Math.abs(Math.atan2(cross, dot) * 180 / Math.PI);
}

function dist2D(A, B) {
  if (!A || !B) return 0;
  return Math.sqrt((A.x - B.x) ** 2 + (A.y - B.y) ** 2);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ══════════════════════════════════════════
// BOXING — State-machine based, prevents false positives
// ══════════════════════════════════════════
function processBoxing(pose) {
  if (!pose) return;

  const lW = pose[15], lE = pose[13], lS = pose[11];
  const rW = pose[16], rE = pose[14], rS = pose[12];

  // Smooth the distances to reduce jitter
  const lDistRaw = dist2D(lW, lS);
  const rDistRaw = dist2D(rW, rS);
  BOX.leftDistSmooth  = lerp(BOX.leftDistSmooth,  lDistRaw,  0.3);
  BOX.rightDistSmooth = lerp(BOX.rightDistSmooth, rDistRaw, 0.3);

  const lAngRaw = angleDeg(lS, lE, lW);
  const rAngRaw = angleDeg(rS, rE, rW);
  BOX.leftAngleSmooth  = lerp(BOX.leftAngleSmooth,  lAngRaw,  0.3);
  BOX.rightAngleSmooth = lerp(BOX.rightAngleSmooth, rAngRaw, 0.3);

  const EXTEND_DIST  = 0.34; // arm must extend this far relative to frame
  const EXTEND_ANGLE = 125;  // elbow must be this open
  const RETRACT_DIST = 0.22; // arm must come back this close to reset

  // LEFT ARM state machine
  if (!BOX.leftLock) {
    if (BOX.leftState === 'idle') {
      if (BOX.leftDistSmooth > EXTEND_DIST && BOX.leftAngleSmooth > EXTEND_ANGLE) {
        BOX.leftState = 'extended';
      }
    } else if (BOX.leftState === 'extended') {
      if (BOX.leftDistSmooth < RETRACT_DIST) {
        // PUNCH CONFIRMED — arm extended then came back
        BOX.leftState = 'idle';
        if (SS.active) {
          registerPunch('left', lW, lS, BOX.leftAngleSmooth);
        }
        // lock for a moment to prevent bounce
        BOX.leftLock = true;
        clearTimeout(BOX.leftLockTimer);
        BOX.leftLockTimer = setTimeout(() => { BOX.leftLock = false; }, 300);
      }
    }
  }

  // RIGHT ARM state machine
  if (!BOX.rightLock) {
    if (BOX.rightState === 'idle') {
      if (BOX.rightDistSmooth > EXTEND_DIST && BOX.rightAngleSmooth > EXTEND_ANGLE) {
        BOX.rightState = 'extended';
      }
    } else if (BOX.rightState === 'extended') {
      if (BOX.rightDistSmooth < RETRACT_DIST) {
        BOX.rightState = 'idle';
        if (SS.active) {
          registerPunch('right', rW, rS, BOX.rightAngleSmooth);
        }
        BOX.rightLock = true;
        clearTimeout(BOX.rightLockTimer);
        BOX.rightLockTimer = setTimeout(() => { BOX.rightLock = false; }, 300);
      }
    }
  }

  // Head direction
  const nose = pose[0], lEar = pose[7], rEar = pose[8];
  if (lv(nose) && lv(lEar) && lv(rEar)) {
    const earMid = (lEar.x + rEar.x) / 2;
    const diff = nose.x - earMid;
    if      (diff >  0.05) BOX.headDir = 'TURNED RIGHT';
    else if (diff < -0.05) BOX.headDir = 'TURNED LEFT';
    else                   BOX.headDir = 'FORWARD';
  }
}

function registerPunch(side, wrist, shoulder, ang) {
  // Classify punch type
  let type = 'Hook';
  if (ang > 148) {
    type = (side === 'left') ? 'Jab' : 'Cross';
  }
  if (lv(wrist) && lv(shoulder) && wrist.y < shoulder.y - 0.06) {
    type = 'Uppercut';
  }

  BOX.punches++;
  if (side === 'left')  BOX.left++;
  else                  BOX.right++;
  if (type === 'Jab')      BOX.jab++;
  else if (type === 'Cross') BOX.cross++;
  else if (type === 'Hook')  BOX.hook++;
  else                       BOX.upper++;

  GAME.totalPunches++;
  addXP(2);

  // Combo tracking
  const code = side === 'left' ? '1' : '2';
  BOX.combo.push(code);
  if (BOX.combo.length > 5) BOX.combo.shift();
  clearTimeout(BOX.comboTimer);
  BOX.comboTimer = setTimeout(() => { BOX.combo = []; renderHUD(); }, 2000);

  // Flash
  BOX.flashLabel = type + ' — ' + side.toUpperCase();
  clearTimeout(BOX.flashTimer);
  BOX.flashTimer = setTimeout(() => { BOX.flashLabel = ''; renderHUD(); }, 700);

  beep(side === 'left' ? 200 : 260, 'square', 0.08, 0.2);
  renderStats();
  renderHUD();
  updateNavBadge('boxing', BOX.punches);
}

// ══════════════════════════════════════════
// WORKOUT — Accurate angle-based rep counting
// ══════════════════════════════════════════
const EXERCISES = {
  squat:       { joints:[23,25,27], downAngle:95,  upAngle:160, name:'Squat',          cal:0.38 },
  pushup:      { joints:[11,13,15], downAngle:75,  upAngle:145, name:'Push-Up',         cal:0.42 },
  lunge:       { joints:[23,25,27], downAngle:95,  upAngle:155, name:'Lunge',           cal:0.32 },
  jumpingjack: { joints:[11,13,15], downAngle:160, upAngle:60,  name:'Jumping Jack',    cal:0.5, inverted:true },
  highknee:    { joints:[23,25,27], downAngle:80,  upAngle:145, name:'High Knee',       cal:0.44 },
  situp:       { joints:[11,23,25], downAngle:160, upAngle:60,  name:'Sit-Up',          cal:0.35, inverted:true },
  shoulderpress:{ joints:[11,13,15],downAngle:75,  upAngle:160, name:'Shoulder Press',  cal:0.28 },
  bicepscurl:  { joints:[11,13,15], downAngle:40,  upAngle:145, name:'Bicep Curl',      cal:0.22 },
};

function processWorkout(pose) {
  if (!pose) return;
  const ex = EXERCISES[WORK.ex];
  if (!ex) return;

  const [hi, ki, ai] = ex.joints;
  const H = pose[hi], K = pose[ki], A = pose[ai];
  if (!lv(H) || !lv(K) || !lv(A)) return;

  const rawAngle = angleDeg(H, K, A);
  WORK.angleSmooth = lerp(WORK.angleSmooth, rawAngle, 0.25);

  const now = Date.now();
  if (now - WORK.lastRepTime < WORK.repCooldown) return;

  const DOWN = ex.inverted ? ex.upAngle   : ex.downAngle;
  const UP   = ex.inverted ? ex.downAngle : ex.upAngle;

  if (WORK.phase === 'up' && WORK.angleSmooth < DOWN) {
    WORK.phase = 'down';
    WORK.inRep = true;
  }
  if (WORK.phase === 'down' && WORK.inRep && WORK.angleSmooth > UP) {
    WORK.phase    = 'up';
    WORK.inRep    = false;
    WORK.reps++;
    WORK.lastRepTime = now;
    WORK.cal = Math.round(WORK.reps * ex.cal);
    GAME.totalReps++;
    addXP(3);
    beep(440, 'sine', 0.1, 0.2);
    if (WORK.reps % 5 === 0) say(WORK.reps + ' reps!');
    renderStats();
    updateNavBadge('workout', WORK.reps);
  }
}

// ══════════════════════════════════════════
// SIGN LANGUAGE — Deterministic finger analysis
// ══════════════════════════════════════════

// Finger extension detection
// Returns array of 5 booleans: [thumb, index, middle, ring, pinky]
function getFingerState(hand) {
  if (!hand || hand.length < 21) return null;
  const extended = [];

  // Thumb: compare tip to IP joint (different axis)
  const thumbTip = hand[4], thumbIP = hand[3], thumbMCP = hand[2];
  extended.push(dist2D(thumbTip, hand[0]) > dist2D(thumbIP, hand[0]));

  // Other fingers: compare tip y to PIP joint y
  const fingerTips = [8, 12, 16, 20];
  const fingerPIPs = [6, 10, 14, 18];
  for (let i = 0; i < 4; i++) {
    const tip = hand[fingerTips[i]];
    const pip = hand[fingerPIPs[i]];
    if (!tip || !pip) { extended.push(false); continue; }
    // In normalized coords, lower y = higher on screen
    // A finger is extended if tip is ABOVE (lower y) than PIP
    extended.push(tip.y < pip.y - 0.03);
  }
  return extended; // [thumb, index, middle, ring, pinky]
}

// Map finger states to ASL letters/words
function classifyGesture(ext) {
  if (!ext) return null;
  const [T, I, M, R, P] = ext;
  const count = ext.filter(Boolean).length;

  // Specific patterns
  if (!T && !I && !M && !R && !P) return { sign: 'A', conf: 90 };
  if (!T &&  I &&  M &&  R &&  P) return { sign: 'B', conf: 88 };
  if (!T && !I && !M && !R && !P) return { sign: 'A', conf: 85 };
  if ( T && !I && !M && !R && !P) return { sign: 'A', conf: 80 };
  if (!T &&  I && !M && !R && !P) return { sign: 'D', conf: 87 };
  if (!T && !I &&  M && !R && !P) return { sign: 'Middle', conf: 75 };
  if ( T &&  I && !M && !R && !P) return { sign: 'L',   conf: 91 };
  if ( T && !I && !M && !R &&  P) return { sign: 'Y',   conf: 89 };
  if ( T &&  I &&  M &&  R &&  P) return { sign: 'Hello', conf: 92 };
  if (!T &&  I &&  M && !R && !P) return { sign: 'V / Peace', conf: 88 };
  if ( T &&  I && !M && !R &&  P) return { sign: 'I Love You', conf: 93 };
  if (!T && !I && !M && !R &&  P) return { sign: 'Pinky',   conf: 80 };
  if ( T && !I && !M && !R && !P) return { sign: 'Good',    conf: 85 };
  if ( T &&  I &&  M && !R && !P) return { sign: 'W / Three', conf: 82 };
  if (count === 0)                 return { sign: 'Fist / S', conf: 88 };
  if (count === 5)                 return { sign: 'Open Hand', conf: 90 };

  return null;
}

function processSign(lh, rh) {
  const hand = lh || rh;
  if (!hand) {
    SIGN.holdCount = 0; SIGN.lastGesture = null; return;
  }

  const ext = getFingerState(hand);
  const result = classifyGesture(ext);
  if (!result) { SIGN.holdCount = 0; return; }

  // Require same gesture for N frames before confirming
  if (result.sign === SIGN.lastGesture) {
    SIGN.holdCount++;
  } else {
    SIGN.lastGesture = result.sign;
    SIGN.holdCount = 1;
  }

  // Update live confidence preview
  if (SIGN.holdCount >= 3) {
    SIGN.detected    = result.sign;
    SIGN.confidence  = result.conf;
    renderStats();
  }

  // Confirm and speak after holding long enough
  const now = Date.now();
  if (SIGN.holdCount >= SIGN.holdRequired && now - SIGN.lastDetectTime > SIGN.detectCooldown) {
    SIGN.lastDetectTime = now;
    SIGN.holdCount = 0;

    // Add to sentence
    SIGN.sentence = (SIGN.sentence + ' ' + result.sign).trim().split(' ').slice(-8).join(' ');
    GAME.totalSigns++;
    addXP(5);
    say(result.sign);
    beep(520, 'sine', 0.1, 0.2);
    renderStats();
  }
}

// ══════════════════════════════════════════
// RENDER STATS PANEL
// ══════════════════════════════════════════
const TIPS = {
  explore:  'Your full body skeleton is live. All 33 body landmarks, 21 per hand, and 478 face points are tracked in real time.',
  boxing:   'Throw a full punch — extend your arm completely, then retract. Each complete extend-retract counts as one punch.',
  workout:  'Stand fully in frame. Go through the full range of motion for accurate rep counting.',
  sign:     'Hold each sign steady for about half a second. The AI confirms the sign after seeing it consistently.',
};

function renderStats() {
  const m = SS.mode;
  let html = '';

  if (m === 'explore') {
    html = `
      <div class="rp-label">Live landmarks</div>
      <div class="rp-card"><div class="rp-big g">33</div><div class="rp-sub">Body joints tracked</div></div>
      <div class="rp-card"><div class="rp-big b">42</div><div class="rp-sub">Hand landmarks (both)</div></div>
      <div class="rp-card"><div class="rp-big" style="color:var(--purp)">478</div><div class="rp-sub">Face points (enable in settings)</div></div>
      <div class="coach-card"><div class="coach-title">Welcome</div><div class="coach-body">${TIPS.explore}</div></div>
    `;
  }

  else if (m === 'boxing') {
    const b = BOX;
    const mx = Math.max(b.jab, b.cross, b.hook, b.upper, 1);
    html = `
      <div class="rp-label">Punches</div>
      <div class="rp-card">
        <div class="rp-big r">${b.punches}</div>
        <div class="rp-sub">L: ${b.left} &nbsp;|&nbsp; R: ${b.right}</div>
      </div>
      <div class="rp-label">Breakdown</div>
      <div class="rp-card">
        <div class="punch-row"><span class="punch-name">Jab</span><div class="punch-track"><div class="punch-fill" style="width:${(b.jab/mx)*100}%;background:#4da6ff"></div></div><span class="punch-count">${b.jab}</span></div>
        <div class="punch-row"><span class="punch-name">Cross</span><div class="punch-track"><div class="punch-fill" style="width:${(b.cross/mx)*100}%;background:#ff3e6c"></div></div><span class="punch-count">${b.cross}</span></div>
        <div class="punch-row"><span class="punch-name">Hook</span><div class="punch-track"><div class="punch-fill" style="width:${(b.hook/mx)*100}%;background:#ffb800"></div></div><span class="punch-count">${b.hook}</span></div>
        <div class="punch-row"><span class="punch-name">Uppercut</span><div class="punch-track"><div class="punch-fill" style="width:${(b.upper/mx)*100}%;background:#a855f7"></div></div><span class="punch-count">${b.upper}</span></div>
      </div>
      <div class="rp-label">Head</div>
      <div class="rp-card"><div class="rp-big b" style="font-size:15px">${b.headDir}</div></div>
      <div class="coach-card"><div class="coach-title">Coach tip</div><div class="coach-body">${TIPS.boxing}</div></div>
    `;
  }

  else if (m === 'workout') {
    const w = WORK;
    const ex = EXERCISES[w.ex];
    html = `
      <div class="rp-label">Exercise</div>
      <div class="rp-card">
        <div class="rp-big a" style="font-size:16px">${ex ? ex.name : '—'}</div>
        <div class="rp-sub">Phase: ${w.phase.toUpperCase()} &nbsp;|&nbsp; Angle: ${Math.round(w.angleSmooth)}°</div>
      </div>
      <div class="rp-label">Reps</div>
      <div class="rp-card"><div class="rp-big g">${w.reps}</div></div>
      <div class="rp-label">Calories</div>
      <div class="rp-card"><div class="rp-big r">${w.cal}</div><div class="rp-sub">kcal estimated</div></div>
      <div class="rp-label">Select exercise</div>
      <div class="exercise-grid" id="ex-grid">
        ${Object.entries(EXERCISES).map(([k,v]) =>
          `<div class="ex-chip ${w.ex===k?'active':''}" data-ex="${k}">${v.name}</div>`
        ).join('')}
      </div>
      <div class="coach-card"><div class="coach-title">Tip</div><div class="coach-body">${TIPS.workout}</div></div>
    `;
  }

  else if (m === 'sign') {
    const sg = SIGN;
    html = `
      <div class="rp-label">Detected sign</div>
      <div class="rp-card">
        <div class="sign-display">
          <div class="sign-letter">${sg.detected}</div>
          <div class="sign-confidence">${sg.detected !== '—' ? sg.confidence + '% confidence' : 'Show a hand sign'}</div>
        </div>
      </div>
      <div class="rp-label">Sentence</div>
      <div class="rp-card">
        <div class="sign-sentence">${sg.sentence || 'Hold a sign to start building a sentence...'}</div>
      </div>
      <div class="rp-card" style="display:flex;gap:6px">
        <button style="flex:1;padding:7px;background:rgba(255,110,180,.1);border:1px solid rgba(255,110,180,.3);color:#ff6eb4;border-radius:5px;cursor:pointer;font-size:11px" id="btn-clear-sign">Clear sentence</button>
      </div>
      <div class="coach-card"><div class="coach-title">How it works</div><div class="coach-body">${TIPS.sign}</div></div>
    `;
  }

  rightPanel.innerHTML = html;

  // Exercise chips
  const exGrid = document.getElementById('ex-grid');
  if (exGrid) {
    exGrid.querySelectorAll('.ex-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        WORK.ex = chip.dataset.ex;
        WORK.reps = 0; WORK.phase = 'up'; WORK.cal = 0;
        WORK.inRep = false; WORK.angleSmooth = 0;
        updateNavBadge('workout', 0);
        renderStats();
      });
    });
  }

  // Clear sign
  const clearSignBtn = document.getElementById('btn-clear-sign');
  if (clearSignBtn) clearSignBtn.addEventListener('click', () => {
    SIGN.sentence = ''; SIGN.detected = '—'; renderStats();
  });
}

// ══════════════════════════════════════════
// RENDER HUD
// ══════════════════════════════════════════
function renderHUD() {
  const m = SS.mode;
  let html = '';

  if (m === 'boxing' && SS.active) {
    const b = BOX;
    html += `
      <div class="hud-box tr">
        <div class="hud-num" style="color:var(--red)">${b.punches}</div>
        <div class="hud-lbl">Punches</div>
      </div>
      <div class="hud-box tl">
        <div class="hud-lbl">Head</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--green);margin-top:4px">${b.headDir}</div>
      </div>
    `;
    if (b.flashLabel) html += `<div class="punch-flash">${b.flashLabel}</div>`;
    if (b.combo.length >= 2) html += `<div class="combo-flash">COMBO: ${b.combo.join('-')}</div>`;
  }

  if (m === 'workout' && SS.active) {
    const w = WORK;
    const ex = EXERCISES[w.ex];
    html += `
      <div class="hud-box tr">
        <div class="hud-num" style="color:var(--amber)">${w.reps}</div>
        <div class="hud-lbl">${ex ? ex.name : 'Reps'}</div>
        <div class="hud-sub">${w.phase === 'down' ? '↓ Go up!' : '↑ Go down!'}</div>
      </div>
    `;
  }

  if (m === 'sign') {
    if (SIGN.detected !== '—' && SIGN.holdCount >= 3) {
      html += `
        <div class="hud-box tl">
          <div class="hud-lbl">Live sign</div>
          <div style="font-family:var(--mono);font-size:20px;color:var(--pink);margin-top:4px">${SIGN.detected}</div>
        </div>
      `;
    }
  }

  hudEl.innerHTML = html;
}

// ══════════════════════════════════════════
// SESSION
// ══════════════════════════════════════════
function toggleSession() {
  SS.active = !SS.active;

  if (SS.active) {
    // reset current mode stats
    if (SS.mode === 'boxing') {
      BOX.punches=BOX.left=BOX.right=BOX.jab=BOX.cross=BOX.hook=BOX.upper=0;
      BOX.combo=[]; BOX.flashLabel='';
      BOX.leftState='idle'; BOX.rightState='idle';
    }
    if (SS.mode === 'workout') {
      WORK.reps=0; WORK.cal=0; WORK.phase='up'; WORK.inRep=false; WORK.angleSmooth=0;
    }
    if (SS.mode === 'sign') {
      SIGN.sentence=''; SIGN.detected='—'; SIGN.holdCount=0;
    }
    GAME.sessions++;
    saveGame();
    beep(660, 'sine', 0.15, 0.25);
    say('Session started. Go!');
  } else {
    beep(330, 'sine', 0.2, 0.2);
    say('Session ended. Great work!');
  }

  sessionBtn.textContent  = SS.active ? '■  Stop Session' : '▶  Start Session';
  sessionBtn.className    = 'session-btn' + (SS.active ? ' stop' : '');
  renderStats();
  renderHUD();
}

sessionBtn.addEventListener('click', toggleSession);

// ══════════════════════════════════════════
// MODE SWITCHING
// ══════════════════════════════════════════
const MODE_NAMES = {
  explore: 'FREE EXPLORE',
  boxing:  'BOXING TRAINER',
  workout: 'WORKOUT',
  sign:    'SIGN LANGUAGE',
};

function setMode(mode) {
  SS.mode   = mode;
  SS.active = false;
  sessionBtn.textContent = '▶  Start Session';
  sessionBtn.className   = 'session-btn';
  modeLabelEl.textContent = MODE_NAMES[mode] || mode.toUpperCase();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // update corner color
  const colors = { explore:'#00ff88', boxing:'#ff3e6c', workout:'#ffb800', sign:'#ff6eb4' };
  const c = colors[mode] || '#00ff88';
  document.querySelectorAll('.corner').forEach(el => {
    el.style.borderColor = c;
  });
  renderStats();
  renderHUD();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

function updateNavBadge(mode, value) {
  const el = document.getElementById('badge-' + mode);
  if (!el) return;
  el.textContent = value;
  el.style.display = value > 0 ? 'block' : 'none';
}

// ══════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.toggle('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.add('hidden');
});
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('s-skel').addEventListener('change',  e => CFG.skeleton = e.target.checked);
document.getElementById('s-dots').addEventListener('change',  e => CFG.dots     = e.target.checked);
document.getElementById('s-glow').addEventListener('change',  e => CFG.glow     = e.target.checked);
document.getElementById('s-face').addEventListener('change',  e => CFG.face     = e.target.checked);
document.getElementById('s-sound').addEventListener('change', e => CFG.sound    = e.target.checked);
document.getElementById('s-voice').addEventListener('change', e => CFG.voice    = e.target.checked);
document.getElementById('s-real').addEventListener('change',  () => setViewMode('real'));
document.getElementById('s-avatar').addEventListener('change',() => setViewMode('avatar'));

document.getElementById('btn-reset-stats').addEventListener('click', () => {
  if (confirm('Reset all XP and progress?')) {
    GAME = { xp:0, totalPunches:0, totalReps:0, totalSigns:0, sessions:0 };
    saveGame(); updateXPUI();
  }
});

function setViewMode(mode) {
  viewMode = mode;
  video.classList.toggle('avatar-mode', mode === 'avatar');
}

// ══════════════════════════════════════════
// FPS
// ══════════════════════════════════════════
function tickFPS() {
  SS._fc++;
  const now = performance.now();
  if (now - SS._ft >= 1000) {
    SS.fps = SS._fc; SS._fc = 0; SS._ft = now;
    fpsChip.textContent = SS.fps + ' fps';
  }
}

// ══════════════════════════════════════════
// MEDIAPIPE RESULTS
// ══════════════════════════════════════════
function onResults(results) {
  if (!modelReady) { modelReady = true; }
  tickFPS();
  resize();
  CTX.clearRect(0, 0, canvas.width, canvas.height);

  const pose = results.poseLandmarks;
  const lh   = results.leftHandLandmarks;
  const rh   = results.rightHandLandmarks;
  const face = results.faceLandmarks;

  // tracking display
  const hCount = (lh ? lh.length : 0) + (rh ? rh.length : 0);
  const total  = (pose ? pose.length : 0) + hCount;
  tmBody.textContent  = pose ? pose.length + ' pts' : '—';
  tmBody.className    = 'tm-val' + (pose ? ' on' : '');
  tmHands.textContent = hCount > 0 ? hCount + ' pts' : '—';
  tmHands.className   = 'tm-val' + (hCount > 0 ? ' on' : '');
  tmTotal.textContent = total > 0 ? total : '—';
  lmLabel.textContent = total + ' landmarks tracked';

  renderSkeleton(pose, lh, rh);
  renderFaceMesh(face);

  switch (SS.mode) {
    case 'boxing':  processBoxing(pose);  break;
    case 'workout': processWorkout(pose); break;
    case 'sign':    processSign(lh, rh);  break;
  }
}

// ══════════════════════════════════════════
// LOADING PROGRESS
// ══════════════════════════════════════════
function setLoad(pct, msg) {
  const bar = document.getElementById('sl-fill');
  const txt = document.getElementById('sl-msg');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = msg;
}

// ══════════════════════════════════════════
// SPLASH SCREEN LOGIC
// ══════════════════════════════════════════
let camStream = null;

document.getElementById('btn-allow-cam').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio: false,
    });
    camStream = stream;
    video.srcObject = stream;

    // move to step 2
    document.getElementById('step-permission').classList.remove('active');
    document.getElementById('step-viewmode').classList.add('active');
  } catch(err) {
    document.getElementById('cam-error').classList.remove('hidden');
  }
});

// View choice toggle
document.querySelectorAll('.view-choice').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.view-choice').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    viewMode = el.dataset.view;
  });
});

document.getElementById('btn-enter').addEventListener('click', () => {
  // apply view mode
  setViewMode(viewMode);

  // show loading bar
  document.getElementById('step-viewmode').classList.remove('active');
  document.getElementById('splash-loading').classList.remove('hidden');

  setLoad(10, 'Loading MediaPipe Holistic...');
  initMediaPipe();
});

// ══════════════════════════════════════════
// MEDIAPIPE INIT
// ══════════════════════════════════════════
function initMediaPipe() {
  setLoad(20, 'Initializing pose detection...');

  const holistic = new Holistic({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${f}`
  });

  holistic.setOptions({
    modelComplexity:        1,
    smoothLandmarks:        true,
    enableSegmentation:     false,
    refineFaceLandmarks:    true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence:  0.6,
  });

  setLoad(50, 'Loading AI models...');
  holistic.onResults(onResults);
  setLoad(70, 'Starting camera tracking...');

  video.onloadedmetadata = () => {
    video.play();
    setLoad(85, 'Warming up models...');

    const cam = new Camera(video, {
      onFrame: async () => { await holistic.send({ image: video }); },
      width: 1280, height: 720,
    });
    cam.start();
    setLoad(95, 'Almost ready...');

    // wait for first real frame
    let frameCount = 0;
    const checkReady = setInterval(() => {
      frameCount++;
      if (modelReady || frameCount > 30) {
        clearInterval(checkReady);
        launchApp();
      }
    }, 200);
  };

  // If video already has metadata
  if (video.readyState >= 2) video.onloadedmetadata();
}

function launchApp() {
  setLoad(100, 'Ready!');
  statusDot.classList.add('on');
  statusTxt.textContent = 'Camera on';

  setTimeout(() => {
    const splash = document.getElementById('splash');
    splash.classList.add('out');
    document.getElementById('app').classList.remove('hidden');
    setTimeout(() => splash.remove(), 800);
  }, 300);

  setMode('explore');
  updateXPUI();
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
renderStats();
updateXPUI();
