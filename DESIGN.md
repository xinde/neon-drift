# Neon Drift — 设计理念与维护文档

## 1. 游戏概述

**Neon Drift** 是一款霓虹赛博朋克风格的 2D 迷宫漂移游戏，使用 [LittleJS](https://github.com/KilledByAPixel/LittleJS) 引擎构建，支持手机（陀螺仪）和 PC（键盘）双平台运行。

游戏核心玩法：玩家操控一颗发光光球，在迷宫中收集全部晶体后抵达光门。途中需躲避暗礁，冲击波可清除附近暗礁。

---

## 2. 设计理念

### 2.1 视觉风格
- **霓虹赛博朋克**：深色背景 (#0a0a12) + 高饱和霓虹色（青/品红/黄/绿）
- **发光粒子系统**：7 种粒子发射器（外晕/尾迹/火花/收集/爆炸/冲击波/星尘），全部使用 additive 混合模式产生真实泛光感
- **呼吸动画**：光球带有正弦波脉冲效果，增强生命感
- **视口剔除**：仅渲染屏幕范围内的墙体和物体，减少 overdraw

### 2.2 性能优先
- **自适应质量缩放**：移动端自动降低粒子发射频率和数量
- **低功率模式**：连续 3 帧 FPS < 30 时自动降级（降低粒子发射间隔、增大冷却时间）
- **粒子预算系统**：每帧最多 1500 个粒子，防止性能崩溃
- **移动端参数隔离**：`CONFIG.mobileTrailInterval` / `mobileGlowInterval` 与 PC 端分开配置

### 2.3 控制直觉化
- **陀螺仪优先**：手机端默认使用 DeviceOrientationEvent 倾斜控制，无需任何按键
- **键盘兜底**：桌面端 WASD / 方向键控制，冲击波用空格键
- **摇动触发冲击波**：手机端甩动设备即可触发，无需按键
- **iOS 权限兼容**：iOS 13+ 自动请求 `DeviceOrientationEvent.requestPermission()`

---

## 3. 文件结构

```
littlejs/
├── index.html          # 入口页面，启动画面 UI，启动按钮绑定 startGame()
├── game.js             # 主入口：游戏配置、状态机、输入处理、绘制回调
├── sensor.js           # 陀螺仪/加速度计封装，低通滤波，校准，摇动检测
├── particles.js        # 7 种粒子发射器配置与发射函数
├── littlejs.js         # LittleJS 引擎本地副本 (v1.18.0, 479KB)
└── levels/
    ├── level1.js       # 20x15, 3 晶体, 2 暗礁
    ├── level2.js       # 25x18, 4 晶体, 3 暗礁
    └── level3.js       # 30x20, 5 晶体, 4 暗礁
```

---

## 4. 核心系统

### 4.1 游戏状态机
```
splash → calibrate → play → levelcomplete → win
                  ↘ gameover
```
- `splash`：显示标题，等待点击
- `calibrate`：校准陀螺仪中立位，等待点击确认
- `play`：主游戏循环
- `levelcomplete`：显示过关提示，点击加载下一关
- `win`：全部关卡完成
- `gameover`：生命归零

### 4.2 地图瓦片系统
- 地图以字符串数组存储，每字符代表一个 tile（tileSize=1 世界单位）
- `'0'`=路径 `'1'`=墙体 `'2'`=晶体 `'3'`=暗礁 `'4'`=终点 `'5'`=玩家起点
- 碰撞检测使用 `worldToTile()` 将世界坐标转换为瓦片坐标后查表

### 4.3 粒子发射器（LittleJS ParticleEmitter）
| 发射器 | 用途 | 生命周期 | 混合模式 |
|--------|------|----------|----------|
| glow | 光球外晕 | 0.3s | additive |
| trail | 移动尾迹 | 0.5-1.5s | additive |
| spark | 墙体碰撞 | 0.3s | additive |
| collect | 晶体收集 | 0.5-1s | additive |
| explode | 暗礁爆炸 | 0.6s | normal |
| shockwave | 冲击波 | 1.2s | additive |
| stardust | 背景星尘 | 8s | normal |

### 4.4 传感器输入（sensor.js）
- **低通滤波**：`alpha = 0.25`（移动）/ `0.15`（桌面），平滑传感器噪声
- **死区**：`±3°`，消除漂移和误触
- **归一化向量**：`vec2(gamma/(90-deadzone), beta/180)` 映射到 [-1, 1]
- **摇动检测**：加速度突变 > 15 m/s² 触发冲击波，300ms 冷却
- **校准**：记录当前 beta/gamma 为中立位，解决手机持握角度差异

---

## 5. 关键 API 注意事项（LittleJS 踩坑记录）

| 问题 | 错误用法 | 正确用法 |
|------|----------|----------|
| 鼠标/触摸检测 | `keyWasPressed('mouse0')` | `mouseWasPressed(0)` |
| 空格键检测 | `keyWasPressed(' ')` | `keyWasPressed('Space')` |
| 屏幕文字绘制 | `ctx.fillText()` / `ctx is not defined` | `drawTextScreen()` |
| 屏幕像素尺寸 | `mainCanvasSize`（不存在） | `mainCanvas.width / height` |
| 引擎配置时机 | `canvasMaxSize` 在 `engineInit` 之后 | **必须在 `engineInit` 之前** |
| 随机符号 | `const randSign`（与引擎冲突） | 直接使用 `randSign()`（引擎全局） |
| 虚拟手柄 | `touchGamepadEnable = true`（默认） | `touchGamepadEnable = false` |

---

## 6. 后期维护指南

### 6.1 添加新关卡
1. 在 `levels/` 下创建 `levelN.js`，导出 `LEVEL_N` 对象
2. 在 `game.js` 的 `LEVELS` 数组中添加引用
3. 地图规格参考现有关卡：`width`/`height` + `map` 字符串数组 + `name`/`crystals`/`hazards`

### 6.2 调整粒子效果
- 修改 `particles.js` 中的 `ParticleEmitter` 构造参数
- `colorStart`/`colorEnd`：颜色渐变（支持透明度）
- `sizeStart`/`sizeEnd`：尺寸变化
- `damping`：速度衰减系数（越小扩散越快）
- `additive`：true = 泛光叠加效果

### 6.3 性能调优
- 调整 `CONFIG.particleBudget`（默认 1500）
- 移动端间隔：`CONFIG.mobileTrailInterval` / `mobileGlowInterval`
- 低功率模式触发阈值：`CONFIG.lowPowerThreshold`（默认连续 3 帧 < 30fps）

### 6.4 控制方案修改
- 死区调整：`sensor.js` 中 `deadzone = 3`（度数）
- 滤波强度：`this._filterAlpha/Beta/Gamma`（0.0-1.0，越大越灵敏）
- 摇动阈值：`this._shakeThreshold`（默认 15 m/s²）

### 6.5 部署
- 游戏已部署至 GitHub Pages：https://xinde.github.io/neon-drift/
- 推送 master 分支后自动部署
- **注意**：陀螺仪需要 HTTPS，GitHub Pages 提供 HTTPS 环境

---

## 7. 技术栈

- **引擎**：LittleJS v1.18.0（本地副本，无 CDN 依赖）
- **语言**：原生 JavaScript（ES6+），无构建工具
- **部署**：GitHub Pages（master 分支）
- **设备**：手机（陀螺仪）+ PC（键盘）双平台
- **HTTPS**：必须（陀螺仪权限要求）
