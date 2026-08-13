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
  ballSpeed: 3,
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
  lowPowerCooldown: 0.5,
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
let sensorAvailable = false;   // 传感器是否可用
let sensorStatus = 'INIT';     // INIT | NO_HTTPS | TIMEOUT | DENIED | ACTIVE
// 虚拟摇杆（传感器不可用时的触摸后备）
let _joystickActive = false;   // 是否正在触摸摇杆区域
let _joystickOrigin = vec2(0, 0);  // 摇杆中心（屏幕坐标）
let _joystickVec = vec2(0, 0);     // 归一化摇杆方向 [-1, 1]
let _joystickRadius = 60;     // 摇杆最大半径（像素）
let keyboardInput = vec2(0, 0);
let shockwaveKeyDown = false;
let playerBall = null;
let crystals = [];
let hazards = [];
let exitDoor = null;
let totalCrystals = 0;
let collectedCrystals = 0;
let trailTimer = 0;
let glowTimer = 0;
let levelData = LEVELS[0];
let wallTiles = []; // 预计算的墙体 tile 坐标列表（loadLevel 时构建，避免每帧扫描全图）
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
function getTile(pos) {
  const tx = Math.floor(pos.x);
  const ty = Math.floor(pos.y);
  if (ty < 0 || ty >= levelData.height || tx < 0 || tx >= levelData.width) return '1';
  return levelData.map[ty][tx];
}

function isWall(pos) {
  return getTile(pos) === '1';
}

