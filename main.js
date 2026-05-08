// ╔══════════════════════════════════════════════╗
// ║  POSEAI  main.js  v4.0 — Production Build   ║
// ╚══════════════════════════════════════════════╝

'use strict';

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const CFG = {
  skeleton: true, dots: true, glow: true, face: false,
  sound: true, voice: true, voiceGender: 'male',
  viewMode: 'real',
};

// ══════════════════════════════════════════
//  VOICE ENGINE  (fixed — no session mixing)
// ══════════════════════════════════════════
let _voices = [];
let _voiceReady = false;
let _speakQueue = [];
let _speaking = false;

function initVoices() {
  _voices = window.speechSynthesis.getVoices();
  _voiceReady = true;
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = initVoices;
  initVoices();
}

function pickVoice(gender) {
  if (!_voices.length) _voices = window.speechSynthesis.getVoices();
  // Preferred voices per gender
  const maleNames  = ['David','James','Daniel','Google UK English Male','Microsoft David','en-US-Guy'];
  const femaleNames= ['Samantha','Karen','Victoria','Google UK English Female','Microsoft Zira','en-US-Aria'];
  const preferred  = gender === 'female' ? femaleNames : maleNames;

  for (const name of preferred) {
    const v = _voices.find(vx => vx.name.includes(name));
    if (v) return v;
  }
  // fallback: any en voice matching gender hint
  const lang = _voices.filter(v => v.lang.startsWith('en'));
  if (gender === 'male')   return lang.find(v => !v.name.toLowerCase().includes('female')) || lang[0];
  if (gender === 'female') return lang.find(v => v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('samantha') || v.name.toLowerCase().includes('karen')) || lang[0];
  return lang[0] || _voices[0];
}

function say(txt, priority) {
  if (!CFG.voice || !window.speechSynthesis) return;
  if (priority) {
    // High priority: cancel current and speak immediately
    window.speechSynthesis.cancel();
    _speakQueue = [];
    _speaking = false;
  }
  _speakQueue.push(txt);
  if (!_speaking) drainQueue();
}

function drainQueue() {
  if (!_speakQueue.length) { _speaking = false; return; }
  _speaking = true;
  const txt = _speakQueue.shift();
  const u = new SpeechSynthesisUtterance(txt);
  u.rate = 1.1; u.pitch = CFG.voiceGender === 'female' ? 1.2 : 0.95; u.volume = 0.95;
  const v = pickVoice(CFG.voiceGender);
  if (v) u.voice = v;
  u.onend = () => setTimeout(drainQueue, 80);
  u.onerror = () => { _speaking = false; drainQueue(); };
  window.speechSynthesis.speak(u);
}

// ══════════════════════════════════════════
//  AUDIO BEEPS
// ══════════════════════════════════════════
let _ac = null;
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}
function beep(hz, type, dur, vol) {
  if (!CFG.sound) return;
  hz=hz||440; type=type||'sine'; dur=dur||0.12; vol=vol||0.2;
  try {
    const c=getAC(), o=c.createOscillator(), g=c.createGain();
    o.connect(g); g.connect(c.destination);
    o.type=type; o.frequency.value=hz;
    g.gain.setValueAtTime(vol,c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+dur);
    o.start(c.currentTime); o.stop(c.currentTime+dur);
  } catch(e){}
}
function chime(notes) {
  // plays a sequence of notes
  let t = 0;
  notes.forEach(([hz,dur,vol]) => {
    setTimeout(() => beep(hz,'sine',dur,vol||0.2), t);
    t += dur * 1000 + 50;
  });
}

// ══════════════════════════════════════════
//  SAVE / LOAD
// ══════════════════════════════════════════
const SK = 'poseai_v4';
let GAME = (() => {
  try { const r=localStorage.getItem(SK); if(r) return JSON.parse(r); } catch(e){}
  return { xp:0, punches:0, reps:0, signs:0, wins:0, losses:0, ties:0, sessions:0 };
})();
function saveGame() { try { localStorage.setItem(SK, JSON.stringify(GAME)); } catch(e){} }

// ══════════════════════════════════════════
//  XP / LEVELS
// ══════════════════════════════════════════
const LEVELS = [
  {n:'Beginner',xp:0},{n:'Trainee',xp:100},{n:'Athlete',xp:280},
  {n:'Fighter',xp:550},{n:'Champion',xp:900},{n:'Elite',xp:1400},{n:'Legend',xp:2200},
];
function getLevel(xp) { let l=LEVELS[0]; for(const lv of LEVELS) if(xp>=lv.xp) l=lv; return l; }
function getNextLevel(xp) { const i=LEVELS.indexOf(getLevel(xp)); return LEVELS[i+1]||null; }
function addXP(n) {
  const prev = getLevel(GAME.xp);
  GAME.xp += n; saveGame();
  const now = getLevel(GAME.xp);
  if (now.n !== prev.n) {
    chime([[660,.12],[880,.15],[1100,.2]]);
    say('Level up! You are now ' + now.n, true);
  }
  updateXPUI();
}
function updateXPUI() {
  const cur=getLevel(GAME.xp), nxt=getNextLevel(GAME.xp), idx=LEVELS.indexOf(cur);
  document.getElementById('xp-lv').textContent  = 'Lv.'+(idx+1);
  document.getElementById('xp-nm').textContent  = cur.n;
  document.getElementById('xp-cur').textContent = GAME.xp;
  document.getElementById('xp-max').textContent = nxt ? nxt.xp : '∞';
  const pct = nxt ? Math.min(100,((GAME.xp-cur.xp)/(nxt.xp-cur.xp))*100) : 100;
  document.getElementById('xp-fill').style.width = pct + '%';
}

