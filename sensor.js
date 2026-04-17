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

    // 上一帧数据（用于摇动检测）
    this._prevAccX = 0;
    this._prevAccY = 0;
    this._prevAccZ = 0;
    this._shakeTime = 0;
    this._shakeCooldown = 0.3; // 秒内不重复触发
    this._shakeThreshold = 15; // m/s² 突变阈值

    // 低通滤波系数（移动端更高=更灵敏，桌面端更低=更平滑）
    // 优化：原值0.15偏保守，移动端提升至0.25改善响应延迟
    const mobile = isMobile();
    this._filterAlpha = mobile ? 0.25 : 0.15;
    this._filterBeta  = mobile ? 0.25 : 0.15;
    this._filterGamma = mobile ? 0.25 : 0.15;

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
    this._calibrated = true;
  }

  /** 获取归一化倾斜向量，范围 [-1, 1]
   *  deadzone ±3° */
  getTiltVector() {
    const deadzone = 3;
    let g = this.gamma - this._refGamma;
    let b = this.beta - this._refBeta;

    // 死区处理：朝零方向收缩，超出死区后重新归一化
    if (Math.abs(g) < deadzone) g = 0;
    else g -= Math.sign(g) * deadzone;

    if (Math.abs(b) < deadzone) b = 0;
    else b -= Math.sign(b) * deadzone;

    return vec2(g / (90 - deadzone), b / 180);
  }

  /** 检测是否发生快速摇动（冲击波触发） */
  checkShake(currentTime) {
    if (!this.enabled) return false;
    if (currentTime - this._shakeTime < this._shakeCooldown) return false;

    const deltaX = Math.abs(this.accX - this._prevAccX);
    const deltaY = Math.abs(this.accY - this._prevAccY);
    const deltaZ = Math.abs(this.accZ - this._prevAccZ);
    const totalDelta = deltaX + deltaY + deltaZ;

    if (totalDelta > this._shakeThreshold) {
      this._shakeTime = currentTime;
      return true;
    }
    return false;
  }

  _onOrientation(e) {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;

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
    this._prevAccX = this.accX;
    this._prevAccY = this.accY;
    this._prevAccZ = this.accZ;
    this.accX = a.x || 0;
    this.accY = a.y || 0;
    this.accZ = a.z || 0;
  }
}
