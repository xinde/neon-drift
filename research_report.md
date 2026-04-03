# LittleJS-AI 与手机传感器能力调研报告

## 一、LittleJS-AI 核心功能

### 1.1 基本情况
- **仓库**: github.com/KilledByAPixel/LittleJS-AI (27 stars, MIT license)
- **定位**: LittleJS AI 实验与游戏库，包括 AI 辅助生成的游戏、启动模板和 AI 编码文档
- **配套引擎**: LittleJS 主引擎 (4059 stars)，轻量级高性能 HTML5 游戏引擎，无依赖

### 1.2 粒子系统 (engineParticles.js)
LittleJS 内置功能完整的粒子系统：

**ParticleEmitter 类** - 粒子发射器，核心参数：
- emitRate: 每秒发射粒子数
- emitConeAngle: 发射锥角
- particleTime/sizeStart/sizeEnd: 粒子生命周期和大小变化
- colorStartA/B 到 colorEndA/B: 颜色渐变（支持线性插值）
- damping/gravityScale: 物理模拟（阻尼、重力系数）
- additive: 加法混合（霓虹发光效果）
- trailScale: 拖尾效果（速度方向拉伸）
- collideTiles: 粒子与瓦片碰撞检测
- localSpace: 局部空间模式
- velocityInheritance: 继承发射器速度
- particleCreateCallback/particleDestroyCallback/particleCollideCallback

**Particle 类** - 单个粒子对象，包含 pos, velocity, angle, size, color, lifeTime 等属性

**官方工具**: 可视化粒子编辑器 https://killedbyapixel.github.io/LittleJS/examples/particles/

### 1.3 输入系统 (engineInput.js)
- 键盘 (keyIsDown/keyWasPressed/keyWasReleased)
- 鼠标 (mousePos 世界坐标/mousePosScreen 屏幕坐标/mouseDelta)
- 游戏手柄 (gamepadPrimary, 多手柄支持)
- **触摸设备**: isTouchDevice 自动检测，内置虚拟游戏手柄

**关键**: LittleJS 内置输入系统**不包含** DeviceOrientation/陀螺仪/加速度计 API 支持，需自行封装。

### 1.4 LittleJS-AI 仓库特色
- 提供多个 AI 辅助生成的游戏示例（俄罗斯方块、太空侵略者、迷你高尔夫等）
- AI 文件夹含 littlejs.js 包装器、教程、参考文档
- 配套 ChatGPT 插件可无代码生成游戏

---

## 二、手机传感器 Web API 调研

### 2.1 DeviceOrientationEvent（方向传感器）
监听设备在地球坐标系中的旋转角度：

```javascript
window.addEventListener("deviceorientation", (event) => {
  const alpha = event.alpha; // Z轴旋转 0-360°（指南针方向）
  const beta  = event.beta;  // X轴旋转 -180~180°（前后倾斜）
  const gamma = event.gamma; // Y轴旋转 -90~90°（左右倾斜）
});
```

- **精度**: 由磁力计提供，绝对方向参考
- **用途**: 角色朝向、视角倾斜、赛车方向盘控制

### 2.2 DeviceMotionEvent（加速度计/陀螺仪）
监听设备加速度和旋转速率：

```javascript
window.addEventListener("devicemotion", (event) => {
  const acc = event.accelerationIncludingGravity; // 含重力加速度
  const rotRate = event.rotationRate;  // 旋转速率 (°/s)
});
```

- **用途**: 摇晃检测、弹珠迷宫倾斜控制、计步

### 2.3 Sensor APIs（现代标准）
提供更精确一致的传感器访问：
- `Accelerometer` / `LinearAccelerationSensor`
- `Gyroscope`
- `AbsoluteOrientationSensor` / `RelativeOrientationSensor` (四元数输出)
- `Magnetometer`

```javascript
navigator.permissions.query({ name: "accelerometer" });
const sensor = new RelativeOrientationSensor();
sensor.start();
```

### 2.4 iOS 权限要求（重要）
- **iOS 13+**: 必须通过 `DeviceOrientationEvent.requestPermission()` 申请用户授权
- **Safari**: 需要用户手势触发（点击按钮授权）
- **Android**: Chrome/Firefox 通常开箱即用
- **HTTPS 是必须的**（安全上下文要求）

---

## 三、LittleJS 集成传感器方案建议

### 3.1 封装为 LittleJS 插件（约 50-100 行）

```javascript
class SensorInput {
  constructor() {
    this.alpha = 0; this.beta = 0; this.gamma = 0;
    this.accX = 0; this.accY = 0; this.accZ = 0;
    this.enabled = false;
  }

  async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      return permission === 'granted';
    }
    return true; // 非 iOS
  }

  start() {
    window.addEventListener('deviceorientation', (e) => {
      this.alpha = e.alpha; this.beta = e.beta; this.gamma = e.gamma;
    });
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (a) { this.accX = a.x; this.accY = a.y; this.accZ = a.z; }
    });
    this.enabled = true;
  }

  // 归一化倾斜向量，范围 [-1, 1]
  getTiltVector() {
    return vec2(this.gamma / 90, this.beta / 180);
  }
}
```

### 3.2 粒子系统与传感器结合
- **陀螺仪控制粒子发射方向**: 用 alpha/gamma 控制 ParticleEmitter.angle
- **加速度触发粒子爆发**: 检测加速度突变触发 burst 粒子效果
- **倾斜控制粒子重力场**: 用 beta/gamma 控制 gravityScale 方向，实现"弹珠"效果
- **拖尾粒子+传感器**: 设备旋转时生成方向拖尾粒子轨迹
- **碰撞粒子**: 粒子与瓦片碰撞时触发粒子爆发（火花效果）

---

## 四、游戏概念方向推荐

### 4.1 最佳适配方向

| 方向 | 传感器 | 说明 |
|------|--------|------|
| **弹珠迷宫** | 加速度计 | 手机倾斜控制小球，粒子表现碰撞火花/尘埃 |
| **体感射击** | 陀螺仪 | 倾斜手机瞄准，粒子枪焰和爆炸效果 |
| **宇宙航行** | 陀螺仪+加速度 | 飞行器方向控制+引擎粒子喷射 |
| **节奏游戏** | 加速度计 | 摇晃手机触发节拍粒子爆发 |
| **陀螺仪赛车** | 陀螺仪 | 倾斜控制方向盘，轮胎粒子+速度线 |

### 4.2 推荐首发游戏方向
**弹珠迷宫 + 霓虹粒子视觉风格**
- 门槛低（经典玩法认知度高）
- 传感器控制直观自然（倾斜=物理直觉）
- 粒子效果丰富（金属球碰撞火花、环境尘埃、重力场可视化）
- 适合展示 LittleJS 粒子系统与手机传感器的深度集成

### 4.3 关键技术要点
1. 传感器初始化必须在用户交互回调中（iOS 要求）
2. 提供"权限申请"按钮，优雅降级到触摸/虚拟按键
3. 粒子效果使用 additive 混合模式获得霓虹发光感
4. trailScale 粒子可表现运动轨迹
5. 传感器数据建议做低通滤波平滑处理，避免抖动

---

## 五、结论

LittleJS 粒子系统功能完整但**原生不包含**手机传感器支持，需要约 50-100 行代码自行封装 DeviceOrientationEvent/DeviceMotionEvent。传感器 API 已广泛支持（iOS 13+/Android 5+），只需处理 iOS 的权限请求即可。

**推荐首发游戏概念**: 弹珠迷宫 + 霓虹粒子视觉风格