// ══════════════════════════════════════════
//  SESSION / MODE
// ══════════════════════════════════════════
let MODE   = 'explore';
let ACTIVE = false;
let FPS=0, _fc=0, _ft=0;
let MODEL_READY = false;

// ══════════════════════════════════════════
//  DOM
// ══════════════════════════════════════════
const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const CTX      = canvas.getContext('2d');
const hudEl    = document.getElementById('hud');
const rpanel   = document.getElementById('rpanel');
const modeLabel= document.getElementById('mode-label');
const sdot     = document.getElementById('sdot');
const stxt     = document.getElementById('stxt');
const fpsEl    = document.getElementById('fps');
const lmlblEl  = document.getElementById('lmlbl');
const sessBtn  = document.getElementById('sess-btn');
const tmBody   = document.getElementById('tm-body');
const tmHands  = document.getElementById('tm-hands');
const tmTotal  = document.getElementById('tm-total');

// ══════════════════════════════════════════
//  SKELETON COLORS
// ══════════════════════════════════════════
const COL = {
  explore:{body:'#00ff88',larm:'#00ff88',rarm:'#00ff88',leg:'#00cc66'},
  boxing: {body:'#4da6ff',larm:'#ff3e6c',rarm:'#00ff88',leg:'#1e55bb'},
  workout:{body:'#ffb800',larm:'#ffb800',rarm:'#ffb800',leg:'#bb8800'},
  sign:   {body:'#ff6eb4',larm:'#ff6eb4',rarm:'#ff6eb4',leg:'#cc3388'},
  rps:    {body:'#a855f7',larm:'#a855f7',rarm:'#a855f7',leg:'#7733cc'},
};
const CORNER_COLORS = {explore:'#00ff88',boxing:'#ff3e6c',workout:'#ffb800',sign:'#ff6eb4',rps:'#a855f7'};

const BODY_CONN = [
  [11,12,'body'],[11,23,'body'],[12,24,'body'],[23,24,'body'],
  [11,13,'larm'],[13,15,'larm'],[15,17,'larm'],[15,19,'larm'],[15,21,'larm'],
  [12,14,'rarm'],[14,16,'rarm'],[16,18,'rarm'],[16,20,'rarm'],[16,22,'rarm'],
  [23,25,'leg'],[25,27,'leg'],[27,29,'leg'],[27,31,'leg'],
  [24,26,'leg'],[26,28,'leg'],[28,30,'leg'],[28,32,'leg'],
  [0,1,'body'],[1,2,'body'],[2,3,'body'],[3,7,'body'],
  [0,4,'body'],[4,5,'body'],[5,6,'body'],[6,8,'body'],[9,10,'body'],
];
const HAND_CONN = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
];
const BIG_JOINTS = new Set([0,11,12,13,14,15,16,23,24,25,26,27,28]);

// ══════════════════════════════════════════
//  DRAW
// ══════════════════════════════════════════
function resizeCanvas() {
  const w = canvas.offsetWidth || 640, h = canvas.offsetHeight || 480;
  if (canvas.width!==w||canvas.height!==h) { canvas.width=w; canvas.height=h; }
}
window.addEventListener('resize', resizeCanvas);

