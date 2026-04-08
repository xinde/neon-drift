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
  mobileTrailInterval: 0.08, // 移动端更高间隔
  mobileGlowInterval: 0.08,
  // 视口剔除边距
  cullMargin: 3,
  // 粒子预算追踪
  particleBudget: 1500,      // 优化：实际预算低于配置上限，留余量
  // 低功率模式阈值（连续低FPS次数）
  lowPowerThreshold: 3,
  lowPowerTrailInterval: 0.1,
  lowPowerGlowInterval: 0.1,
  // 冲击波冷却时间
  lowPowerCooldown: 0.5,
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
let breathePhase = 0;
let backgroundSpawned = false;
// 性能追踪
let fpsHistory = [];
let lowPowerMode = false;
let lowPowerConsecutive = 0;
// 冲击波冷却计时
let shockwaveCooldownTimer = 0;

// ============ 工具函数 ============
/** FPS 监控与低功率模式检测 */
function updateFPSMonitor() {
  if (timeDelta <= 0) return;
  const fps = 1 / timeDelta;
  fpsHistory.push(fps);
  if (fpsHistory.length > 30) fpsHistory.shift();
  const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
  if (avgFps < 30 && gameState === 'play') {
    lowPowerConsecutive++;
    if (lowPowerConsecutive >= CONFIG.lowPowerThreshold && !lowPowerMode) {
      lowPowerMode = true;
    }
  } else {
    lowPowerConsecutive = 0;
    if (lowPowerMode && avgFps > 45) {
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
    // 获取输入：传感器优先，无传感器时使用虚拟摇杆，PC 端使用键盘
    let sensorVec = vec2(0, 0);
    if (sensor && sensor.enabled) {
      sensorVec = sensor.getTiltVector();
      sensorVec.x = -sensorVec.x; // negate X: tilt left = move left
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
    this.velocity.y += -input.y * this.speed * timeDelta;

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
        // 晶体收集音效占位 (ZzFX)
        // zzfx(1, .5, 200, .02, .1, .1, 0, 1.5); // 解压后启用
      }
    }

    // 暗礁触碰
    for (let i = hazards.length - 1; i >= 0; i--) {
      if (distance(this.pos, hazards[i].pos) < this.radius + 0.35) {
        emitExplode(this.pos);
        hazards[i].destroy();
        hazards.splice(i, 1);
        lives--;
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
  crystals = [];
  hazards = [];
  exitDoor = null;
  collectedCrystals = 0;
  totalCrystals = 0;
  backgroundSpawned = false;
  // 每次进入新关卡重置位置
  if (playerBall) {
    playerBall.pos = vec2(0, 0);
    playerBall.velocity = vec2(0, 0);
  }

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
  // 晶体计数（右上方）
  drawTextScreen('\u25C6 ' + collectedCrystals + '/' + totalCrystals, vec2(_rx(), _ry()), 32, rgb(1, 0.8, 0));

  // 生命值（左上方）
  drawTextScreen('\u2665 ' + lives, vec2(20, 20), 32, rgb(1, 0.4, 0.4));

  // 传感器状态指示器
  if (sensor && sensor.enabled) {
    // 绿色小圆点表示陀螺仪活跃
    drawTextScreen('\u25CF', vec2(20, 55), 24, rgb(0.2, 1, 0.4));
  } else if (sensorStatus === 'NO_HTTPS') {
    drawTextScreen('\u26A0 HTTPS', vec2(20, 55), 20, rgb(1, 0.6, 0));
  } else if (!sensorAvailable) {
    // 仅在传感器完全不可用时显示摇杆提示
    drawTextScreen('JOYSTICK', vec2(20, 55), 20, rgb(0.4, 0.6, 1));
  }
  // sensorAvailable === true 但 sensor.enabled === false 时：不显示任何提示（权限申请中）

  // 低功率模式提示
  if (lowPowerMode) {
    const fpsAvg = fpsHistory.length > 0 ? fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length : 0;
    drawTextScreen('LOW-PWR ' + Math.round(fpsAvg) + 'fps', vec2(20, 85), 24, rgb(1, 0.3, 0.3));
  }

  // 调试信息显示（手机端调试用）
  drawDebug();
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
    'alpha: ' + (sensor.alpha ?? 'null').toFixed(1),
    'beta: ' + (sensor.beta ?? 'null').toFixed(1),
    'gamma: ' + (sensor.gamma ?? 'null').toFixed(1),
    '--- TILT VECTOR ---',
    'tilt: (' + (sensor.getTiltVector().x ?? 0).toFixed(3) + ', ' + (sensor.getTiltVector().y ?? 0).toFixed(3) + ')',
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
    // 直接请求权限，不设超时（浏览器自有超时保护）
    // Android/桌面：立即返回 true（无需弹窗）
    // iOS 13+：显示系统对话框，等待用户响应
    const granted = await sensor.requestPermission();
    if (granted === true) {
      sensor.start();
      sensorAvailable = true;
      sensorStatus = 'ACTIVE';
      console.log('[Game] Sensor started');
    } else if (granted === false) {
      sensorStatus = 'DENIED';
    }
  }
  // 切换到校准流程，自动进入游戏（无需再次点击）
  gameState = 'calibrate';
  // 延迟 0.5s 后自动进入游戏，给校准提示留出显示时间
  setTimeout(() => {
    if (gameState === 'calibrate') {
      if (sensor) sensor.calibrate();
      gameState = 'play';
      loadLevel(0);
    }
  }, 500);
};

function gameUpdate() {
  breathePhase += timeDelta * 3;
  handleKeyboard();
  handleTouch();

  // FPS 监控 + 低功率模式检测
  updateFPSMonitor();

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
    // 跟随玩家
    cameraPos = playerBall.pos.copy();
  }
}

function gameUpdatePost() {
  if (gameState === 'play' && playerBall) {
    playerBall.update();
  }
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

    // 绘制迷宫墙体（视口剔除：只渲染屏幕范围内的墙体）
  for (let y = 0; y < levelData.height; y++) {
    for (let x = 0; x < levelData.width; x++) {
      if (levelData.map[y][x] === '1') {
        const wp = tileToWorld(x, y);
        // 视口剔除：tile 超出视野则跳过
        const cam = cameraPos;
        const viewW = getCameraSize().x * 0.5 + CONFIG.cullMargin;
        const viewH = getCameraSize().y * 0.5 + CONFIG.cullMargin;
        if (wp.x < cam.x - viewW || wp.x > cam.x + viewW ||
            wp.y < cam.y - viewH || wp.y > cam.y + viewH) continue;
        drawRect(wp, vec2(1), rgb(0.1, 0.1, 0.25));
        // 霓虹边框
        drawRect(wp, vec2(0.95), rgb(0, 0.3, 0.6), 0);
      }
    }
  }

  // 绘制晶体
  for (const c of crystals) {
    c.update();
    c.render();
  }

  // 绘制暗礁
  for (const h of hazards) {
    h.update();
    h.render();
  }

  // 绘制终点
  if (exitDoor) {
    exitDoor.update();
    exitDoor.render();
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
  // 始终 preventDefault，防止 LittleJS 将触摸转换为鼠标事件导致状态误触发
  e.preventDefault();
  const t = e.touches[0];
  // 屏幕右半边作为摇杆区域（仅在游戏中/校准中激活摇杆）
  if (gameState === 'play' || gameState === 'calibrate') {
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
cameraScale = 20;                  // 缩放比例
touchGamepadEnable = false;        // 禁用虚拟游戏手柄（使用自定义 UI）
// 注意：touchInputEnable 保持默认 true，让 LittleJS 处理触摸转鼠标输入

engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [], document.body);
