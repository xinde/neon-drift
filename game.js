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
let keyboardInput = vec2(0, 0);
let shockwaveKeyDown = false;
let _screenClicked = false; // 单帧点击标志，防止重复触发
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
    // 获取输入（传感器优先，键盘辅助/桌面端备用）
    let sensorVec = sensor && sensor.enabled ? sensor.getTiltVector() : vec2(0, 0);
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
  drawTextScreen('CALIBRATE', vec2(_cx(), _cy()), 3, rgb(1, 1, 0));
  drawTextScreen('Hold phone steady and tap', vec2(_cx(), _cy() + 60), 1.5, rgb(0.8, 0.8, 1));
  drawTextScreen('[ TAP TO CALIBRATE ]', vec2(_cx(), _cy() + 100), 1.5, rgb(0, 1, 1));
}

function drawHUD() {
  // 晶体计数（右上方）
  drawTextScreen('\u25C6 ' + collectedCrystals + '/' + totalCrystals, vec2(_rx(), _ry()), 32, rgb(1, 0.8, 0));

  // 生命值（左上方）
  drawTextScreen('\u2665 ' + lives, vec2(20, 20), 32, rgb(1, 0.4, 0.4));

  // 低功率模式提示
  if (lowPowerMode) {
    const fpsAvg = fpsHistory.length > 0 ? fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length : 0;
    drawTextScreen('LOW-PWR ' + Math.round(fpsAvg) + 'fps', vec2(20, 55), 24, rgb(1, 0.3, 0.3));
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
  // 点击屏幕切换状态（mouseWasPressed 检测按下，_screenClicked 标志防止重复）
  if (mouseWasPressed(0) && !_screenClicked) {
    _screenClicked = true;
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
  // 鼠标释放后重置标志
  if (mouseWasReleased(0)) {
    _screenClicked = false;
  }
}

// ============ LittleJS 回调 ============
function gameInit() {
  sensor = new SensorInput();
  initParticles();
}

/** 由 index.html 调用，启动传感器权限并开始游戏 */
window.startGame = async function() {
  // 请求传感器权限（iOS 13+ 需要用户手势触发）
  if (sensor) {
    const granted = await sensor.requestPermission();
    if (granted) {
      sensor.start();
    }
  }
  // 切换到校准流程
  gameState = 'calibrate';
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
}

// ============ 启动入口 ============
// 引擎配置必须在 engineInit 之前设置（LittleJS 读取 canvasMaxSize 等参数）
canvasMaxSize = vec2(1920, 1080); // 最大分辨率（允许 canvas 填满整个视口）
canvasPixelated = true;           // 像素风格
showSplashScreen = false;         // 禁用启动画面
cameraScale = 20;                  // 缩放比例
touchGamepadEnable = false;        // 禁用虚拟游戏手柄（使用自定义 UI）
touchInputEnable = false;          // 禁用 LittleJS 内置触摸处理，让触摸事件通过鼠标路径

engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [], document.body);