const lx = lm => lm.x * canvas.width;
const ly = lm => lm.y * canvas.height;
const lv = lm => !lm ? false : (lm.visibility===undefined ? true : lm.visibility > 0.12);
const h2r = (hex,a) => { const n=parseInt(hex.replace('#',''),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; };

function dline(x1,y1,x2,y2,col,w) {
  CTX.beginPath(); CTX.moveTo(x1,y1); CTX.lineTo(x2,y2);
  CTX.strokeStyle=col; CTX.lineWidth=w||2; CTX.lineCap='round';
  if(CFG.glow){CTX.shadowColor=col;CTX.shadowBlur=7;}
  CTX.stroke(); CTX.shadowBlur=0;
}
function ddot(x,y,col,r) {
  CTX.beginPath(); CTX.arc(x,y,r||5,0,Math.PI*2);
  CTX.fillStyle=col;
  if(CFG.glow){CTX.shadowColor=col;CTX.shadowBlur=11;}
  CTX.fill(); CTX.shadowBlur=0;
}

function drawSkeleton(pose,lh,rh) {
  if(!pose) return;
  const c=COL[MODE]||COL.explore;
  if(CFG.skeleton) {
    for(const[a,b,ck] of BODY_CONN){
      const A=pose[a],B=pose[b]; if(!lv(A)||!lv(B)) continue;
      dline(lx(A),ly(A),lx(B),ly(B),h2r(c[ck],.8),2);
    }
    if(lh) for(const[a,b] of HAND_CONN){if(!lh[a]||!lh[b])continue;dline(lx(lh[a]),ly(lh[a]),lx(lh[b]),ly(lh[b]),h2r(c.larm,.72),1.5);}
    if(rh) for(const[a,b] of HAND_CONN){if(!rh[a]||!rh[b])continue;dline(lx(rh[a]),ly(rh[a]),lx(rh[b]),ly(rh[b]),h2r(c.rarm,.72),1.5);}
  }
  if(CFG.dots) {
    for(let i=0;i<pose.length;i++){
      const lm=pose[i]; if(!lv(lm)) continue;
      let col=c.body, r=BIG_JOINTS.has(i)?6:4;
      if(i===0){col='#fff';r=6;}
      else if(i===11||i===12){col='#ffb800';r=7;}
      else if([15,17,19,21].includes(i))col=c.larm;
      else if([16,18,20,22].includes(i))col=c.rarm;
      else if(i>=23)col=c.leg;
      ddot(lx(lm),ly(lm),col,r);
    }
    if(lh)lh.forEach((lm,i)=>{if(!lm)return;ddot(lx(lm),ly(lm),c.larm,i===0?6:i%4===0?4:3);});
    if(rh)rh.forEach((lm,i)=>{if(!rh[i])return;ddot(lx(rh[i]),ly(rh[i]),c.rarm,i===0?6:i%4===0?4:3);});
  }
}
function drawFace(face){
  if(!face||!CFG.face)return;
  CTX.fillStyle='rgba(168,85,247,.4)';
  face.forEach(lm=>{CTX.beginPath();CTX.arc(lm.x*canvas.width,lm.y*canvas.height,1,0,Math.PI*2);CTX.fill();});
}

// FPS
function tickFPS(){
  _fc++; const now=performance.now();
  if(now-_ft>=1000){FPS=_fc;_fc=0;_ft=now;fpsEl.textContent=FPS+' fps';}
}

// MATH
function angleDeg(A,B,C){
  if(!A||!B||!C)return 0;
  const ab={x:A.x-B.x,y:A.y-B.y},cb={x:C.x-B.x,y:C.y-B.y};
  return Math.abs(Math.atan2(ab.x*cb.y-ab.y*cb.x,ab.x*cb.x+ab.y*cb.y)*180/Math.PI);
}
function dist2(A,B){if(!A||!B)return 0;return Math.sqrt((A.x-B.x)**2+(A.y-B.y)**2);}
function lerp(a,b,t){return a+(b-a)*t;}

// ══════════════════════════════════════════
//  BOXING — State-machine (no false positives)
// ══════════════════════════════════════════
const BOX = {
  punches:0,left:0,right:0,jab:0,cross:0,hook:0,upper:0,
  lState:'idle',rState:'idle',       // 'idle' | 'out'
  lDist:0,rDist:0,lAng:0,rAng:0,    // smoothed values
  lLock:false,rLock:false,
  lTimer:null,rTimer:null,
  headDir:'—',flash:'',flashTimer:null,
  combo:[],comboTimer:null,
};
const EXTEND=0.33, RETRACT=0.20, EXT_ANG=122;

function processBoxing(pose){
  if(!pose)return;
  const lW=pose[15],lE=pose[13],lS=pose[11];
  const rW=pose[16],rE=pose[14],rS=pose[12];

  BOX.lDist=lerp(BOX.lDist,dist2(lW,lS),.28);
  BOX.rDist=lerp(BOX.rDist,dist2(rW,rS),.28);
  BOX.lAng=lerp(BOX.lAng,angleDeg(lS,lE,lW),.28);
  BOX.rAng=lerp(BOX.rAng,angleDeg(rS,rE,rW),.28);

  // LEFT arm state machine
  if(!BOX.lLock){
    if(BOX.lState==='idle' && BOX.lDist>EXTEND && BOX.lAng>EXT_ANG){
      BOX.lState='out';
    } else if(BOX.lState==='out' && BOX.lDist<RETRACT){
      BOX.lState='idle';
      if(ACTIVE) registerPunch('left',lW,lS,BOX.lAng);
      BOX.lLock=true;
      clearTimeout(BOX.lTimer);
      BOX.lTimer=setTimeout(()=>{BOX.lLock=false;},320);
    }
  }
  // RIGHT arm state machine
  if(!BOX.rLock){
    if(BOX.rState==='idle' && BOX.rDist>EXTEND && BOX.rAng>EXT_ANG){
      BOX.rState='out';
    } else if(BOX.rState==='out' && BOX.rDist<RETRACT){
      BOX.rState='idle';
      if(ACTIVE) registerPunch('right',rW,rS,BOX.rAng);
      BOX.rLock=true;
      clearTimeout(BOX.rTimer);
      BOX.rTimer=setTimeout(()=>{BOX.rLock=false;},320);
    }
  }

  // head direction
  const nose=pose[0],lEar=pose[7],rEar=pose[8];
  if(lv(nose)&&lv(lEar)&&lv(rEar)){
    const mid=(lEar.x+rEar.x)/2, diff=nose.x-mid;
    BOX.headDir=Math.abs(diff)<0.042?'FORWARD':diff>0?'TURNED RIGHT':'TURNED LEFT';
  }
}

function registerPunch(side,wrist,shoulder,ang){
  let type='Hook';
  if(ang>150) type=(side==='left')?'Jab':'Cross';
  if(lv(wrist)&&lv(shoulder)&&wrist.y<shoulder.y-0.055) type='Uppercut';
  BOX.punches++; if(side==='left')BOX.left++;else BOX.right++;
  BOX[type==='Jab'?'jab':type==='Cross'?'cross':type==='Hook'?'hook':'upper']++;
  GAME.punches++; addXP(2);
  BOX.combo.push(side==='left'?'1':'2');
  if(BOX.combo.length>5)BOX.combo.shift();
  clearTimeout(BOX.comboTimer);
  BOX.comboTimer=setTimeout(()=>{BOX.combo=[];renderHUD();},2200);
  BOX.flash=type+' — '+side.toUpperCase();
  clearTimeout(BOX.flashTimer);
  BOX.flashTimer=setTimeout(()=>{BOX.flash='';renderHUD();},650);
  beep(side==='left'?195:255,'square',.07,.18);
  renderStats(); renderHUD();
  updateBadge('boxing',BOX.punches);
}

// ══════════════════════════════════════════
//  WORKOUT
// ══════════════════════════════════════════
const EXLIST = {
  squat:        {j:[23,25,27],dn:95, up:162,n:'Squat',        cal:.38},
  pushup:       {j:[11,13,15],dn:72, up:148,n:'Push-Up',       cal:.44},
  lunge:        {j:[23,25,27],dn:92, up:158,n:'Lunge',         cal:.34},
  highknee:     {j:[23,25,27],dn:78, up:148,n:'High Knee',     cal:.45},
  jumpingjack:  {j:[11,13,15],dn:155,up:58, n:'Jumping Jack',  cal:.52,inv:true},
  situp:        {j:[11,23,25],dn:158,up:58, n:'Sit-Up',        cal:.36,inv:true},
  shoulderpress:{j:[11,13,15],dn:72, up:162,n:'Shoulder Press',cal:.3},
  bicepscurl:   {j:[11,13,15],dn:42, up:148,n:'Bicep Curl',    cal:.22},
};

const WRK = {reps:0,ex:'squat',phase:'up',cal:0,angSmooth:0,inRep:false,lastRep:0,cooldown:750};

function processWorkout(pose){
  if(!pose)return;
  const ex=EXLIST[WRK.ex]; if(!ex)return;
  const [hi,ki,ai]=ex.j;
  const H=pose[hi],K=pose[ki],A=pose[ai];
  if(!lv(H)||!lv(K)||!lv(A))return;
  const raw=angleDeg(H,K,A);
  WRK.angSmooth=lerp(WRK.angSmooth,raw,.22);
  const now=Date.now();
  if(now-WRK.lastRep<WRK.cooldown)return;
  const DOWN=ex.inv?ex.up:ex.dn, UP=ex.inv?ex.dn:ex.up;
  if(WRK.phase==='up'&&WRK.angSmooth<DOWN){WRK.phase='down';WRK.inRep=true;}
  if(WRK.phase==='down'&&WRK.inRep&&WRK.angSmooth>UP){
    WRK.phase='up';WRK.inRep=false;WRK.reps++;WRK.lastRep=now;
    WRK.cal=Math.round(WRK.reps*ex.cal);
    GAME.reps++;addXP(3);
    beep(440,'sine',.1,.2);
    if(WRK.reps%5===0)say(WRK.reps+' reps! Keep going!');
    renderStats();updateBadge('workout',WRK.reps);
  }
}

// ══════════════════════════════════════════
//  SIGN LANGUAGE — Real finger analysis
// ══════════════════════════════════════════
function fingerExtended(hand){
  // Returns [thumb, index, middle, ring, pinky]
  if(!hand||hand.length<21)return null;
  const ext=[];
  // Thumb: tip vs MCP distance from wrist
  ext.push(dist2(hand[4],hand[0])>dist2(hand[3],hand[0]));
  // Fingers: tip y < pip y (higher on screen = extended)
  [[8,6],[12,10],[16,14],[20,18]].forEach(([tip,pip])=>{
    const T=hand[tip],P=hand[pip];
    ext.push(T&&P ? T.y<P.y-0.025 : false);
  });
  return ext;
}

function classifySign(ext){
  if(!ext)return null;
  const[T,I,M,R,P]=ext;
  const n=ext.filter(Boolean).length;
  // Precise ASL mappings
  if(!T&&!I&&!M&&!R&&!P)return{s:'A / Fist',c:92};
  if(!T&&I&&M&&R&&P)    return{s:'B',c:90};
  if(T&&I&&M&&R&&P)     return{s:'Hello / 5',c:93};
  if(!T&&I&&!M&&!R&&!P) return{s:'D / 1',c:91};
  if(!T&&I&&M&&!R&&!P)  return{s:'V / 2',c:89};
  if(!T&&I&&M&&R&&!P)   return{s:'3',c:87};
  if(T&&I&&!M&&!R&&!P)  return{s:'L',c:92};
  if(T&&!I&&!M&&!R&&P)  return{s:'Y',c:91};
  if(T&&I&&!M&&!R&&P)   return{s:'I Love You',c:94};
  if(!T&&!I&&!M&&!R&&P) return{s:'Pinky / I',c:88};
  if(T&&!I&&!M&&!R&&!P) return{s:'Good / Thumbs Up',c:90};
  if(!T&&I&&!M&&!R&&P)  return{s:'Spider-Man',c:85};
  if(n===0)              return{s:'Fist',c:90};
  if(n===5)              return{s:'Open Hand',c:92};
  return null;
}

const SGN = {det:'—',conf:0,sent:'',lastTime:0,cooldown:1600,holdCount:0,holdRequired:12,lastGesture:null};

function processSign(lh,rh){
  const hand=lh||rh;
  if(!hand){SGN.holdCount=0;SGN.lastGesture=null;return;}
  const ext=fingerExtended(hand);
  const result=classifySign(ext);
  if(!result){SGN.holdCount=0;return;}
  if(result.s===SGN.lastGesture){SGN.holdCount++;}
  else{SGN.lastGesture=result.s;SGN.holdCount=1;}
  if(SGN.holdCount>=4){SGN.det=result.s;SGN.conf=result.c;renderStats();}
  const now=Date.now();
  if(SGN.holdCount>=SGN.holdRequired&&now-SGN.lastTime>SGN.cooldown){
    SGN.lastTime=now;SGN.holdCount=0;
    SGN.sent=(SGN.sent+' '+result.s).trim().split(' ').slice(-8).join(' ');
    GAME.signs++;addXP(5);
    say(result.s);beep(520,'sine',.1,.2);
    renderStats();
  }
}

// ══════════════════════════════════════════
//  ROCK PAPER SCISSORS
// ══════════════════════════════════════════
const RPS_EMOJIS = {rock:'✊',paper:'🖐',scissors:'✌️'};
const RPS_CHOICES = ['rock','paper','scissors'];
function rpsWinner(p,a){
  if(p===a)return'tie';
  if((p==='rock'&&a==='scissors')||(p==='scissors'&&a==='paper')||(p==='paper'&&a==='rock'))return'win';
  return'lose';
}
function rpsClassify(ext){
  if(!ext)return null;
  const[T,I,M,R,P]=ext;
  const n=ext.filter(Boolean).length;
  if(n<=1&&!I&&!M)return'rock';       // fist
  if(n>=4)        return'paper';      // open hand
  if(!T&&I&&M&&!R&&!P)return'scissors';// peace
  return null;
}

const RPS = {
  playerScore:0,aiScore:0,ties:0,
  history:[],
  state:'idle',  // idle | countdown | reveal | result
  countdown:0,
  playerMove:null,aiMove:null,
  result:null,
  liveGesture:null,
  liveHold:0,
  lastFrame:null,
};

let rpsCountdownTimer=null;

function startRPSRound(){
  if(RPS.state!=='idle')return;
  RPS.state='countdown';
  RPS.countdown=3;
  RPS.playerMove=null;RPS.aiMove=null;RPS.result=null;
  beep(660,'sine',.12,.25);
  say('Ready... go!',true);
  renderHUD();

  // capture player gesture at moment of reveal
  let tick=3;
  rpsCountdownTimer=setInterval(()=>{
    tick--;
    RPS.countdown=tick;
    if(tick>0){
      beep(440,'sine',.1,.2);
      renderHUD();
    } else {
      clearInterval(rpsCountdownTimer);
      revealRPS();
    }
  },1000);
}

function revealRPS(){
  RPS.state='reveal';
  // use last stable gesture
  RPS.playerMove = RPS.liveGesture || 'rock';
  RPS.aiMove     = RPS_CHOICES[Math.floor(Math.random()*3)];
  RPS.result     = rpsWinner(RPS.playerMove, RPS.aiMove);

  if(RPS.result==='win'){RPS.playerScore++;GAME.wins++;addXP(10);chime([[660,.1],[880,.15],[1100,.18]]);say('You win! Nice move!',true);}
  else if(RPS.result==='lose'){RPS.aiScore++;GAME.losses++;addXP(2);beep(220,'sawtooth',.2,.2);say('AI wins this round.',true);}
  else{RPS.ties++;GAME.ties++;addXP(4);beep(440,'sine',.15,.15);say('Tie! Try again.',true);}

  RPS.history.unshift({player:RPS.playerMove,ai:RPS.aiMove,result:RPS.result});
  if(RPS.history.length>8)RPS.history.pop();
  saveGame();
  renderStats();renderHUD();

  setTimeout(()=>{RPS.state='idle';renderHUD();renderStats();},2500);
}

function processRPS(lh,rh){
  const hand=lh||rh;
  if(!hand){RPS.liveGesture=null;RPS.liveHold=0;return;}
  const ext=fingerExtended(hand);
  const g=rpsClassify(ext);
  if(g===RPS.lastFrame){RPS.liveHold++;}
  else{RPS.lastFrame=g;RPS.liveHold=1;}
  if(RPS.liveHold>=5&&g){RPS.liveGesture=g;}
  renderHUD();
}

// ══════════════════════════════════════════
//  RENDER STATS
// ══════════════════════════════════════════
const TIPS={
  explore:'All 33 body landmarks are tracked live. Switch modes on the left to activate AI analysis.',
  boxing:'Fully extend your arm then pull it back — each complete punch motion counts. Jab=left, Cross=right.',
  workout:'Stand fully in frame. Go through the complete range of motion for accurate rep counting.',
  sign:'Hold each hand sign steady. The AI confirms after seeing it consistently for half a second.',
  rps:'Show Rock, Paper, or Scissors clearly, then press Start Round. The AI plays fair — completely random.',
};

function renderStats(){
  let h='';
  if(MODE==='explore'){
    h=`
      <div class="rpl">Live tracking</div>
      <div class="rpc"><div class="rpn g">33</div><div class="rps2">Body landmarks</div></div>
      <div class="rpc"><div class="rpn b">42</div><div class="rps2">Hand landmarks (both)</div></div>
      <div class="rpc"><div class="rpn pu">478</div><div class="rps2">Face points (enable in ⚙)</div></div>
      <div class="ccard"><div class="ctit">Welcome</div><div class="cbod">${TIPS.explore}</div></div>`;
  }
  else if(MODE==='boxing'){
    const b=BOX,mx=Math.max(b.jab,b.cross,b.hook,b.upper,1);
    h=`
      <div class="rpl">Punches</div>
      <div class="rpc"><div class="rpn r">${b.punches}</div><div class="rps2">L: ${b.left} &nbsp;|&nbsp; R: ${b.right}</div></div>
      <div class="rpl">Breakdown</div>
      <div class="rpc">
        <div class="prow"><span class="pnm">Jab</span><div class="ptrk"><div class="pfill" style="width:${(b.jab/mx)*100}%;background:#4da6ff"></div></div><span class="pct">${b.jab}</span></div>
        <div class="prow"><span class="pnm">Cross</span><div class="ptrk"><div class="pfill" style="width:${(b.cross/mx)*100}%;background:#ff3e6c"></div></div><span class="pct">${b.cross}</span></div>
        <div class="prow"><span class="pnm">Hook</span><div class="ptrk"><div class="pfill" style="width:${(b.hook/mx)*100}%;background:#ffb800"></div></div><span class="pct">${b.hook}</span></div>
        <div class="prow"><span class="pnm">Uppercut</span><div class="ptrk"><div class="pfill" style="width:${(b.upper/mx)*100}%;background:#a855f7"></div></div><span class="pct">${b.upper}</span></div>
      </div>
      <div class="rpl">Head</div>
      <div class="rpc"><div class="rpn b" style="font-size:14px">${b.headDir}</div></div>
      <div class="ccard"><div class="ctit">Coach tip</div><div class="cbod">${TIPS.boxing}</div></div>`;
  }
  else if(MODE==='workout'){
    const w=WRK,ex=EXLIST[w.ex];
    h=`
      <div class="rpl">Exercise</div>
      <div class="rpc"><div class="rpn a" style="font-size:16px">${ex?ex.n:'—'}</div><div class="rps2">Phase: ${w.phase.toUpperCase()} | Angle: ${Math.round(w.angSmooth)}°</div></div>
      <div class="rpl">Reps</div>
      <div class="rpc"><div class="rpn g">${w.reps}</div></div>
      <div class="rpl">Calories</div>
      <div class="rpc"><div class="rpn r">${w.cal}</div><div class="rps2">kcal estimated</div></div>
      <div class="rpl">Exercises</div>
      <div class="ex-grid">
        ${Object.entries(EXLIST).map(([k,v])=>`<div class="ec${w.ex===k?' on':''}" data-ex="${k}">${v.n}</div>`).join('')}
      </div>
      <div class="ccard"><div class="ctit">Tip</div><div class="cbod">${TIPS.workout}</div></div>`;
  }
  else if(MODE==='sign'){
    h=`
      <div class="rpl">Detected sign</div>
      <div class="rpc" style="text-align:center;padding:14px">
        <div class="sign-big">${SGN.det}</div>
        <div class="sign-conf">${SGN.det!=='—'?SGN.conf+'% confidence':'Show a hand sign'}</div>
      </div>
      <div class="rpl">Sentence</div>
      <div class="rpc"><div class="sign-sent">${SGN.sent||'Hold a sign to build a sentence...'}</div></div>
      <div class="rpc"><button style="width:100%;padding:7px;background:rgba(255,110,180,.1);border:1px solid rgba(255,110,180,.28);color:#ff6eb4;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600" id="btn-clear">Clear sentence</button></div>
      <div class="ccard"><div class="ctit">How it works</div><div class="cbod">${TIPS.sign}</div></div>`;
  }
  else if(MODE==='rps'){
    const r=RPS;
    h=`
      <div class="rpl">Score</div>
      <div class="rpc">
        <div class="rps-score">
          <div><div class="rps-score-num" style="color:var(--green)">${r.playerScore}</div><div class="rps-score-lbl">You</div></div>
          <div class="rps-vs">VS</div>
          <div><div class="rps-score-num" style="color:var(--red)">${r.aiScore}</div><div class="rps-score-lbl">AI</div></div>
        </div>
        <div style="text-align:center;margin-top:6px;font-size:10px;color:var(--dim)">Ties: ${r.ties}</div>
      </div>
      ${r.playerMove&&r.aiMove?`
      <div class="rpl">Last round</div>
      <div class="rpc">
        <div class="rps-ai-choice">
          <div style="display:flex;justify-content:space-around;align-items:center">
            <div style="text-align:center"><div class="rps-emoji">${RPS_EMOJIS[r.playerMove]||'?'}</div><div class="rps-choice-lbl">You: ${r.playerMove}</div></div>
            <div style="font-family:var(--fm);font-size:11px;color:var(--dim)">VS</div>
            <div style="text-align:center"><div class="rps-emoji">${RPS_EMOJIS[r.aiMove]||'?'}</div><div class="rps-choice-lbl">AI: ${r.aiMove}</div></div>
          </div>
        </div>
      </div>`:''
      }
      ${r.history.length?`
      <div class="rpl">History</div>
      <div class="rpc">
        <div class="rps-history">
          ${r.history.map(row=>`
            <div class="rps-hist-row">
              <span>${RPS_EMOJIS[row.player]} vs ${RPS_EMOJIS[row.ai]}</span>
              <span class="rps-hist-result ${row.result==='win'?'w':row.result==='lose'?'l':'t'}">${row.result.toUpperCase()}</span>
            </div>`).join('')}
        </div>
      </div>`:''}
      <button class="rps-start-btn" id="rps-start" ${r.state!=='idle'?'disabled':''}>
        ${r.state==='idle'?'▶  Start Round':r.state==='countdown'?'Get Ready...':'Revealing...'}
      </button>
      <div class="ccard"><div class="ctit">How to play</div><div class="cbod">${TIPS.rps}</div></div>`;
  }

  rpanel.innerHTML=h;

  // exercise chips
  document.querySelectorAll('.ec').forEach(el=>{
    el.addEventListener('click',()=>{
      WRK.ex=el.dataset.ex;WRK.reps=0;WRK.phase='up';WRK.cal=0;WRK.inRep=false;WRK.angSmooth=0;
      updateBadge('workout',0);renderStats();
    });
  });
  // clear sign
  const clr=document.getElementById('btn-clear');
  if(clr)clr.addEventListener('click',()=>{SGN.sent='';SGN.det='—';renderStats();});
  // RPS start
  const rpsS=document.getElementById('rps-start');
  if(rpsS)rpsS.addEventListener('click',()=>{if(RPS.state==='idle')startRPSRound();});
}

// ══════════════════════════════════════════
//  RENDER HUD
// ══════════════════════════════════════════
function renderHUD(){
  let h='';
  if(MODE==='boxing'&&ACTIVE){
    const b=BOX;
    h+=`<div class="hbox tr"><div class="hnum" style="color:#ff3e6c">${b.punches}</div><div class="hlbl">Punches</div></div>`;
    h+=`<div class="hbox tl"><div class="hlbl">Head</div><div style="font-family:var(--fm);font-size:12px;color:#00ff88;margin-top:3px">${b.headDir}</div></div>`;
    if(b.flash)h+=`<div class="punch-flash">${b.flash}</div>`;
    if(b.combo.length>=2)h+=`<div class="combo-tag">COMBO: ${b.combo.join('-')}</div>`;
  }
  if(MODE==='workout'&&ACTIVE){
    const w=WRK,ex=EXLIST[w.ex];
    h+=`<div class="hbox tr"><div class="hnum" style="color:#ffb800">${w.reps}</div><div class="hlbl">${ex?ex.n:'Reps'}</div><div class="hsub">${w.phase==='down'?'↑ Come up!':'↓ Go down!'}</div></div>`;
  }
  if(MODE==='sign'){
    const live=SGN.holdCount>=4&&SGN.det!=='—';
    if(live)h+=`<div class="hbox tl"><div class="hlbl">Detecting</div><div style="font-family:var(--fm);font-size:18px;color:#ff6eb4;margin-top:3px">${SGN.det}</div></div>`;
  }
  if(MODE==='rps'){
    // show live hand gesture
    const liveGStr=RPS.liveGesture?RPS_EMOJIS[RPS.liveGesture]||'?':'—';
    h+=`<div class="rps-hand-detect">${liveGStr} ${RPS.liveGesture||'Show your hand'}</div>`;

    if(RPS.state==='countdown'&&RPS.countdown>0){
      h+=`<div class="rps-hud"><div class="rps-countdown">${RPS.countdown}</div></div>`;
    }
    if(RPS.state==='reveal'||RPS.state==='result'){
      const res=RPS.result;
      const txt=res==='win'?'🎉 YOU WIN!':res==='lose'?'🤖 AI WINS':'🤝 TIE!';
      h+=`<div class="rps-hud"><div class="rps-result ${res}">${txt}</div></div>`;
    }
  }
  hudEl.innerHTML=h;
}

// ══════════════════════════════════════════
//  SESSION
// ══════════════════════════════════════════
function toggleSession(){
  ACTIVE=!ACTIVE;
  if(ACTIVE){
    GAME.sessions++;saveGame();
    if(MODE==='boxing'){BOX.punches=BOX.left=BOX.right=BOX.jab=BOX.cross=BOX.hook=BOX.upper=0;BOX.combo=[];BOX.flash='';BOX.lState='idle';BOX.rState='idle';}
    if(MODE==='workout'){WRK.reps=0;WRK.cal=0;WRK.phase='up';WRK.inRep=false;WRK.angSmooth=0;}
    if(MODE==='sign'){SGN.sent='';SGN.det='—';SGN.holdCount=0;}
    if(MODE==='rps'){RPS.playerScore=0;RPS.aiScore=0;RPS.ties=0;RPS.history=[];RPS.state='idle';}
    updateBadge('boxing',0);updateBadge('workout',0);
    chime([[440,.1],[660,.12]]);
    say('Session started. Let\'s go!',true);
  } else {
    chime([[660,.12],[440,.15]]);
    say('Session ended. Great work!',true);
  }
  sessBtn.textContent=ACTIVE?'■  Stop Session':'▶  Start Session';
  sessBtn.className='sess-btn'+(ACTIVE?' stop':'');
  renderStats();renderHUD();
}
sessBtn.addEventListener('click',toggleSession);

// ══════════════════════════════════════════
//  MODE SWITCH
// ══════════════════════════════════════════
const MNAMES={explore:'FREE EXPLORE',boxing:'BOXING TRAINER',workout:'WORKOUT',sign:'SIGN LANGUAGE',rps:'ROCK PAPER SCISSORS'};
function setMode(m){
  MODE=m;ACTIVE=false;
  sessBtn.textContent='▶  Start Session';sessBtn.className='sess-btn';
  modeLabel.textContent=MNAMES[m]||m.toUpperCase();
  document.querySelectorAll('.nb').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  // corner color
  const cc=CORNER_COLORS[m]||'#00ff88';
  document.querySelectorAll('.corner').forEach(el=>{el.style.borderColor=cc;el.style.opacity='.5';});
  // hide session btn for RPS (uses its own button)
  sessBtn.style.display=m==='rps'?'none':'block';
  renderStats();renderHUD();
}
document.querySelectorAll('.nb').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));

