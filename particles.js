/**
 * particles.js - Neon Drift 粒子效果
 * 7种粒子发射器：光球外晕、移动尾迹、碰撞火花、晶体爆发、暗礁爆炸、冲击波、背景星尘
 * 包含自适应质量：粒子预算、视口剔除、移动端/LOD 缩放
 */

'use strict';

/** 全局粒子发射器容器 */
const emitters = {};

/** 粒子预算追踪（自适应质量缩放） */
let _particleBudgetUsed = 0;

/** 设备/平台检测（引用 game.js 中定义） */
function _isMobileDevice() {
  // 使用 game.js 中的 isMobile()，避免重复定义
  return typeof isMobile === 'function' ? isMobile() : false;
}

/** 获取质量缩放因子（0~1，low=0.4, medium=0.7, high=1.0） */
function _qualityScale() {
  if (_isMobileDevice()) return 0.7;
  return 1.0;
}

/** 粒子预算检查（缩放后的批次数量） */
function _budgetCheck(count) {
  const budget = CONFIG.particleBudget || 1500;
  const scaled = Math.round(count * _qualityScale());
  if (_particleBudgetUsed + scaled > budget) return false;
  _particleBudgetUsed += scaled;
  return true;
}

/** 重置每帧预算计数（在 gameRenderPost 末尾调用） */
function resetParticleBudget() {
  _particleBudgetUsed = 0;
}

/** 霓虹色盘 */
const NEON = {
  cyan:     rgb(0, 1, 1),
  magenta:  rgb(1, 0, 1),
  yellow:  rgb(1, 1, 0),
  white:   rgb(1, 1, 1),
  red:     rgb(1, 0, 0),
  purple:  rgb(0.5, 0, 1),
  green:   rgb(0, 1, 0.5),
  gold:    rgb(1, 0.8, 0.2),
  blue:    rgb(0.2, 0.5, 1),
};

/** 随机霓虹色 */
function randNeon() {
  const colors = [NEON.cyan, NEON.magenta, NEON.yellow, NEON.green, NEON.blue, NEON.gold];
  return colors[Math.floor(rand(colors.length))];
}

/** 初始化所有粒子发射器 */
function initParticles() {
  // 1. 光球外晕 — 白→青渐变，呼吸动画，additive
  emitters.glow = new ParticleEmitter(
    vec2(0, 0), 0, .5, 0, 30, PI,
    undefined,
    rgb(1, 1, 1), rgb(0.7, 1, 1),     // colorStart
    rgb(0, 1, 1, 0), rgb(0, 1, 1, 0), // colorEnd 透明
    1, .3, .5, 0, 0,     // particleTime, sizeStart, sizeEnd, speed, angleSpeed
    1, 1, 0, PI, 0,       // damping, angleDamping, gravityScale, particleCone
    .1, .3,              // fadeRate, randomness
    false, true           // collideTiles, additive
  );

  // 2. 移动尾迹 — 随机霓虹色，0.5-1.5s生命周期
  emitters.trail = new ParticleEmitter(
    vec2(0, 0), 0, .1, 0, 0, PI,
    undefined,
    NEON.cyan, NEON.magenta,
    rgb(0, 0, 0, 0), rgb(0, 0, 0, 0),
    1, .08, .02, .05, 0,
    .98, 1, 0, PI,
    .3, .5,
    false, true
  );

  // 3. 墙体碰撞火花 — 白→青，快速消散
  emitters.spark = new ParticleEmitter(
    vec2(0, 0), 0, 0, 0, 0, PI,
    undefined,
    rgb(1, 1, 1), rgb(0.7, 1, 1),
    rgb(0, 1, 1, 0), rgb(0, 1, 1, 0),
    .3, .06, 0, .3, 0,
    .95, 1, .2, PI,
    .5, .8,
    false, true
  );

  // 4. 晶体收集爆发 — 金黄→白，0.5-1s
  emitters.collect = new ParticleEmitter(
    vec2(0, 0), 0, 0, 0, 0, PI,
    undefined,
    NEON.gold, rgb(1, 1, 0.5),
    rgb(1, 1, 1, 0), rgb(1, 1, 1, 0),
    .8, .1, .02, .4, randSign() * .2,
    .95, 1, .1, PI,
    .3, .5,
    false, true
  );

  // 5. 暗礁触碰爆炸 — 红→紫→黑，快速扩散
  emitters.explode = new ParticleEmitter(
    vec2(0, 0), 0, 0, 0, 0, PI,
    undefined,
    NEON.red, NEON.purple,
    rgb(0, 0, 0, 0), rgb(0, 0, 0, 0),
    .6, .15, 0, .6, randSign() * .3,
    .92, 1, .1, PI,
    .5, .8,
    false, false
  );

  // 6. 冲击波粒子 — 紫→透明，圆环扩散
  emitters.shockwave = new ParticleEmitter(
    vec2(0, 0), 0, 0, 0, 0, PI,
    undefined,
    NEON.purple, rgb(0.3, 0, 0.8),
    rgb(0.5, 0, 1, 0), rgb(0.3, 0, 1, 0),
    1.2, .05, .02, .5, 0,
    .97, 1, 0, PI,
    .2, .3,
    false, true
  );

  // 7. 背景星尘 — 缓慢漂浮
  emitters.stardust = new ParticleEmitter(
    vec2(0, 0), 0, 0, 0, 0, PI,
    undefined,
    rgb(0.3, 0.6, 1, 0.3), rgb(0.5, 0.3, 1, 0.2),
    rgb(0, 0, 0, 0), rgb(0, 0, 0, 0),
    8, .02, 0, .02, 0,
    .99, 1, 0.01, PI,
    .3, .2,
    false, false
  );
  emitters.stardust.renderOrder = -1;
}

