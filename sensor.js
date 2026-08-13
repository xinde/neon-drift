/**
 * SensorInput - 手机传感器封装类
 * 支持 DeviceOrientation / DeviceMotion，兼容 iOS 13+ 权限申请
 * 提供低通滤波、摇动检测、倾斜向量等接口
 */

'use strict';

/** 设备/平台检测（全局共享，供 sensor.js / particles.js / game.js 使用） */
function isMobile() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || ('ontouchstart' in window && window.innerWidth < 1024);
}

class SensorInput {
  constructor() {
    // 方向角 (陀螺仪)
    this.alpha = 0; // Z轴 - 指南针方向 0-360
    this.beta = 0;  // X轴 - 前后倾斜 -180~180
    this.gamma = 0; // Y轴 - 左右倾斜 -90~90

    // 加速度 (含重力)
    this.accX = 0;
    this.accY = 0;
    this.accZ = 0;
    // 加速度幅值（sqrt(x²+y²+z²)），静止时≈9.8，对朝向变化鲁棒
    this._accMag = 9.8;
    this._prevAccMag = 9.8;

    // 加速度计滤波值（用于重力向量倾斜检测，避免 Euler 角万向锁）
    this._filtAccX = 0;
    this._filtAccY = 0;
    this._filtAccZ = 0;
    // 校准参考值
    this._refAccX = 0;
    this._refAccY = 0;
    this._refAccZ = 0;
    // 平台符号约定（iOS: gravity, Android: proper accel = -gravity）
    this._accelSign = 0;
    this._hasAccel = false;

    // 上一帧数据（用于摇动检测）
    this._shakeTime = 0;
    this._shakeCooldown = 0.5; // 冷却 0.5s，避免走路/手抖连续触发
    this._shakeThreshold = 4;  // 幅值变化阈值(m/s²)，幅值法比各轴差值之和小一个量级
    // 心跳：记录最后一次收到 orientation 事件的时间，用于检测 iOS 数据断流
    this._lastOrientTime = 0;
    this._staleTimeout = 0.5;  // 超过 0.5s 无新数据视为断流

    // 低通滤波系数（移动端更高=更灵敏，桌面端更低=更平滑）
    // 优化：原值0.15偏保守，移动端提升至0.35改善响应延迟（跟手度）
    const mobile = isMobile();
    this._filterAlpha = mobile ? 0.35 : 0.15;
    this._filterBeta  = mobile ? 0.35 : 0.15;
    this._filterGamma = mobile ? 0.35 : 0.15;

    // 上一帧滤波值
    this._prevAlpha = 0;
    this._prevBeta = 0;
    this._prevGamma = 0;

    // 参考角度（校准用）
    this._refGamma = 0;
    this._refBeta = 0;
    this._calibrated = false;

    this.enabled = false;

    // 绑定事件处理器引用（确保 add/remove 使用同一函数引用）
    this._boundOnOrientation = (e) => this._onOrientation(e);
    this._boundOnMotion = (e) => this._onMotion(e);
  }