function updateBadge(mode,val){
  const el=document.getElementById('bd-'+mode);
  if(!el)return;
  el.textContent=val;
  el.classList.toggle('hidden',val<=0);
}

// ══════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════
document.getElementById('btn-settings').addEventListener('click',()=>document.getElementById('sov').classList.toggle('hidden'));
document.getElementById('btn-cls-set').addEventListener('click',()=>document.getElementById('sov').classList.add('hidden'));
document.getElementById('sov').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.classList.add('hidden');});
document.getElementById('cfg-skel').addEventListener('change', e=>CFG.skeleton=e.target.checked);
document.getElementById('cfg-dots').addEventListener('change', e=>CFG.dots=e.target.checked);
document.getElementById('cfg-glow').addEventListener('change', e=>CFG.glow=e.target.checked);
document.getElementById('cfg-face').addEventListener('change', e=>CFG.face=e.target.checked);
document.getElementById('cfg-sound').addEventListener('change',e=>CFG.sound=e.target.checked);
document.getElementById('cfg-voice').addEventListener('change',e=>CFG.voice=e.target.checked);
document.getElementById('cfg-male').addEventListener('change', ()=>{CFG.voiceGender='male';});
document.getElementById('cfg-female').addEventListener('change',()=>{CFG.voiceGender='female';});
document.getElementById('cfg-real').addEventListener('change', ()=>applyViewMode('real'));
document.getElementById('cfg-avatar').addEventListener('change',()=>applyViewMode('avatar'));
document.getElementById('btn-reset').addEventListener('click',()=>{
  if(confirm('Reset all progress?')){
    GAME={xp:0,punches:0,reps:0,signs:0,wins:0,losses:0,ties:0,sessions:0};
    saveGame();updateXPUI();
  }
});
function applyViewMode(vm){CFG.viewMode=vm;video.classList.toggle('av',vm==='avatar');}