function worldToTile(worldPos) {
  return vec2(Math.floor(worldPos.x), Math.floor(worldPos.y));
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

    // 获取输入：传感器优先，无传感器时使用虚拟摇杆，PC 端使用键盘
    let sensorVec = vec2(0, 0);
    if (sensor && sensor.enabled) {
      // 传感器断流保护：iOS 某些情况会停止发送事件，此时归零输入避免球持续漂移
      if (sensor.isStale(time)) {
        sensorVec = vec2(0, 0);
      } else {
        // 方向映射遵循物理直觉（W3C DeviceOrientation，竖屏正常握持）：
        //   gamma(右倾+) -> X+(右)，beta(前倾+) -> Y+(屏幕上方/前方)
        //   X 不取反；Y 取反以匹配实际握持下的前后方向感受
        sensorVec = sensor.getTiltVector();
        sensorVec.y = -sensorVec.y;
      }
    } else if (_joystickActive) {
      // 虚拟摇杆：Y轴反向（屏幕向下为正，转为游戏向上为正）
      sensorVec = vec2(_joystickVec.x, -_joystickVec.y);
    }
    let input = vec2(
      clamp(sensorVec.x + keyboardInput.x, -1, 1),
      clamp(sensorVec.y + keyboardInput.y, -1, 1)
    );

    // 应用加速度
    this.velocity.x += input.x * this.speed * timeDelta;
    this.velocity.y += input.y * this.speed * timeDelta;

    // 阻尼
    this.velocity.x *= .92;
    this.velocity.y *= .92;

    // 速度上限
    const spd = this.velocity.length();
    if (spd > this.speed) this.velocity = this.velocity.normalize().scale(this.speed);

    // 轴分离碰撞检测：先处理 X 轴
    const newX = this.pos.x + this.velocity.x;
    if (!this._overlapsWall(newX, this.pos.y)) {
      this.pos.x = newX;
    } else {
      // X 轴撞墙：反弹并找边界
      this.velocity.x *= -.5;
      const boundary = this._findWallBoundary(this.pos.x, this.pos.y, Math.sign(this.velocity.x) || 1, 0);
      this.pos.x = boundary;
      emitSparks(vec2(this.pos.x, this.pos.y), vec2(Math.sign(this.pos.x - boundary) || -this.velocity.x, 0));
    }

    // 再处理 Y 轴
    const newY = this.pos.y + this.velocity.y;
    if (!this._overlapsWall(this.pos.x, newY)) {
      this.pos.y = newY;
    } else {
      // Y 轴撞墙：反弹并找边界
      this.velocity.y *= -.5;
      const boundary = this._findWallBoundary(this.pos.x, this.pos.y, 0, Math.sign(this.velocity.y) || 1);
      this.pos.y = boundary;
      emitSparks(vec2(this.pos.x, this.pos.y), vec2(0, Math.sign(this.pos.y - boundary) || -this.velocity.y));
    }

    // 安全措施：如果仍然卡在墙内，强制推送到最近空位
    if (this._overlapsWall(this.pos.x, this.pos.y)) {
      this._pushOutOfWall();
    }

    // 晶体收集
    for (let i = crystals.length - 1; i >= 0; i--) {
      if (distance(this.pos, crystals[i].pos) < this.radius + 0.3) {
        emitCollect(crystals[i].pos);
        crystals[i].destroy();
        crystals.splice(i, 1);
        collectedCrystals++;
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
    // 外发光圆
    drawCircle(this.pos, this.radius, rgb(0, .8, 1));
    // 呼吸效果
    const pulse = 0.05 * Math.sin(breathePhase);
    drawCircle(this.pos, this.radius + pulse, rgb(0.3, 1, 1, 0.4));
  }

  /** 检查球在指定位置是否与墙壁重叠（检查球周围的多个点） */
  _overlapsWall(x, y) {
    const r = this.radius * 0.95;
    const checks = [
      [x, y],
      [x + r, y], [x - r, y],
      [x, y + r], [x, y - r],
      [x + r * 0.7, y + r * 0.7], [x - r * 0.7, y - r * 0.7],
      [x + r * 0.7, y - r * 0.7], [x - r * 0.7, y + r * 0.7],
    ];
    for (const [cx, cy] of checks) {
      if (isWall(worldToTile(vec2(cx, cy)))) return true;
    }
    return false;
  }

  /** 沿指定方向找到最近的墙壁边界位置 */
  _findWallBoundary(x, y, dirX, dirY) {
    const step = 0.05;
    const limit = 5;
    if (dirX === 0 && dirY === 0) return y;
    if (dirX !== 0) {
      // 水平方向找墙边界
      const sign = dirX > 0 ? 1 : -1;
      let cx = x;
      for (let i = 0; i < limit; i++) {
        cx += sign * step;
        if (!isWall(worldToTile(vec2(cx + this.radius * sign, y)))) {
          return cx;
        }
      }
      // 回退到安全距离
      return x - sign * (this.radius + 0.01);
    } else {
      // 垂直方向找墙边界
      const sign = dirY > 0 ? 1 : -1;
      let cy = y;
      for (let i = 0; i < limit; i++) {
        cy += sign * step;
        if (!isWall(worldToTile(vec2(x, cy + this.radius * sign)))) {
          return cy;
        }
      }
      return y - sign * (this.radius + 0.01);
    }
  }

  /** 如果球卡在墙内，强制将其推出到最近的安全位置 */
  _pushOutOfWall() {
    const r = this.radius + 0.02;
    const angles = 16;
    for (let i = 0; i < angles; i++) {
      const angle = (i / angles) * Math.PI * 2;
      const testX = this.pos.x + Math.cos(angle) * r;
      const testY = this.pos.y + Math.sin(angle) * r;
      if (!isWall(worldToTile(vec2(testX, testY)))) {
        this.pos.x = testX;
        this.pos.y = testY;
        this.velocity.x *= 0.3;
        this.velocity.y *= 0.3;
        return;
      }
    }
    // 终极回退：直接移到上一帧位置
    this.pos.x -= this.velocity.x * 2;
    this.pos.y -= this.velocity.y * 2;
    this.velocity.x = 0;
    this.velocity.y = 0;
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
    drawRect(this.pos, vec2(0.3), rgb(1, .9, 0), this.angle);
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
    drawRect(this.pos, vec2(0.6), rgb(1, 0, p * 0.3), 0);
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
  wallTiles = [];

  // 遍历地图
  for (let y = 0; y < levelData.height; y++) {
    for (let x = 0; x < levelData.width; x++) {
      const tile = levelData.map[y][x];
      const worldPos = tileToWorld(x, y);
      switch (tile) {
        case '1':
          wallTiles.push(vec2(x, y));
          break;
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
  // 校准传感器
  if (sensor) sensor.calibrate();
}

// ============ 屏幕绘制 ============
// 注意：drawTextScreen 使用屏幕像素坐标，非世界坐标
// centerX/Y = 屏幕中心像素，centerScaled = 世界坐标中心
const _cx = () => mainCanvas.width / 2;
const _cy = () => mainCanvas.height / 2;
const _rx = () => mainCanvas.width - 20;
const _ry = () => 20;

function drawSplash() {
  drawTextScreen('NEON DRIFT', vec2(_cx(), _cy()), 3, rgb(0, 1, 1));
  drawTextScreen('Tilt your phone to control', vec2(_cx(), _cy() + 60), 1.5, rgb(0.5, 0.8, 1));
  drawTextScreen('Tap to Start', vec2(_cx(), _cy() + 100), 1.5, rgb(1, 1, 1));
  drawTextScreen('Collect all crystals - Avoid hazards - Reach the gate', vec2(_cx(), _cy() + 140), 1, rgb(0.5, 0.5, 1));
}

function drawCalibrate() {
  drawTextScreen('CALIBRATE', vec2(_cx(), _cy() - 60), 3, rgb(1, 1, 0));
  drawTextScreen('Hold phone steady and tap', vec2(_cx(), _cy()), 1.5, rgb(0.8, 0.8, 1));

  // 显示传感器状态
  let statusColor = rgb(0, 1, 1);
  let statusText = '';
  if (sensorStatus === 'ACTIVE') {
    statusText = '\u2713 GYRO ACTIVE';
    statusColor = rgb(0.2, 1, 0.4);
  } else if (sensorStatus === 'NO_HTTPS') {
    statusText = '\u26A0 HTTPS REQUIRED';
    statusColor = rgb(1, 0.4, 0);
  } else if (sensorStatus === 'TIMEOUT' || sensorStatus === 'DENIED') {
    statusText = '\u26A0 GYRO UNAVAILABLE - Touch to steer';
    statusColor = rgb(1, 0.6, 0);
  } else {
    statusText = 'Starting sensor...';
    statusColor = rgb(0.5, 0.5, 0.5);
  }
  drawTextScreen(statusText, vec2(_cx(), _cy() + 40), 1.2, statusColor);

  // 如果传感器不可用，显示触摸后备提示
  if (!sensorAvailable) {
    drawTextScreen('Touch right side of screen to steer', vec2(_cx(), _cy() + 70), 1.0, rgb(0.4, 0.4, 0.6));
  }

  drawTextScreen('[ TAP TO START ]', vec2(_cx(), _cy() + 110), 1.5, rgb(0, 1, 1));
}

function drawHUD() {
  // 晶体计数（右上方，右对齐）
  drawTextScreen('\u25C6 ' + collectedCrystals + '/' + totalCrystals, vec2(_rx(), _ry()), 32, rgb(1, 0.8, 0), 0, rgb(0,0,0), 'right');

  // 生命值（左上方，左对齐）
  drawTextScreen('\u2665 ' + lives, vec2(20, 20), 32, rgb(1, 0.4, 0.4), 0, rgb(0,0,0), 'left');

  // 传感器状态指示器
  if (sensor && sensor.enabled) {
    if (sensor.isStale(time)) {
      // 传感器断流：橙色感叹号
      drawTextScreen('\u26A0 SIGNAL', vec2(20, 55), 20, rgb(1, 0.6, 0));
    } else {
      // 绿色小圆点表示陀螺仪活跃
      drawTextScreen('\u25CF', vec2(20, 55), 24, rgb(0.2, 1, 0.4));
    }
  } else if (sensorStatus === 'NO_HTTPS') {
    drawTextScreen('\u26A0 HTTPS', vec2(20, 55), 20, rgb(1, 0.6, 0));
  } else if (!sensorAvailable) {
    // 仅在传感器完全不可用时显示摇杆提示
    drawTextScreen('JOYSTICK', vec2(20, 55), 20, rgb(0.4, 0.6, 1));
  }
  // sensorAvailable === true 但 sensor.enabled === false 时：不显示任何提示（权限申请中）

  // 低功率模式提示
  if (lowPowerMode) {
    drawTextScreen('LOW-PWR ' + Math.round(averageFPS || 0) + 'fps', vec2(20, 85), 24, rgb(1, 0.3, 0.3));
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

function drawWin() {
  drawTextScreen('VICTORY!', vec2(_cx(), _cy()), 3, rgb(0, 1, 0));
  drawTextScreen('All crystals collected', vec2(_cx(), _cy() + 60), 1.5, rgb(0.8, 1, 0.8));
  drawTextScreen('Refresh to play again', vec2(_cx(), _cy() + 100), 1.5, rgb(0.5, 0.5, 1));
}

function drawLevelComplete() {
  drawTextScreen('LEVEL CLEAR!', vec2(_cx(), _cy()), 2.5, rgb(0, 1, 1));
  const nextLevel = currentLevelIndex + 1;
  if (nextLevel < LEVELS.length) {
    drawTextScreen('Next: ' + LEVELS[nextLevel].name, vec2(_cx(), _cy() + 60), 1.5, rgb(0.8, 0.8, 1));
    drawTextScreen('Tap to continue', vec2(_cx(), _cy() + 100), 1.5, rgb(0.5, 0.5, 1));
  }
}

function drawGameOver() {
  drawTextScreen('GAME OVER', vec2(_cx(), _cy()), 3, rgb(1, 0, 0));
  drawTextScreen('Refresh to try again', vec2(_cx(), _cy() + 60), 1.5, rgb(1, 0.5, 0.5));
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
  if (keyIsDown('Space')) shockwaveKeyDown = true;
}

function handleTouch() {
  // mouseWasPressed 本身就是每按一次只触发一次，不需要额外标志
  if (mouseWasPressed(0)) {
    if (gameState === 'splash') {
      gameState = 'calibrate';
    } else if (gameState === 'calibrate') {
      if (sensor) sensor.calibrate();
      gameState = 'play';
      loadLevel(0);
      startBGM();
    } else if (gameState === 'levelcomplete') {
      // 加载下一关（若还有）或胜利
      if (currentLevelIndex < LEVELS.length - 1) {
        loadLevel(currentLevelIndex + 1);
        gameState = 'play';
      } else {
        gameState = 'win';
      }
    } else if (gameState === 'win' || gameState === 'gameover') {
      // 胜利/失败后点击：从第一关重新开始
      lives = 3;
      currentLevelIndex = 0;
      loadLevel(0);
      gameState = 'play';
    }
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

  // 虚拟摇杆触摸事件（覆盖整个屏幕）
  mainCanvas.addEventListener('touchstart', _onJoystickStart, { passive: false });
  mainCanvas.addEventListener('touchmove', _onJoystickMove, { passive: false });
  mainCanvas.addEventListener('touchend', _onJoystickEnd, { passive: false });
  mainCanvas.addEventListener('touchcancel', _onJoystickEnd, { passive: false });

}

/** 由 index.html 调用，启动传感器权限并开始游戏 */
window.startGame = async function() {
  sensorAvailable = SensorInput.isAvailable();
  if (!sensorAvailable) {
    sensorStatus = 'NO_HTTPS';
  }
  if (sensor) {
    // 超时保护：某些设备上 requestPermission 可能永不 resolve
    // iOS 需要两次权限对话框（Orientation + Motion），给足 8 秒
    const permissionPromise = sensor.requestPermission();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), 8000));
    const granted = await Promise.race([permissionPromise, timeoutPromise]);
    if (granted === 'timeout') {
      sensorStatus = 'TIMEOUT';
      console.warn('[Game] Sensor permission timed out');
    } else if (granted === true) {
      sensor.start();
      sensorAvailable = true;
      sensorStatus = 'ACTIVE';
      console.log('[Game] Sensor started');
    } else if (granted === false) {
      sensorStatus = 'DENIED';
    }
  }
  // 切换到校准流程
  gameState = 'calibrate';
  // 延迟 1s 后自动进入游戏，给传感器数据充分时间收敛
  setTimeout(() => {
    if (gameState === 'calibrate') {
      // 验证传感器是否真正在发送数据（beta/gamma 非零表示有数据）
      if (sensor && sensor.enabled) {
        if (sensor.beta === 0 && sensor.gamma === 0 && sensor.alpha === 0) {
          console.warn('[Game] Sensor enabled but no data received, events may not be firing');
          sensorStatus = 'TIMEOUT';
          sensorAvailable = false;
        }
      }
      if (sensor) sensor.calibrate();
      gameState = 'play';
      loadLevel(0);
      startBGM();
    }
  }, 1000);
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

  // 传感器摇动触发冲击波（手机端）
  if (sensor && sensor.enabled) {
    if (sensor.checkShake(time) && shockwaveCooldownTimer <= 0) {
      shockwaveCooldownTimer = CONFIG.lowPowerCooldown || 0.5;
      emitShockwave(playerBall ? playerBall.pos : cameraPos, sensor.getTiltVector());
    }
  }
  // 空格键触发冲击波（桌面端，始终可用）
  if (keyWasPressed('Space') || shockwaveKeyDown) {
    shockwaveKeyDown = false;
    if (shockwaveCooldownTimer <= 0) {
      shockwaveCooldownTimer = CONFIG.lowPowerCooldown || 0.5;
      emitShockwave(playerBall ? playerBall.pos : cameraPos, vec2(1, 0));
    }
  }

  if (gameState === 'play' && playerBall) {
    // 相机平滑跟随（帧率无关 lerp）+ 像素对齐，消除像素化渲染的亚像素抖动
    const k = 1 - Math.pow(1 - CONFIG.cameraLerp, timeDelta * 60);
    cameraPos.x = lerp(cameraPos.x, playerBall.pos.x, k);
    cameraPos.y = lerp(cameraPos.y, playerBall.pos.y, k);
    // 对齐到 1/cameraScale 网格，让 tile 边界落在整数像素上，避免 nearest 采样抖动
    const cs = cameraScale;
    cameraPos.x = Math.round(cameraPos.x * cs) / cs;
    cameraPos.y = Math.round(cameraPos.y * cs) / cs;
  }
}

function gameUpdatePost() {
  // Ball 的 update 由 LittleJS 引擎自动调用，无需手动调用
}

function gameRender() {
  // 绘制背景
  drawRect(cameraPos, getCameraSize(), rgb(0.02, 0.02, 0.08));

  if (gameState === 'splash') {
    drawSplash();
    return;
  }
  if (gameState === 'calibrate') {
    drawCalibrate();
    return;
  }
  if (gameState === 'win') {
    drawWin();
  } else if (gameState === 'gameover') {
    drawGameOver();
  } else if (gameState === 'levelcomplete') {
    // 显示关卡完成文字，底层游戏画面保持可见
    drawLevelComplete();
  }

  if (gameState === 'play' || gameState === 'levelcomplete') {
    // 正常游戏逻辑

    // 绘制迷宫墙体（使用预计算的 wallTiles + 视口剔除）
    const cam = cameraPos;
    const viewW = getCameraSize().x * 0.5 + CONFIG.cullMargin;
    const viewH = getCameraSize().y * 0.5 + CONFIG.cullMargin;
    const minX = cam.x - viewW, maxX = cam.x + viewW;
    const minY = cam.y - viewH, maxY = cam.y + viewH;
    for (let i = 0; i < wallTiles.length; i++) {
      const t = wallTiles[i];
      if (t.x < minX || t.x > maxX || t.y < minY || t.y > maxY) continue;
      const wp = tileToWorld(t.x, t.y);
      drawRect(wp, vec2(1), rgb(0.1, 0.1, 0.25));
      // 霓虹边框
      drawRect(wp, vec2(0.95), rgb(0, 0.3, 0.6), 0);
    }

  // 绘制晶体（update 由 LittleJS 引擎自动调用；视口剔除跳过屏外渲染）
  for (const c of crystals) {
    if (c.pos.x < minX || c.pos.x > maxX || c.pos.y < minY || c.pos.y > maxY) continue;
    c.render();
  }

  // 绘制暗礁
  for (const h of hazards) {
    if (h.pos.x < minX || h.pos.x > maxX || h.pos.y < minY || h.pos.y > maxY) continue;
    h.render();
  }

  // 绘制终点
  if (exitDoor) {
    if (!(exitDoor.pos.x < minX || exitDoor.pos.x > maxX || exitDoor.pos.y < minY || exitDoor.pos.y > maxY)) {
      exitDoor.render();
    }
  }

  // 绘制玩家
  if (playerBall) {
    playerBall.render();
  }

  // HUD（levelcomplete 时也显示晶体计数）
  drawHUD();
  }
}

function gameRenderPost() {
  // 后处理：渲染粒子
  for (const key in emitters) {
    emitters[key].update();
    emitters[key].render();
  }
  // 每帧重置粒子预算计数
  resetParticleBudget();
  // 渲染虚拟摇杆（仅当传感器不可用且在游戏中）
  if (!(sensor && sensor.enabled) && (gameState === 'play' || gameState === 'calibrate')) {
    renderVirtualJoystick();
  }
  // 性能浮层（?fps=1）
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
  const t = e.touches[0];
  // 仅在游戏中/校准中激活摇杆并阻止默认行为
  // 其他状态（splash, levelcomplete, win, gameover）不阻止，让 LittleJS 正常处理触摸转鼠标
  if (gameState === 'play' || gameState === 'calibrate') {
    e.preventDefault();
    if (t.clientX > mainCanvas.width * 0.3) {
      _joystickActive = true;
      _joystickOrigin = vec2(t.clientX, t.clientY);
      _updateJoystick(t.clientX, t.clientY);
    }
  }
}

function _onJoystickMove(e) {
  if (_joystickActive) {
    e.preventDefault();
    const t = e.touches[0];
    _updateJoystick(t.clientX, t.clientY);
  }
}

function _onJoystickEnd(e) {
  if (_joystickActive) {
    e.preventDefault();
    _joystickActive = false;
    _joystickVec = vec2(0, 0);
  }
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
