/**
 * game.js - Neon Drift 主入口
 * 陀螺仪控制发光光球漂移，收集晶体，躲避暗礁
 */

'use strict';

// LittleJS CDN
// Load littlejs.js before this file

// ============ 游戏配置 ============
const CONFIG = {
  tileSize: 1,
  ballRadius: 0.25,
  ballSpeed: 8,             // 格/秒
  maxParticles: 2000,
  trailInterval: 0.05,      // 优化：从0.03降至0.05，减少尾迹粒子生成
  glowInterval: 0.05,        // 优化：从0.02降至0.05，减少外晕粒子生成
  // 移动端自适应配置
  mobileTrailInterval: 0.1,  // 移动端更高间隔（从0.08调至0.1）
  mobileGlowInterval: 0.1,
  // 视口剔除边距
  cullMargin: 3,
  // 粒子预算追踪
  particleBudget: 1500,      // 优化：实际预算低于配置上限，留余量
  particleBudgetMobile: 700, // 移动端更激进的粒子预算
  // 低功率模式阈值（连续低FPS次数）
  lowPowerThreshold: 3,
  lowPowerEnterFps: 30,      // 进入低功率模式的平均FPS阈值
  lowPowerRecoverFps: 40,    // 恢复正常模式的平均FPS阈值（从45降至40，更易恢复）
  lowPowerTrailInterval: 0.18, // 低功率模式更激进的降频（从0.1调至0.18）
  lowPowerGlowInterval: 0.18,
  // 冲击波冷却时间
  shockwaveCooldown: 3,
  shockwaveRadius: 2.5,
  // 相机
  cameraScaleMobile: 30,     // 移动端缩放（从20提升，让视口剔除生效、视角更聚焦）
  cameraScaleDesktop: 24,
  cameraLerp: 0.15,          // 相机平滑跟随系数（0=不动，1=硬锁）
};

// ============ 游戏状态 ============
let gameState = 'splash'; // splash | calibrate | play | levelcomplete | win | gameover
let currentLevelIndex = 0;
const LEVELS = [LEVEL_1, LEVEL_2, LEVEL_3];
let lives = 3;
let sensor = null;
let _joystickActive = false;   // 是否正在触摸摇杆区域
let _joystickOrigin = vec2(0, 0);  // 摇杆中心（屏幕坐标）
let _joystickVec = vec2(0, 0);     // 归一化摇杆方向 [-1, 1]
let _joystickRadius = 60;     // 摇杆最大半径（像素）
let keyboardInput = vec2(0, 0);
let levelStarted = 0;
let finishTime = 0;
let levelBest = 0;
let newRecord = false;
let rechargeNoticeUntil = 0;
let joystickTouchId = null;
let waveOrigin = null;
let waveStarted = 0;
const pulseButton = document.getElementById('pulse-btn');
let playerBall = null;
let crystals = [];
let hazards = [];
let exitDoor = null;
let totalCrystals = 0;
let collectedCrystals = 0;
let trailTimer = 0;
let glowTimer = 0;
let levelData = LEVELS[0];
let mazeLayer = null;
let breathePhase = 0;
let backgroundSpawned = false;
// 性能追踪
let lowPowerMode = false;
let lowPowerConsecutive = 0;
// 是否显示性能浮层（?fps=1 或 hash 含 fps）
const _showPerf = new URLSearchParams(location.search).has('fps') || location.hash.toLowerCase().includes('fps');
// 冲击波冷却计时
let shockwaveCooldownTimer = 0;

// ============ 工具函数 ============
/** FPS 监控与低功率模式检测
 *  注意：LittleJS 用固定时间步长(timeDelta=1/frameRate 恒定)，不能用 1/timeDelta
 *  衡量真实帧率（永远=60）。改用引擎的 averageFPS（基于真实 rAF 间隔平滑）。 */