// ══════════════════════════════════════════
//  MEDIAPIPE RESULTS
// ══════════════════════════════════════════
function onResults(results){
  if(!MODEL_READY)MODEL_READY=true;
  tickFPS();
  resizeCanvas();
  CTX.clearRect(0,0,canvas.width,canvas.height);

  const pose=results.poseLandmarks;
  const lh=results.leftHandLandmarks;
  const rh=results.rightHandLandmarks;
  const face=results.faceLandmarks;

  // tracking display
  const hc=(lh?lh.length:0)+(rh?rh.length:0);
  const tot=(pose?pose.length:0)+hc;
  tmBody.textContent=pose?pose.length+' pts':'—'; tmBody.className='tv'+(pose?' on':'');
  tmHands.textContent=hc?hc+' pts':'—';          tmHands.className='tv'+(hc?' on':'');
  tmTotal.textContent=tot||'—';
  lmlblEl.textContent=tot+' landmarks tracked';

  drawSkeleton(pose,lh,rh);
  drawFace(face);

  switch(MODE){
    case 'boxing':  processBoxing(pose);  break;
    case 'workout': processWorkout(pose); break;
    case 'sign':    processSign(lh,rh);   break;
    case 'rps':     processRPS(lh,rh);    break;
  }
}

// ══════════════════════════════════════════
//  LOADING PROGRESS UI
// ══════════════════════════════════════════
function setLoad(pct,msg){
  const f=document.getElementById('sload-fill'),m=document.getElementById('sload-msg');
  if(f)f.style.width=pct+'%';
  if(m)m.textContent=msg;
}