/** 在指定位置触发碰撞火花（视口剔除 + 预算 + 移动端缩放） */
function emitSparks(pos, normal) {
  if (!isInView(pos)) return; // 视口外不生成
  emitters.spark.pos = pos.copy();
  emitters.spark.angle = Math.atan2(normal.y, normal.x);
  const count = Math.round(8 * _qualityScale());
  if (_budgetCheck(count)) {
    for (let i = 0; i < count; i++) emitters.spark.emitParticle();
  }
}

/** 在指定位置触发晶体收集爆发（视口剔除 + 预算 + 移动端缩放） */
function emitCollect(pos) {
  if (!isInView(pos)) return; // 视口外不生成
  emitters.collect.pos = pos.copy();
  const count = Math.round(15 * _qualityScale());
  if (_budgetCheck(count)) {
    for (let i = 0; i < count; i++) emitters.collect.emitParticle();
  }
}

/** 在指定位置触发暗礁爆炸（视口剔除 + 预算 + 移动端缩放） */
function emitExplode(pos) {
  if (!isInView(pos)) return; // 视口外不生成
  emitters.explode.pos = pos.copy();
  const count = Math.round(20 * _qualityScale());
  if (_budgetCheck(count)) {
    for (let i = 0; i < count; i++) emitters.explode.emitParticle();
  }
}

/** 触发冲击波（沿运动方向扩散圆环，预算 + 缩放） */
function emitShockwave(pos, dir) {
  if (!isInView(pos, 5)) return; // 视口外不生成
  emitters.shockwave.pos = pos.copy();
  const angle = Math.atan2(dir.y, dir.x);
  const count = Math.round(20 * _qualityScale());
  if (_budgetCheck(count)) {
    for (let i = 0; i < count; i++) {
      const a = angle + (rand(.5) - .25) * Math.PI;
      emitters.shockwave.emitParticle();
    }
  }
}

/** 在光球位置生成尾迹粒子（视口剔除 + 预算） */
function emitTrail(pos) {
  if (!isInView(pos)) return;
  if (!_budgetCheck(1)) return;
  emitters.trail.pos = pos.copy();
  emitters.trail.emitParticle();
}

/** 在光球位置生成外晕粒子（视口剔除 + 预算） */
function emitGlow(pos) {
  if (!isInView(pos)) return;
  if (!_budgetCheck(1)) return;
  emitters.glow.pos = pos.copy();
  emitters.glow.emitParticle();
}

/** 优化版：按需填充背景星尘（移动端缩放） */
function spawnBackgroundDust(cameraPos, viewSize) {
  const target = Math.round(30 * _qualityScale());
  for (let i = 0; i < target; i++) {
    const x = cameraPos.x + rand(viewSize.x * .6) - viewSize.x * .3;
    const y = cameraPos.y + rand(viewSize.y * .6) - viewSize.y * .3;
    emitters.stardust.pos = vec2(x, y);
    emitters.stardust.emitParticle();
  }
}

/** 销毁所有发射器 */
function destroyParticles() {
  for (const key in emitters) {
    emitters[key].destroy();
  }
}