function updateFPSMonitor() {
  const avgFps = averageFPS || 0;
  if (avgFps > 0 && avgFps < (CONFIG.lowPowerEnterFps || 30) && gameState === 'play') {
    lowPowerConsecutive++;
    if (lowPowerConsecutive >= CONFIG.lowPowerThreshold && !lowPowerMode) {
      lowPowerMode = true;
    }
  } else {
    lowPowerConsecutive = 0;
    if (lowPowerMode && avgFps > (CONFIG.lowPowerRecoverFps || 45)) {
      lowPowerMode = false;
    }
  }
}

/** 获取当前生效的粒子发射间隔（自适应） */
function getCurrentTrailInterval() {
  if (lowPowerMode) return CONFIG.lowPowerTrailInterval;
  if (isMobile()) return CONFIG.mobileTrailInterval;
  return CONFIG.trailInterval;
}

function getCurrentGlowInterval() {
  if (lowPowerMode) return CONFIG.lowPowerGlowInterval;
  if (isMobile()) return CONFIG.mobileGlowInterval;
  return CONFIG.glowInterval;
}

/** 视口剔除：检查世界坐标是否在相机视野范围内 */
function isInView(worldPos, margin) {
  const cam = cameraPos;
  const size = getCameraSize().scale(0.5);
  const m = margin !== undefined ? margin : CONFIG.cullMargin;
  return (
    worldPos.x > cam.x - size.x - m &&
    worldPos.x < cam.x + size.x + m &&
    worldPos.y > cam.y - size.y - m &&
    worldPos.y < cam.y + size.y + m
  );
}
function tileToWorld(tileX, tileY) {
  return vec2(tileX + 0.5, tileY + 0.5);
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ============ 音效 ============
// 晶体收集音效（清脆的叮铃声）
const sfxCollect = new Sound([1,.05,537,.02,.12,.14,0,1.5,0,0,200,.06,.03]);
// 暗礁碰撞音效（低沉的爆炸声）
const sfxHit = new Sound([1.5,.05,270,.01,.01,.34,4,0,0,0,0,0,0,0,0,.1,.1,.5,.04]);
// 背景音乐（zzfxM 生成的简约电子循环）
let bgmPlaying = null;
const bgmData = zzfxM(
  // instruments
  [[,0,77,,,.5,2,,,,,,,,,.05,.5],[,0,440,.04,.2,.3,1,,,,,,,,,.1,,.5,.1],[.5,0,220,,,.7,2,,,,,,,,,.02,.2]],
  // patterns
  [
    // pattern 0 - bass + lead
    [[1,0,24,,28,,24,,28,,31,,28,,24,,28,,24,,28,,31,,28,,24,,28,,24,,28,,],[2,0,36,,,,36,,,,38,,,,36,,,,36,,,,36,,,,38,,,,36,,,,],[0,.1,24,,28,,31,,28,,24,,28,,31,,33,,24,,28,,31,,28,,24,,28,,31,,33,,]],
    // pattern 1 - variation
    [[1,0,28,,31,,28,,24,,28,,31,,33,,28,,31,,28,,24,,28,,31,,33,,28,,31,,],[2,0,38,,,,38,,,,36,,,,38,,,,38,,,,38,,,,36,,,,38,,,,],[0,.1,28,,31,,33,,31,,28,,31,,33,,36,,28,,31,,33,,31,,28,,31,,33,,36,,]],
  ],
  // sequence
  [0,0,1,0,1,1,0,1],
  // BPM
  100
);

function startBGM() {
  if (bgmPlaying) return;
  bgmPlaying = playSamples(bgmData, .15, 1, 0, true);
  // playSamples 在 audioContext 未激活时返回 undefined，需在 gameUpdate 中重试
  if (!bgmPlaying) bgmPlaying = null;
}

// ============ 游戏对象 ============

/** 玩家光球 */
class Ball extends EngineObject {
  constructor(pos) {
    super(pos, vec2(CONFIG.ballRadius * 2));
    this.radius = CONFIG.ballRadius;
    this.velocity = vec2(0, 0);
    this.speed = CONFIG.ballSpeed;
  }

  update() {
    // LittleJS 自动调用此方法，仅在 play 状态执行游戏逻辑
    if (gameState !== 'play') return;

    // 手指拖动时接管倾斜输入，传感器断流也能继续操控。
    let sensorVec = vec2(0, 0);
    if (_joystickActive) {
      sensorVec = vec2(_joystickVec.x, -_joystickVec.y);
    } else if (sensor && sensor.enabled && !sensor.isStale(time)) {
      sensorVec = sensor.getTiltVector();
    }
    const input = keyboardInput.add(sensorVec).clampLength(1);
    // 每个固定步向目标速度靠近，松手保留短暂滑行，反向时能及时转弯。
    const target = input.scale(this.speed);
    const grip = input.lengthSquared() ? 0.22 : 0.17;
    this.velocity.x = lerp(this.velocity.x, target.x, grip);
    this.velocity.y = lerp(this.velocity.y, target.y, grip);
    this._moveAxis('x');
    this._moveAxis('y');

    // 晶体收集
    for (let i = crystals.length - 1; i >= 0; i--) {
      if (distance(this.pos, crystals[i].pos) < this.radius + 0.3) {
        emitCollect(crystals[i].pos);
        crystals[i].destroy();
        crystals.splice(i, 1);
        collectedCrystals++;
        if (shockwaveCooldownTimer > 0) {
          shockwaveCooldownTimer = 0;
          rechargeNoticeUntil = time + 1;
        }
        sfxCollect.play();
      }
    }

    // 暗礁触碰
    for (let i = hazards.length - 1; i >= 0; i--) {
      if (distance(this.pos, hazards[i].pos) < this.radius + 0.35) {
        emitExplode(this.pos);
        hazards[i].destroy();
        hazards.splice(i, 1);
        lives--;
        sfxHit.play();
        if (lives <= 0) {
          gameState = 'gameover';
          return;
        }
      }
    }

    // 终点检测
    if (exitDoor && distance(this.pos, exitDoor.pos) < this.radius + 0.4) {
      if (collectedCrystals >= totalCrystals) {
        finishLevel();
        if (currentLevelIndex < LEVELS.length - 1) {
          gameState = 'levelcomplete';
        } else {
          gameState = 'win';
        }
      }
    }

    // 粒子效果（自适应间隔：低功率/移动端自动降频）
    trailTimer += timeDelta;
    glowTimer += timeDelta;
    const trailInterval = getCurrentTrailInterval();
    const glowInterval = getCurrentGlowInterval();
    if (trailTimer >= trailInterval) {
      trailTimer = 0;
      emitTrail(this.pos);
    }
    if (glowTimer >= glowInterval) {
      glowTimer = 0;
      emitGlow(this.pos);
    }

    // 背景星尘（只在屏幕范围外时补充）
    if (!backgroundSpawned) {
      const viewSize = getCameraSize();
      spawnBackgroundDust(cameraPos, viewSize);
      backgroundSpawned = true;
    }
  }

  /** Ball 自行管理物理（碰撞、阻尼、位移），跳过引擎默认的 updatePhysics
   *  防止 LittleJS 在 update() 之后再次将 velocity 叠加到 pos（双重位移） */
  updatePhysics() {}

  render() {
    const diameter = this.radius * 2;
    drawCircle(this.pos, diameter + 0.12 + 0.04 * Math.sin(breathePhase), rgb(0, .8, 1, .35));
    drawCircle(this.pos, diameter, rgb(.4, 1, 1));
  }

  _moveAxis(axis) {
    const speed = this.velocity[axis];
    const step = speed * timeDelta;
    const start = this.pos[axis];
    this.pos[axis] = start + step;
    if (!this._overlapsWall()) return;

    // 在这一帧的安全起点与碰撞点之间找接触面，保留沿墙的切向速度。
    let safe = 0, blocked = 1;
    for (let i = 0; i < 5; i++) {
      const mid = (safe + blocked) / 2;
      this.pos[axis] = start + step * mid;
      if (this._overlapsWall()) blocked = mid;
      else safe = mid;
    }
    this.pos[axis] = start + step * safe;
    this.velocity[axis] = 0;
    if (Math.abs(speed) > 3) {
      const normal = vec2();
      normal[axis] = -Math.sign(speed);
      emitSparks(this.pos, normal);
    }
  }

  _overlapsWall() {
    const {x, y} = this.pos;
    const r = this.radius;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (levelData.map[ty]?.[tx] && levelData.map[ty][tx] !== '1') continue;
        const dx = x - clamp(x, tx, tx + 1);
        const dy = y - clamp(y, ty, ty + 1);
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }
}

/** 晶体对象 */
class Crystal extends EngineObject {
  constructor(pos) {
    super(pos, vec2(0.4));
    this.mass = 0; // 静态对象，跳过引擎物理
    this.angle = 0;
  }
  update() {
    this.angle += timeDelta * 2;
    // 上下浮动
    this.pos.y += Math.sin(time * 3 + this.pos.x) * 0.002;
  }
  render() {
    // 菱形晶体
    drawRect(this.pos, vec2(.38), rgb(1, .9, 0), this.angle);
    drawRect(this.pos, vec2(0.15), rgb(1, 1, 1), this.angle);
  }
}

/** 暗礁对象 */
class Hazard extends EngineObject {
  constructor(pos) {
    super(pos, vec2(0.7));
    this.mass = 0; // 静态对象
    this.pulse = rand(PI * 2);
  }
  update() {
    this.pulse += timeDelta * 4;
  }
  render() {
    const p = 0.5 + 0.5 * Math.sin(this.pulse);
    drawRect(this.pos, vec2(.48 + .06 * p), rgb(1, .15, .3), PI / 4);
    drawRect(this.pos, vec2(.16), rgb(.26, .02, .1), PI / 4);
  }
}

/** 终点光门 */
class ExitDoor extends EngineObject {
  constructor(pos) {
    super(pos, vec2(1));
    this.mass = 0; // 静态对象
  }
  update() {
    this.angle += timeDelta * 1.5;
  }
  render() {
    if (collectedCrystals < totalCrystals) {
      drawRect(this.pos, vec2(.55), rgb(.22, .32, .38), this.angle);
      return;
    }
    // 旋转光门
    drawRect(this.pos, vec2(0.6), rgb(0.3, 1, 0.3, 0.6), this.angle);
    drawRect(this.pos, vec2(0.3), rgb(0.5, 1, 0.5), 0);
  }
}

// ============ 关卡加载 ============
function loadLevel(index) {
  currentLevelIndex = index;
  levelData = LEVELS[index];
  // 销毁旧对象（从 LittleJS 引擎列表中移除，防止内存泄漏和双重更新）
  if (playerBall) { playerBall.destroy(); playerBall = null; }
  for (const c of crystals) c.destroy();
  for (const h of hazards) h.destroy();
  if (exitDoor) { exitDoor.destroy(); exitDoor = null; }
  crystals = [];
  hazards = [];
  collectedCrystals = 0;
  totalCrystals = 0;
  backgroundSpawned = false;
  mazeLayer?.destroy();
  mazeLayer = buildMazeLayer(levelData);
  levelStarted = time;
  rechargeNoticeUntil = 0;
  waveOrigin = null;
  shockwaveCooldownTimer = 0;
  _joystickActive = false;
  _joystickVec = vec2();
  joystickTouchId = null;
  levelBest = 0;
  try {
    const saved = Number(localStorage.getItem('neon-drift.best.' + index));
    if (Number.isFinite(saved) && saved > 0) levelBest = saved;
  } catch { /* 私密浏览仍可正常计时 */ }

  // 遍历地图
  for (let y = 0; y < levelData.height; y++) {
    for (let x = 0; x < levelData.width; x++) {
      const tile = levelData.map[y][x];
      const worldPos = tileToWorld(x, y);
      switch (tile) {
        case '5':
          playerBall = new Ball(worldPos);
          cameraPos = worldPos.copy();
          break;
        case '2':
          crystals.push(new Crystal(worldPos));
          totalCrystals++;
          break;
        case '3':
          hazards.push(new Hazard(worldPos));
          break;
        case '4':
          exitDoor = new ExitDoor(worldPos);
          break;
      }
    }
  }
  followCamera(1);
}

// ============ 屏幕绘制 ============
// 注意：drawTextScreen 使用屏幕像素坐标，非世界坐标
// centerX/Y = 屏幕中心像素，centerScaled = 世界坐标中心
const _cx = () => mainCanvas.width / 2;
const _cy = () => mainCanvas.height / 2;
function formatTime(seconds) {
  return seconds.toFixed(1) + ' 秒';
}

function finishLevel() {
  finishTime = time - levelStarted;
  newRecord = !levelBest || finishTime < levelBest;
  if (newRecord) {
    levelBest = finishTime;
    try {
      localStorage.setItem('neon-drift.best.' + currentLevelIndex, String(levelBest));
    } catch { /* 存储不可用时仍显示本次成绩 */ }
  }
}

function drawHUD() {
  const ink = rgb(.03, .04, .1);
  drawTextScreen('♥ ' + lives, vec2(16, 24), 22, rgb(1, .5, .55), 3, ink, 'left');
  drawTextScreen('第 ' + (currentLevelIndex + 1) + ' 关 · ' + formatTime(time - levelStarted),
    vec2(_cx(), 24), 17, WHITE, 3, ink);
  drawTextScreen('◆ ' + collectedCrystals + '/' + totalCrystals,
    vec2(mainCanvas.width - 16, 24), 22, NEON.gold, 3, ink, 'right');
  const gateOpen = collectedCrystals === totalCrystals;
  let objective = time < rechargeNoticeUntil ? '晶体充能 · 冲击波就绪' : '收集金色晶体';
  if (gateOpen) objective = '光门已开启 · 前往绿色出口';
  drawTextScreen(objective, vec2(_cx(), 51), 15, gateOpen ? NEON.green : WHITE, 3, ink);
  if (!isMobile()) {
    const hint = shockwaveCooldownTimer > 0 ? '冲击波充能 ' + Math.ceil(shockwaveCooldownTimer) + 's' : '空格 · 冲击波';
    drawTextScreen(hint, vec2(_cx(), mainCanvas.height - 25), 16, NEON.cyan, 3, ink);
  }
}

/** 性能浮层：?fps=1 时显示实时 FPS / 状态（手机实测用） */
function drawPerfOverlay() {
  if (!_showPerf) return;
  const y = mainCanvas.height - 30;
  const tag = lowPowerMode ? ' LP' : '';
  drawTextScreen(Math.round(averageFPS || 0) + 'fps' + tag, vec2(mainCanvas.width - 10, y), 22, rgb(0.5, 1, 0.5), 0, rgb(0,0,0), 'right');
}

/** 绘制调试信息浮层 */
function drawDebug() {
  if (!sensor) return;
  const debugX = 20;
  const debugY = 90;
  const lineHeight = 22;
  let y = debugY;

  // 背景半透明遮罩
  const debugInfo = [
    '--- SENSOR DEBUG ---',
    'alpha: ' + (sensor.alpha != null ? sensor.alpha.toFixed(1) : 'null'),
    'beta: ' + (sensor.beta != null ? sensor.beta.toFixed(1) : 'null'),
    'gamma: ' + (sensor.gamma != null ? sensor.gamma.toFixed(1) : 'null'),
    '--- TILT VECTOR ---',
    'tilt: (' + (sensor.getTiltVector().x).toFixed(3) + ', ' + (sensor.getTiltVector().y).toFixed(3) + ')',
    '--- STATUS ---',
    'sensor.enabled: ' + sensor.enabled,
    'calibrated: ' + sensor._calibrated,
    'gameState: ' + gameState,
  ];

  // 使用 LittleJS 的 drawTextScreen 绘制（屏幕坐标）
  for (const line of debugInfo) {
    const isHeader = line.startsWith('---');
    drawTextScreen(line, vec2(debugX, y), 16, isHeader ? rgb(1, 0.8, 0) : rgb(0.5, 1, 0.5));
    y += lineHeight;
  }
}

function drawResult() {
  const lost = gameState === 'gameover';
  const next = gameState === 'levelcomplete';
  const title = lost ? '光球熄灭' : next ? '关卡完成' : '全程通关';
  const subtitle = lost ? '本关晶体 ' + collectedCrystals + '/' + totalCrystals
    : formatTime(finishTime) + '  ·  ' + (newRecord ? '个人新纪录' : '最佳 ' + formatTime(levelBest));
  mainContext.fillStyle = 'rgba(5, 9, 24, .88)';
  mainContext.fillRect(0, _cy() - 85, mainCanvas.width, 170);
  drawTextScreen(title, vec2(_cx(), _cy() - 40), 30, lost ? NEON.gold : NEON.cyan);
  drawTextScreen(subtitle, vec2(_cx(), _cy() + 6), 18, WHITE);
  drawTextScreen('点击 / 回车 · ' + (next ? '下一关' : lost ? '重试本关' : '再来一局'),
    vec2(_cx(), _cy() + 48), 16, rgb(.65, .8, 1));
}

// ============ 输入处理 ============
function handleKeyboard() {
  // inputWASDEmulateDirection=true 时 WASD 自动映射到方向键，只需检查方向键
  let dx = 0, dy = 0;
  if (keyIsDown('ArrowLeft')) dx -= 1;
  if (keyIsDown('ArrowRight')) dx += 1;
  if (keyIsDown('ArrowUp')) dy += 1;
  if (keyIsDown('ArrowDown')) dy -= 1;
  keyboardInput = vec2(dx, dy);
}

function handleTouch() {
  if (!mouseWasPressed(0) && !keyWasPressed('Enter')) return;
  if (gameState === 'levelcomplete') loadLevel(currentLevelIndex + 1);
  else if (gameState === 'gameover' || gameState === 'win') {
    lives = 3;
    loadLevel(gameState === 'win' ? 0 : currentLevelIndex);
  } else return;
  gameState = 'play';
}

function fireShockwave() {
  if (gameState !== 'play' || !playerBall || shockwaveCooldownTimer > 0) return;
  waveOrigin = playerBall.pos.copy();
  waveStarted = time;
  shockwaveCooldownTimer = CONFIG.shockwaveCooldown;
  emitShockwave(waveOrigin);
  for (let i = hazards.length - 1; i >= 0; i--) {
    const hazard = hazards[i];
    if (distance(waveOrigin, hazard.pos) > CONFIG.shockwaveRadius) continue;
    emitExplode(hazard.pos);
    hazard.destroy();
    hazards.splice(i, 1);
  }
}

// ============ LittleJS 回调 ============
function gameInit() {
  sensor = new SensorInput();
  // 移动端采用更激进的粒子预算，降低加法混合 overdraw
  if (isMobile()) CONFIG.particleBudget = CONFIG.particleBudgetMobile;
  // 移动端降低球的圆形顶点数（32->16），减少 drawCircle 顶点开销
  glCircleSides = isMobile() ? 16 : 32;
  initParticles();
  document.getElementById('start-btn').disabled = false;
  pulseButton.addEventListener('pointerdown', e => {
    e.preventDefault();
    fireShockwave();
  });

  // 虚拟摇杆触摸事件（覆盖整个屏幕）
  mainCanvas.addEventListener('touchstart', _onJoystickStart, { passive: false });
  mainCanvas.addEventListener('touchmove', _onJoystickMove, { passive: false });
  mainCanvas.addEventListener('touchend', _onJoystickEnd, { passive: false });
  mainCanvas.addEventListener('touchcancel', _onJoystickEnd, { passive: false });

}

/** 由 index.html 调用，启动传感器权限并开始游戏 */
window.startGame = async function() {
  if (isMobile() && SensorInput.isAvailable()) {
    gameState = 'calibrate';
    let timeout;
    const granted = await Promise.race([
      sensor.requestPermission(),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 8000); }),
    ]);
    clearTimeout(timeout);
    if (granted) {
      sensor.start();
      await new Promise(resolve => setTimeout(resolve, 600));
      sensor.calibrate();
    }
  }
  loadLevel(0);
  gameState = 'play';
  startBGM();
};