// ══════════════════════════════════════════
//  SPLASH LOGIC
// ══════════════════════════════════════════
let _voiceChoice='male';

// Voice buttons
document.getElementById('vp-male').addEventListener('click',()=>{
  _voiceChoice='male';
  document.getElementById('vp-male').classList.add('active');
  document.getElementById('vp-female').classList.remove('active');
  CFG.voiceGender='male';
});
document.getElementById('vp-female').addEventListener('click',()=>{
  _voiceChoice='female';
  document.getElementById('vp-female').classList.add('active');
  document.getElementById('vp-male').classList.remove('active');
  CFG.voiceGender='female';
});

// View choice buttons
document.querySelectorAll('.vc').forEach(el=>{
  el.addEventListener('click',()=>{
    document.querySelectorAll('.vc').forEach(x=>x.classList.remove('active'));
    el.classList.add('active');
    CFG.viewMode=el.dataset.view;
  });
});

// Camera request function
async function requestCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'},
      audio:false,
    });
    video.srcObject = stream;
    document.getElementById('s1').classList.remove('active');
    document.getElementById('s2').classList.add('active');
  } catch(err) {
    console.error('Camera error:',err);
    document.getElementById('cam-err').classList.remove('hidden');
  }
}

// Button click also triggers camera
document.getElementById('btn-cam').addEventListener('click', requestCamera);