  /** iOS 13+ 请求传感器权限（同时请求 Orientation 和 Motion） */
  async requestPermission() {
    if (!SensorInput.isAvailable()) return false;
    // iOS 13+ 需要显式请求 DeviceOrientation 权限
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          console.warn('[Sensor] iOS orientation permission denied:', perm);
          return false;
        }
        console.log('[Sensor] iOS orientation permission granted');
      } catch (e) {
        console.warn('[Sensor] iOS orientation permission error:', e);
        return false;
      }
    }
    // iOS 13+ 也需要单独请求 DeviceMotion 权限（加速度/摇动检测）
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceMotionEvent.requestPermission();
        if (perm !== 'granted') {
          console.warn('[Sensor] iOS motion permission denied:', perm);
          // orientation 已授权，motion 被拒：仍可用陀螺仪，但摇动检测不可用
        } else {
          console.log('[Sensor] iOS motion permission granted');
        }
      } catch (e) {
        console.warn('[Sensor] iOS motion permission error:', e);
      }
    }
    return true;
  }

  /** 启动传感器监听（仅在设备支持时，可安全重复调用） */
  start() {
    // 防止重复启动
    if (this.enabled) return;
    // 检查设备是否支持传感器事件
    if (typeof DeviceOrientationEvent === 'undefined') {
      console.warn('[Sensor] DeviceOrientationEvent not supported on this device');
      return;
    }
    window.addEventListener('deviceorientation', this._boundOnOrientation, true);
    window.addEventListener('devicemotion', this._boundOnMotion, true);
    this.enabled = true;
    console.log('[Sensor] Started - gamma:', this.gamma, 'beta:', this.beta);
  }

  /** 检查传感器是否可用（需要在 HTTPS 下） */
  static isAvailable() {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      console.warn('[Sensor] DeviceOrientation requires HTTPS (current:', location.protocol, ')');
      return false;
    }
    return true;
  }

  /** 停止传感器监听 */
  stop() {
    window.removeEventListener('deviceorientation', this._boundOnOrientation, true);
    window.removeEventListener('devicemotion', this._boundOnMotion, true);
    this.enabled = false;
  }

  /** 校准当前倾斜为中立位 */
  calibrate() {
    this._refGamma = this.gamma;
    this._refBeta = this.beta;
    // 同时校准加速度计参考值（用于重力向量倾斜检测）
    this._refAccX = this._filtAccX;
    this._refAccY = this._filtAccY;
    this._refAccZ = this._filtAccZ;
    this._calibrated = true;
    console.log('[Sensor] Calibrated - refAcc:', this._refAccX.toFixed(2), this._refAccY.toFixed(2), this._refAccZ.toFixed(2), 'sign:', this._accelSign);
  }

  /** 获取归一化倾斜向量，范围 [-1, 1]
   *  优先使用加速度计重力向量（不受万向锁影响），
   *  回退到 Euler 角（gamma/beta）用于无加速度计数据的设备。
   *  deadzone ±3° */
  getTiltVector() {
    const deadzone = 3;

    // ---- 方式一：加速度计重力向量（推荐，无万向锁）----
    // 竖屏握持时重力主要在 Y 轴（±9.8），Z≈0
    //   右倾：重力出现 +X 分量（iOS）或 -X（Android）
    //   前倾(顶部远离自己)：重力从 Y 向 Z 转移，Z 变化（iOS Z 变负，Android Z 变正）
    // 用差值检测消除初始握持偏差
    if (this._hasAccel) {
      const sign = this._accelSign; // iOS=1(重力为负), Android=-1(重力为正)
      // X: 右倾 -> deltaX > 0 (iOS), < 0 (Android) -> 乘 sign 统一为右倾=+
      const gx = (this._filtAccX - this._refAccX) * sign / 9.8;
      // Z: 前倾 -> deltaZ < 0 (iOS), > 0 (Android) -> 乘 -sign 统一为前倾=+
      const gz = -(this._filtAccZ - this._refAccZ) * sign / 9.8;

      // 死区处理（将角度死区转为加速度比）
      const dz = Math.sin(deadzone * Math.PI / 180);
      let x = gx, y = gz;
      if (Math.abs(x) < dz) x = 0;
      else x -= Math.sign(x) * dz;
      if (Math.abs(y) < dz) y = 0;
      else y -= Math.sign(y) * dz;

      // 归一化到 [-1, 1]（45° 倾斜时 sin≈0.707）
      const scale = 1 / (Math.sin(45 * Math.PI / 180) - dz);
      return vec2(
        clamp(x * scale, -1, 1),
        clamp(y * scale, -1, 1)
      );
    }

    // ---- 方式二：Euler 角回退（无加速度计数据时）----
    let g = this.gamma - this._refGamma;
    let b = this.beta - this._refBeta;

    // 死区处理
    if (Math.abs(g) < deadzone) g = 0;
    else g -= Math.sign(g) * deadzone;

    if (Math.abs(b) < deadzone) b = 0;
    else b -= Math.sign(b) * deadzone;

    return vec2(g / (90 - deadzone), b / (90 - deadzone));
  }

  /** 检测是否发生快速摇动（冲击波触发）
   *  使用加速度幅值变化检测，而非各轴差值之和。
   *  幅值 |a| = sqrt(x²+y²+z²)，静止时≈9.8(重力)且与朝向无关，
   *  因此倾斜手机(朝向变化)不会误触发，只有真实摇晃(线性加速度)才会触发。 */
  checkShake(currentTime) {
    if (!this.enabled) return false;
    if (currentTime - this._shakeTime < this._shakeCooldown) return false;
    const delta = Math.abs(this._accMag - this._prevAccMag);
    if (delta > this._shakeThreshold) {
      this._shakeTime = currentTime;
      return true;
    }
    return false;
  }

  /** 传感器数据是否断流（iOS 某些情况会停止发送 orientation 事件） */
  isStale(currentTime) {
    if (!this.enabled || !this._lastOrientTime) return false;
    return currentTime - this._lastOrientTime > this._staleTimeout;
  }

  _onOrientation(e) {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;
    this._lastOrientTime = time; // 心跳：记录最后一次有效数据时间

    // 修复 alpha 角 0/360° 环绕问题：计算最短角距离
    let dAlpha = e.alpha - this._prevAlpha;
    if (dAlpha > 180) dAlpha -= 360;
    else if (dAlpha < -180) dAlpha += 360;
    this.alpha = this._prevAlpha + dAlpha * this._filterAlpha;

    // 防护 null 值（部分浏览器在锁屏/应用切换时可能发送 null）
    const beta = e.beta ?? this._prevBeta;
    const gamma = e.gamma ?? this._prevGamma;

    this.beta  = this._filterBeta  * beta  + (1 - this._filterBeta)  * this._prevBeta;
    this.gamma = this._filterGamma * gamma + (1 - this._filterGamma) * this._prevGamma;
    this._prevAlpha = this.alpha;
    this._prevBeta  = this.beta;
    this._prevGamma = this.gamma;
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    this._prevAccMag = this._accMag;
    this.accX = a.x || 0;
    this.accY = a.y || 0;
    this.accZ = a.z || 0;
    this._accMag = Math.sqrt(this.accX * this.accX + this.accY * this.accY + this.accZ * this.accZ);

    // 低通滤波加速度计（用于倾斜检测，避免 Euler 角万向锁）
    if (!this._hasAccel) {
      // 首帧直接初始化
      this._filtAccX = this.accX;
      this._filtAccY = this.accY;
      this._filtAccZ = this.accZ;
      this._hasAccel = true;
      // 检测平台符号约定：
      // W3C 规范：静止平放时 accZ≈+9.8（Android 遵循）
      // iOS Safari：静止平放时 accZ≈-9.8（与规范相反）
      // 竖屏握持时 accZ≈0，改用重力主轴（Y）检测
      const gravVal = Math.abs(this.accY) >= Math.abs(this.accZ) ? this.accY : this.accZ;
      this._accelSign = gravVal < 0 ? 1 : -1; // iOS=1(负重力), Android=-1(正重力)
    } else {
      const fa = this._filterAlpha; // 复用已有的滤波系数
      this._filtAccX = fa * this.accX + (1 - fa) * this._filtAccX;
      this._filtAccY = fa * this.accY + (1 - fa) * this._filtAccY;
      this._filtAccZ = fa * this.accZ + (1 - fa) * this._filtAccZ;
    }
  }
}