function gameUpdate() {
  breathePhase += timeDelta * 3;
  handleKeyboard();
  handleTouch();

  // FPS 监控 + 低功率模式检测
  updateFPSMonitor();

  // 背景音乐重试（audioContext 需要用户交互后才能激活）
  if (gameState === 'play' && !bgmPlaying) startBGM();

  // 冲击波冷却计时
  shockwaveCooldownTimer = Math.max(0, shockwaveCooldownTimer - timeDelta);

  if (gameState === 'play' && (keyWasPressed('Space') || sensor?.checkShake(time))) {
    fireShockwave();
  }
}

function gameUpdatePost() {
  if (gameState === 'play' && playerBall) followCamera(CONFIG.cameraLerp);
}

// 地图放得下时固定全景；小屏幕只在视口内跟随，避免露出大片空白。
function followCamera(blend) {
  if (!isMobile()) {
    const fit = Math.min(mainCanvas.width / (levelData.width + 2),
      (mainCanvas.height - 120) / levelData.height);
    cameraScale = clamp(Math.floor(fit), CONFIG.cameraScaleDesktop, 48);
  }
  const half = getCameraSize().scale(.5);
  const x = half.x * 2 >= levelData.width ? levelData.width / 2
    : clamp(playerBall.pos.x, half.x, levelData.width - half.x);
  const y = half.y * 2 >= levelData.height ? levelData.height / 2
    : clamp(playerBall.pos.y, half.y, levelData.height - half.y);
  cameraPos.x = lerp(cameraPos.x, x, blend);
  cameraPos.y = lerp(cameraPos.y, y, blend);
}