// Auto-request camera when page loads (triggers browser popup automatically)
setTimeout(requestCamera, 600);

// Enter app
document.getElementById('btn-enter').addEventListener('click',()=>{
  document.getElementById('s2').classList.remove('active');
  document.getElementById('sload').classList.remove('hidden');
  applyViewMode(CFG.viewMode);
  initHolistic();
});

// ══════════════════════════════════════════
//  MEDIAPIPE INIT
// ══════════════════════════════════════════
function initHolistic(){
  setLoad(15,'Loading pose model...');

  const holistic=new Holistic({
    locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${f}`
  });

  holistic.setOptions({
    modelComplexity:1,
    smoothLandmarks:true,
    enableSegmentation:false,
    refineFaceLandmarks:true,
    minDetectionConfidence:0.55,
    minTrackingConfidence:0.55,
  });

  setLoad(40,'Initializing AI models...');
  holistic.onResults(onResults);
  setLoad(65,'Starting body tracking...');

  // Start camera feed through MediaPipe
  const startTracking=()=>{
    setLoad(80,'Warming up...');
    const cam=new Camera(video,{
      onFrame:async()=>{await holistic.send({image:video});},
      width:1280,height:720,
    });
    cam.start();
    setLoad(92,'Almost ready...');

    // Wait for first frame then launch
    let frames=0;
    const checkReady=setInterval(()=>{
      frames++;
      if(MODEL_READY||frames>25){
        clearInterval(checkReady);
        launchApp();
      }
    },200);
  };

  if(video.readyState>=2){
    startTracking();
  } else {
    video.onloadedmetadata=()=>{video.play().then(startTracking).catch(startTracking);};
  }
}

function launchApp(){
  setLoad(100,'Ready!');
  sdot.classList.add('on');
  stxt.textContent='Camera on';
  setTimeout(()=>{
    const splash=document.getElementById('splash');
    splash.classList.add('out');
    document.getElementById('app').classList.remove('hidden');
    setTimeout(()=>splash.remove(),800);
    // Welcome message
    setTimeout(()=>say('Welcome to PoseAI. Select a mode to begin.',true),600);
  },300);
  setMode('explore');
  updateXPUI();
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
renderStats();
updateXPUI();