// 静态迷宫在进关时绘制一次。游戏过程中引擎只需绘制一张纹理。
function buildMazeLayer(level) {
  const size = vec2(level.width, level.height);
  const tilePixels = 24;
  const layer = new CanvasLayer(size.scale(.5), size, 0, -2, size.scale(tilePixels), false);
  const ctx = layer.context;
  ctx.fillStyle = '#0a101e';
  ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  level.map.forEach((row, y) => {
    const top = (level.height - 1 - y) * tilePixels;
    for (let x = 0; x < row.length; x++) {
      const left = x * tilePixels;
      if (row[x] === '1') {
        ctx.fillStyle = '#1a3b5e';
        ctx.fillRect(left, top, tilePixels, tilePixels);
        ctx.fillStyle = '#0f203a';
        ctx.fillRect(left + 1, top + 1, tilePixels - 2, tilePixels - 2);
      } else {
        ctx.fillStyle = '#22304a';
        ctx.fillRect(left + tilePixels / 2, top + tilePixels / 2, 1, 1);
      }
    }
  });
  layer.updateWebGL();
  return layer;
}

function gameRender() {
  drawRect(cameraPos, getCameraSize(), rgb(.02, .025, .065));
}

function gameRenderPost() {
  resetParticleBudget();
  const playing = gameState === 'play';
  const showButton = playing && isMobile();
  if (pulseButton.hidden === showButton) pulseButton.hidden = !showButton;
  if (showButton) {
    const label = shockwaveCooldownTimer > 0 ? Math.ceil(shockwaveCooldownTimer) + 's' : '冲击波';
    if (pulseButton.textContent !== label) pulseButton.textContent = label;
  }
  if (playing) {
    const elapsed = time - waveStarted;
    if (waveOrigin && elapsed < .3) {
      const progress = elapsed / .3;
      drawCircle(waveOrigin, 2 * CONFIG.shockwaveRadius * progress, CLEAR_BLACK,
        .06, rgb(.4, .9, 1, 1 - progress));
    }
    drawHUD();
    renderVirtualJoystick();
  } else if (gameState === 'calibrate') {
    drawTextScreen('请握稳手机，准备出发', vec2(_cx(), _cy()), 22, NEON.cyan);
  } else if (gameState !== 'splash') {
    drawResult();
  }
  drawPerfOverlay();
}

/** 渲染虚拟摇杆（Canvas 2D 覆盖层） */
function renderVirtualJoystick() {
  if (!_joystickActive) return;
  _joyCtx = _joyCtx || mainCanvas.getContext('2d');
  _joyCtx.save();
  _joyCtx.globalAlpha = 0.5;
  // 外圈
  _joyCtx.beginPath();
  _joyCtx.arc(_joystickOrigin.x, _joystickOrigin.y, _joystickRadius, 0, Math.PI * 2);
  _joyCtx.strokeStyle = '#00FFFF';
  _joyCtx.lineWidth = 2;
  _joyCtx.stroke();
  // 内圈（摇杆位置）
  const knobX = _joystickOrigin.x + _joystickVec.x * _joystickRadius;
  const knobY = _joystickOrigin.y + _joystickVec.y * _joystickRadius;
  _joyCtx.beginPath();
  _joyCtx.arc(knobX, knobY, _joystickRadius * 0.4, 0, Math.PI * 2);
  _joyCtx.fillStyle = '#00FFFF';
  _joyCtx.fill();
  _joyCtx.restore();
}

// ============ 虚拟摇杆触摸处理 ============
let _joyCtx = null;

function _onJoystickStart(e) {
  if (gameState !== 'play' || _joystickActive) return;
  const t = e.changedTouches[0];
  e.preventDefault();
  joystickTouchId = t.identifier;
  _joystickActive = true;
  _joystickOrigin = vec2(t.clientX, t.clientY);
  _joystickVec = vec2();
}

function _onJoystickMove(e) {
  const t = Array.from(e.changedTouches).find(t => t.identifier === joystickTouchId);
  if (!t) return;
  e.preventDefault();
  _updateJoystick(t.clientX, t.clientY);
}

function _onJoystickEnd(e) {
  if (!Array.from(e.changedTouches).some(t => t.identifier === joystickTouchId)) return;
  e.preventDefault();
  joystickTouchId = null;
  _joystickActive = false;
  _joystickVec = vec2();
}

function _updateJoystick(cx, cy) {
  const dx = cx - _joystickOrigin.x;
  const dy = cy - _joystickOrigin.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = _joystickRadius;
  const clampedDist = Math.min(dist, maxDist);
  if (dist > 0.01) {
    _joystickVec = vec2(dx / dist * clampedDist / maxDist, dy / dist * clampedDist / maxDist);
  } else {
    _joystickVec = vec2(0, 0);
  }
}

// ============ 启动入口 ============
// 引擎配置必须在 engineInit 之前设置（LittleJS 读取 canvasMaxSize 等参数）
canvasMaxSize = vec2(1920, 1080); // 最大分辨率（允许 canvas 填满整个视口）
canvasPixelated = true;           // 像素风格
showSplashScreen = false;         // 禁用启动画面
cameraScale = isMobile() ? CONFIG.cameraScaleMobile : CONFIG.cameraScaleDesktop; // 移动端更高缩放，视口剔除生效
touchGamepadEnable = false;        // 禁用虚拟游戏手柄（使用自定义 UI）
// 注意：touchInputEnable 保持默认 true，让 LittleJS 处理触摸转鼠标输入

engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [], document.body);
