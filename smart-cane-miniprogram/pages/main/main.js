// 智能拐杖主页面 - 老人端和亲属端合并，蓝牙持续连接
const app = getApp()

const SERVICE_UUID_FILTER = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";

// 警报音频上下文
let alarmAudioContext = null;

Page({
  data: {
    currentTab: 'elder', // elder 或 family
    
    // ============ 老人端数据 ============
    connected: false,
    scanning: false,
    isFall: false,
    isGaitAlert: false,  // 步态异常警报
    alertType: '',       // 警报类型: 'fall' 或 'gait'
    alertTime: '',       // 警报触发时间
    eventMessage: '',
    deviceId: '',
    serviceId: '',
    characteristicId: '',
    log: '准备就绪',
    bindingCode: '',
    
    // 步态数据
    gaitData: {
      stepFreq: '0.0',
      instability: '0',
      score: 100,
      status: '正常',
      riskLevel: 'normal'
    },
    stepCount: 0,
    gaitEnabled: false,
    obstacleEnabled: false,
    obstacleCount: 0,
    
    // ============ 亲属端数据 ============
    elderOnline: false,
    remoteStatus: 'normal',
    lastUpdateTime: '--',
    gaitStatus: '正常',
    obstacleStatus: '安全',
    heartRateStatus: '正常',
    batteryStatus: '充足',
    
    // 亲属端步态数据
    familyStepCount: 0,
    familyGaitScore: 100,
    familyStepFreq: '0.0',
    familyInstability: '0',
    familyObstacleCount: 0,
    familyRiskLevel: 'normal',
    
    // 亲属端警报状态
    familyIsFall: false,
    familyIsGaitAlert: false,
    familyAlertType: '',
    familyAlertTime: '',
    familyEventMessage: '',
    familyGaitStatus: '正常',
    
    // 历史评分记录
    scoreHistory: [],
    showHistory: false,
    todayScoreCount: 0,
    averageScore: 100,
    
    // AI 助手
    analyzing: false,
    asking: false,
    aiResult: '',
    userQuestion: '',
    chatHistory: []
  },

  onLoad() {
    // 生成绑定码
    let code = wx.getStorageSync('elderBindingCode');
    if (!code) {
      code = Math.random().toString().slice(2, 8);
      wx.setStorageSync('elderBindingCode', code);
    }
    this.setData({ bindingCode: code });
    
    // 加载历史评分记录
    this.loadScoreHistory();
    
    // 初始化蓝牙
    wx.openBluetoothAdapter({
      success: () => {
        this.addLog('蓝牙初始化成功');
        // 监听蓝牙连接状态变化
        this.setupBLEListeners();
      },
      fail: (err) => {
        if (err.errCode === 10001) {
          wx.showModal({ title: '提示', content: '请打开手机蓝牙', showCancel: false });
        }
        this.addLog('蓝牙初始化失败: ' + err.errMsg);
      }
    });
    
    // 启动心跳和数据同步
    this.startHeartbeat();
    this.startDataSync();
  },

  // 设置蓝牙监听器
  setupBLEListeners() {
    // 监听蓝牙适配器状态变化
    wx.onBluetoothAdapterStateChange((res) => {
      if (!res.available) {
        this.addLog('蓝牙被关闭');
        this.setData({ connected: false, elderOnline: false });
      }
    });
    
    // 监听蓝牙连接状态变化 (断开检测)
    wx.onBLEConnectionStateChange((res) => {
      if (!res.connected) {
        this.addLog('设备连接已断开');
        this.setData({ 
          connected: false, 
          elderOnline: false,
          gaitEnabled: false,
          obstacleEnabled: false
        });
        wx.showToast({ title: '设备已断开', icon: 'none' });
      }
    });
  },

  onUnload() {
    // 页面卸载时停止警报和断开连接
    this.stopAlarmSound();
    this.disconnect();
    wx.closeBluetoothAdapter();
    this.stopHeartbeat();
    this.stopDataSync();
  },

  // Tab 切换
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ currentTab: tab });
    
    if (tab === 'family') {
      // 切换到亲属端时刷新数据
      this.refreshFamilyData();
    }
  },

  addLog(str) {
    console.log('[BLE]', str);
    const time = new Date().toLocaleTimeString();
    let log = this.data.log + '\n[' + time + '] ' + str;
    if (log.length > 800) log = log.slice(-800);
    this.setData({ log });
  },

  // ============ 蓝牙连接 ============
  startScan() {
    this.addLog('开始搜索设备...');
    this.setData({ scanning: true });
    
    // 设置15秒超时
    this.scanTimer = setTimeout(() => {
      if (!this.data.connected) {
        wx.stopBluetoothDevicesDiscovery();
        this.setData({ scanning: false });
        this.addLog('搜索超时，未找到设备');
        wx.showToast({ title: '未找到设备', icon: 'none' });
      }
    }, 15000);
    
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: () => {
        wx.onBluetoothDeviceFound((res) => {
          res.devices.forEach(device => {
            // 匹配设备名: Smart_Cane_ESP32
            if (device.name && (
              device.name.includes('Smart_Cane') ||
              device.name.includes('ESP32') ||
              device.name.includes('Cane') ||
              device.name.includes('Smart')
            )) {
              this.addLog('发现设备: ' + device.name);
              wx.stopBluetoothDevicesDiscovery();
              clearTimeout(this.scanTimer);
              this.setData({ scanning: false });
              this.connectDevice(device.deviceId);
            }
          });
        });
      },
      fail: (err) => {
        this.setData({ scanning: false });
        clearTimeout(this.scanTimer);
        this.addLog('搜索失败: ' + err.errMsg);
        wx.showToast({ title: '搜索失败', icon: 'none' });
      }
    });
  },

  connectDevice(deviceId) {
    this.addLog('正在连接...');
    wx.createBLEConnection({
      deviceId,
      timeout: 10000,
      success: () => {
        this.setData({ connected: true, deviceId, elderOnline: true });
        this.addLog('✅ 连接成功');
        wx.showToast({ title: '连接成功', icon: 'success' });
        setTimeout(() => this.getServices(deviceId), 1000);
      },
      fail: (err) => {
        this.addLog('连接失败: ' + err.errMsg);
        wx.showToast({ title: '连接失败', icon: 'none' });
        this.setData({ connected: false });
      }
    });
  },

  getServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId,
      success: (res) => {
        const targetService = res.services.find(s =>
          s.uuid.toUpperCase().includes('6E400001')
        );
        if (targetService) {
          this.setData({ serviceId: targetService.uuid });
          this.getCharacteristics(deviceId, targetService.uuid);
        } else {
          this.addLog('未找到服务');
        }
      }
    });
  },

  getCharacteristics(deviceId, serviceId) {
    wx.getBLEDeviceCharacteristics({
      deviceId, serviceId,
      success: (res) => {
        const notifyChar = res.characteristics.find(c => c.properties.notify);
        if (notifyChar) {
          this.setData({ characteristicId: notifyChar.uuid });
          this.enableNotify(deviceId, serviceId, notifyChar.uuid);
        }
      }
    });
  },

  enableNotify(deviceId, serviceId, characteristicId) {
    wx.notifyBLECharacteristicValueChange({
      state: true, deviceId, serviceId, characteristicId,
      success: () => {
        this.addLog('监听已开启');
        wx.onBLECharacteristicValueChange((res) => {
          this.handleBLEData(res.value);
        });
      }
    });
  },

  // 处理蓝牙数据
  handleBLEData(buffer) {
    let str = '';
    const view = new DataView(buffer);
    for (let i = 0; i < buffer.byteLength; i++) {
      str += String.fromCharCode(view.getUint8(i));
    }
    
    // 去掉首尾空白字符
    str = str.trim();
    
    console.log('收到:', str);
    this.addLog('← ' + str);
    
    // 解析数据 - 匹配 final_improved.ino 的所有协议
    
    // 1. STEP:N - 步数更新
    if (str.startsWith('STEP:')) {
      const count = parseInt(str.replace('STEP:', ''));
      if (!isNaN(count)) {
        this.setData({ stepCount: count });
        this.syncToFamily({ stepCount: count });
      }
    }
    // 2. GAIT_DETAIL:间隔ms,步频spm,波动% - 步态详情
    else if (str.startsWith('GAIT_DETAIL:')) {
      const parts = str.replace('GAIT_DETAIL:', '').split(',');
      if (parts.length >= 3) {
        const interval = parseInt(parts[0]);   // 步间隔 ms
        const freq = parseFloat(parts[1]);     // 步频 步/分
        const instability = parseFloat(parts[2]); // 波动性 %
        
        if (!isNaN(freq) && !isNaN(instability)) {
          let score = 100;
          let status = '正常';
          let riskLevel = 'normal';
          
          // 步频评估
          if (freq < 50) { 
            score -= 30; 
            status = '步速过慢'; 
            riskLevel = 'warning'; 
          } else if (freq > 140) { 
            score -= 40; 
            status = '碎步'; 
            riskLevel = 'danger'; 
          } else if (freq < 60 || freq > 120) {
            score -= 10;
            if (status === '正常') status = '稍异常';
          }
          
          // 波动性评估
          if (instability > 35) { 
            score -= 50; 
            status = '步态不稳'; 
            riskLevel = 'danger'; 
          } else if (instability > 25) { 
            score -= 30; 
            if (riskLevel !== 'danger') riskLevel = 'warning'; 
            if (status === '正常' || status === '稍异常') status = '较不稳';
          } else if (instability > 15) { 
            score -= 10; 
          }
          
          score = Math.max(0, score);
          
          this.setData({
            'gaitData.stepFreq': freq.toFixed(1),
            'gaitData.instability': instability.toFixed(1),
            'gaitData.score': score,
            'gaitData.status': status,
            'gaitData.riskLevel': riskLevel
          });
          
          // 每次评分变化时保存历史记录
          this.saveScoreRecord(score, freq.toFixed(1), instability.toFixed(1));
          
          this.syncToFamily({
            stepFreq: freq.toFixed(1),
            instability: instability.toFixed(1),
            score, status, riskLevel
          });
        }
      }
    }
    // 3. GAIT_DATA:Hz,规律性,波动率,评分 - 步态汇总 (备用格式)
    else if (str.startsWith('GAIT_DATA:')) {
      const parts = str.replace('GAIT_DATA:', '').split(',');
      if (parts.length >= 4) {
        const freqHz = parseFloat(parts[0]);
        const regularity = parseFloat(parts[1]);
        const instabilityRatio = parseFloat(parts[2]);
        const score = parseInt(parts[3]);
        
        if (!isNaN(freqHz) && !isNaN(score)) {
          const freqSpm = freqHz * 60; // 转换为 步/分
          const instability = instabilityRatio * 100; // 转换为百分比
          
          this.setData({
            'gaitData.stepFreq': freqSpm.toFixed(1),
            'gaitData.instability': instability.toFixed(1),
            'gaitData.score': score,
            'gaitData.riskLevel': score >= 80 ? 'normal' : (score >= 60 ? 'warning' : 'danger')
          });
          
          // 保存历史评分
          this.saveScoreRecord(score, freqSpm.toFixed(1), instability.toFixed(1));
        }
      }
    }
    // 4. ALARM:FALL - 跌倒报警
    else if (str === 'ALARM:FALL') {
      this.triggerFallAlarm();
    }
    // 5. ALARM:OBS - 障碍物报警
    else if (str === 'ALARM:OBS') {
      const count = this.data.obstacleCount + 1;
      this.setData({ obstacleCount: count });
      wx.vibrateShort({ type: 'medium' });
      this.syncToFamily({ obstacleCount: count });
    }
    // 6. MODE:xxx - 模式切换
    else if (str.startsWith('MODE:')) {
      const mode = str.replace('MODE:', '');
      if (mode === 'GAIT_ON') {
        this.setData({ gaitEnabled: true });
        this.addLog('✅ 步态检测已开启');
        wx.showToast({ title: '步态检测开启', icon: 'success' });
      }
      else if (mode === 'GAIT_OFF') {
        this.setData({ gaitEnabled: false });
        this.addLog('⏹ 步态检测已关闭');
        wx.showToast({ title: '步态检测关闭', icon: 'none' });
      }
      else if (mode === 'OBS_ON') {
        this.setData({ obstacleEnabled: true });
        this.addLog('✅ 避障模式已开启');
        wx.showToast({ title: '避障模式开启', icon: 'success' });
      }
      else if (mode === 'OBS_OFF') {
        this.setData({ obstacleEnabled: false });
        this.addLog('⏹ 避障模式已关闭');
        wx.showToast({ title: '避障模式关闭', icon: 'none' });
      }
    }
    // 7. GAIT_RISK:xxx - 步态风险警告 
    // final (1).ino 发送中文，可能有乱码，做容错处理
    else if (str.startsWith('GAIT_RISK:')) {
      const riskRaw = str.replace('GAIT_RISK:', '').trim();
      
      // 根据关键词判断风险类型并显示标准文本
      let riskText = '';
      let riskLevel = 'danger';
      
      // 匹配中文或乱码后的关键特征
      if (riskRaw.includes('慢') || riskRaw.includes('肌力') || riskRaw.toLowerCase().includes('slow')) {
        riskText = '步速过慢 - 需关注肌力';
      } else if (riskRaw.includes('快') || riskRaw.includes('慌张') || riskRaw.toLowerCase().includes('fast')) {
        riskText = '步速过快 - 慌张步态风险';
      } else if (riskRaw.includes('紊乱') || riskRaw.includes('跌倒') || riskRaw.toLowerCase().includes('unstable')) {
        riskText = '步律紊乱 - 跌倒风险高！';
      } else {
        // 如果无法识别，显示简短警告
        riskText = '步态异常警告';
      }
      
      // 触发步态异常警报
      this.triggerGaitAlarm(riskText);
    }
  },

  // ============ 警报系统 ============
  
  // 跌倒警报
  triggerFallAlarm() {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    
    this.setData({ 
      isFall: true, 
      isGaitAlert: false,
      alertType: 'fall',
      alertTime: timeStr,
      eventMessage: '🚨 跌倒检测警报！检测到老人可能跌倒！请立即确认安全！',
      remoteStatus: 'fall'
    });
    
    this.addLog('🚨 跌倒警报触发！');
    
    // 播放警报铃声
    this.playAlarmSound('fall');
    
    // 连续震动提醒
    wx.vibrateLong();
    this.vibrateTimer = setInterval(() => {
      if (this.data.isFall) {
        wx.vibrateLong();
      } else {
        clearInterval(this.vibrateTimer);
      }
    }, 1500);
    
    this.syncToFamily({ status: 'fall', type: 'fall' });
  },
  
  // 步态异常警报
  triggerGaitAlarm(riskText) {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    
    this.setData({ 
      isGaitAlert: true,
      alertType: 'gait',
      alertTime: timeStr,
      eventMessage: '⚠️ 步态异常：' + riskText,
      'gaitData.status': riskText, 
      'gaitData.riskLevel': 'danger'
    });
    
    this.addLog('⚠️ 步态异常警报: ' + riskText);
    
    // 播放警报铃声
    this.playAlarmSound('gait');
    
    // 震动提醒
    wx.vibrateShort({ type: 'heavy' });
    
    this.syncToFamily({ gaitRisk: riskText, riskLevel: 'danger' });
  },
  
  // 播放警报铃声
  playAlarmSound(type) {
    // 停止之前的警报音
    this.stopAlarmSound();
    
    // 创建音频上下文
    alarmAudioContext = wx.createInnerAudioContext();
    alarmAudioContext.obeyMuteSwitch = false; // 忽略静音开关
    
    // 使用网络警报音频
    if (type === 'fall') {
      // 跌倒警报 - 急促连续
      alarmAudioContext.src = 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';
      alarmAudioContext.loop = true;
    } else {
      // 步态警报 - 提示性
      alarmAudioContext.src = 'https://assets.mixkit.co/active_storage/sfx/1084/1084-preview.mp3';
      alarmAudioContext.loop = false;
    }
    
    alarmAudioContext.play();
    
    // 如果网络音频失败，使用系统震动代替
    alarmAudioContext.onError(() => {
      console.log('音频播放失败，使用震动代替');
    });
  },
  
  // 停止警报铃声
  stopAlarmSound() {
    if (alarmAudioContext) {
      alarmAudioContext.stop();
      alarmAudioContext.destroy();
      alarmAudioContext = null;
    }
    if (this.vibrateTimer) {
      clearInterval(this.vibrateTimer);
      this.vibrateTimer = null;
    }
  },
  
  // 解除警报
  dismissAlarm() {
    const alertType = this.data.alertType;
    
    this.stopAlarmSound();
    
    this.setData({ 
      isFall: false, 
      isGaitAlert: false,
      alertType: '',
      eventMessage: '',
      remoteStatus: 'normal'
    });
    
    // 如果是步态警报解除，恢复步态状态为正常
    if (alertType === 'gait') {
      this.setData({
        'gaitData.status': '正常',
        'gaitData.riskLevel': 'normal'
      });
    }
    
    this.addLog('✅ 警报已解除');
    wx.showToast({ title: '警报已解除', icon: 'success' });
    
    this.syncToFamily({ status: 'normal' });
  },

  disconnect() {
    this.stopAlarmSound();
    if (this.data.deviceId) {
      wx.closeBLEConnection({
        deviceId: this.data.deviceId,
        complete: () => {
          this.setData({ 
            connected: false, 
            isFall: false,
            isGaitAlert: false,
            gaitEnabled: false,
            obstacleEnabled: false,
            elderOnline: false
          });
          this.addLog('已断开连接');
          wx.showToast({ title: '已断开', icon: 'none' });
        }
      });
    }
  },

  // 重置步态数据
  resetGaitData() {
    this.setData({
      stepCount: 0,
      obstacleCount: 0,
      'gaitData.stepFreq': '0.0',
      'gaitData.instability': '0',
      'gaitData.score': 100,
      'gaitData.status': '正常',
      'gaitData.riskLevel': 'normal'
    });
    this.addLog('数据已重置');
    wx.showToast({ title: '数据已重置', icon: 'success' });
  },

  // 清空日志
  clearLog() {
    this.setData({ log: '日志已清空' });
  },

  // ============ 数据同步 ============
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const data = {
        bindingCode: this.data.bindingCode,
        isOnline: true,
        lastHeartbeat: Date.now(),
        connected: this.data.connected
      };
      wx.setStorageSync('heartbeat_' + this.data.bindingCode, data);
    }, 5000);
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },

  syncToFamily(data) {
    // 同步数据到本地存储，亲属端视图可以读取
    const key = 'elder_realtime_' + this.data.bindingCode;
    const current = wx.getStorageSync(key) || {};
    const syncData = { ...current, ...data, updateTime: Date.now() };
    wx.setStorageSync(key, syncData);
    
    // 如果当前在亲属端视图，立即更新亲属端警报状态
    if (this.data.currentTab === 'family') {
      this.updateFamilyAlertStatus(syncData);
    }
  },
  
  // 更新亲属端警报状态
  updateFamilyAlertStatus(data) {
    if (data.type === 'fall') {
      this.setData({
        familyIsFall: true,
        familyIsGaitAlert: false,
        familyAlertType: 'fall',
        familyAlertTime: this.formatTime(Date.now()),
        familyEventMessage: '🚨 老人可能跌倒！请立即联系确认安全！'
      });
    } else if (data.gaitRisk) {
      this.setData({
        familyIsFall: false,
        familyIsGaitAlert: true,
        familyAlertType: 'gait',
        familyAlertTime: this.formatTime(Date.now()),
        familyEventMessage: '⚠️ 步态异常：' + data.gaitRisk,
        familyGaitStatus: data.gaitRisk
      });
    } else if (data.status === 'normal') {
      this.setData({
        familyIsFall: false,
        familyIsGaitAlert: false,
        familyAlertType: '',
        familyEventMessage: '',
        familyGaitStatus: '正常'
      });
    }
  },
  
  // 亲属端解除警报
  dismissFamilyAlarm() {
    this.stopAlarmSound();
    
    this.setData({
      familyIsFall: false,
      familyIsGaitAlert: false,
      familyAlertType: '',
      familyEventMessage: '',
      remoteStatus: 'normal',
      familyGaitStatus: '正常'
    });
    
    // 同步解除到老人端
    const key = 'elder_realtime_' + this.data.bindingCode;
    wx.setStorageSync(key, { status: 'normal', updateTime: Date.now() });
    
    wx.showToast({ title: '警报已解除', icon: 'success' });
  },

  startDataSync() {
    this.dataSyncTimer = setInterval(() => {
      this.refreshFamilyData();
    }, 3000);
  },

  stopDataSync() {
    if (this.dataSyncTimer) {
      clearInterval(this.dataSyncTimer);
      this.dataSyncTimer = null;
    }
  },

  refreshFamilyData() {
    const code = this.data.bindingCode;
    
    // 检查心跳
    const heartbeat = wx.getStorageSync('heartbeat_' + code);
    if (heartbeat) {
      const isOnline = heartbeat.isOnline && (Date.now() - heartbeat.lastHeartbeat < 15000);
      this.setData({ elderOnline: isOnline });
    }
    
    // 获取实时数据
    const realtime = wx.getStorageSync('elder_realtime_' + code);
    if (realtime) {
      // 更新基础数据
      this.setData({
        remoteStatus: realtime.status || 'normal',
        lastUpdateTime: realtime.updateTime ? this.formatTime(realtime.updateTime) : '--',
        familyStepCount: realtime.stepCount || this.data.stepCount,
        familyStepFreq: realtime.stepFreq || this.data.gaitData.stepFreq,
        familyInstability: realtime.instability || this.data.gaitData.instability,
        familyGaitScore: realtime.score || this.data.gaitData.score,
        familyRiskLevel: realtime.riskLevel || 'normal',
        familyObstacleCount: realtime.obstacleCount || this.data.obstacleCount,
        gaitStatus: realtime.status === 'fall' ? '异常' : (realtime.riskLevel === 'danger' ? '异常' : '正常')
      });
      
      // 更新亲属端警报状态
      this.updateFamilyAlertStatus(realtime);
    } else {
      // 没有存储数据时，直接用当前页面的数据
      this.setData({
        familyStepCount: this.data.stepCount,
        familyStepFreq: this.data.gaitData.stepFreq,
        familyInstability: this.data.gaitData.instability,
        familyGaitScore: this.data.gaitData.score,
        familyRiskLevel: this.data.gaitData.riskLevel,
        familyObstacleCount: this.data.obstacleCount
      });
      
      // 同步老人端警报状态到亲属端
      if (this.data.isFall) {
        this.setData({
          familyIsFall: true,
          familyAlertType: 'fall',
          familyAlertTime: this.data.alertTime,
          familyEventMessage: this.data.eventMessage
        });
      } else if (this.data.isGaitAlert) {
        this.setData({
          familyIsGaitAlert: true,
          familyAlertType: 'gait',
          familyAlertTime: this.data.alertTime,
          familyEventMessage: this.data.eventMessage
        });
      }
    }
  },

  formatTime(ts) {
    const d = new Date(ts);
    const pad = n => n < 10 ? '0' + n : n;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  // ============ 历史评分功能 ============
  
  // 加载历史评分
  loadScoreHistory() {
    const history = wx.getStorageSync('gait_score_history') || [];
    const today = new Date().toDateString();
    const todayRecords = history.filter(r => new Date(r.timestamp).toDateString() === today);
    const avgScore = todayRecords.length > 0 
      ? Math.round(todayRecords.reduce((sum, r) => sum + r.score, 0) / todayRecords.length)
      : 100;
    
    this.setData({
      scoreHistory: history.slice(-50), // 保留最近50条
      todayScoreCount: todayRecords.length,
      averageScore: avgScore
    });
  },
  
  // 保存评分记录
  saveScoreRecord(score, stepFreq, instability) {
    const history = wx.getStorageSync('gait_score_history') || [];
    const record = {
      id: Date.now(),
      timestamp: Date.now(),
      time: this.formatTime(Date.now()),
      date: new Date().toLocaleDateString('zh-CN'),
      score: score,
      stepFreq: stepFreq,
      instability: instability,
      riskLevel: score >= 80 ? 'normal' : (score >= 60 ? 'warning' : 'danger')
    };
    
    history.push(record);
    
    // 最多保留100条记录
    if (history.length > 100) {
      history.shift();
    }
    
    wx.setStorageSync('gait_score_history', history);
    this.loadScoreHistory();
  },
  
  // 切换历史记录显示
  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },
  
  // 清空历史记录
  clearHistory() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有历史评分记录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('gait_score_history');
          this.setData({
            scoreHistory: [],
            todayScoreCount: 0,
            averageScore: 100
          });
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  // ============ AI 健康助手 ============
  
  // DeepSeek API 配置
  DEEPSEEK_API_KEY: 'sk-095082e3bd7743ac8ba4c990de8f8d9a',
  
  // 生成健康报告
  analyzeHealth() {
    this.setData({ analyzing: true, aiResult: '' });
    
    // 构建详细的健康数据
    const healthData = {
      status: this.data.remoteStatus === 'fall' ? '发生跌倒' : '正常',
      stepCount: this.data.familyStepCount || this.data.stepCount,
      stepFreq: this.data.familyStepFreq || this.data.gaitData.stepFreq,
      instability: this.data.familyInstability || this.data.gaitData.instability,
      score: this.data.familyGaitScore || this.data.gaitData.score,
      obstacleCount: this.data.familyObstacleCount || this.data.obstacleCount,
      gaitStatus: this.data.gaitData.status
    };
    
    const prompt = `请作为老年健康顾问，根据以下智能拐杖监测数据给出健康评估和建议：

【实时状态】${healthData.status}
【今日步数】${healthData.stepCount} 步
【平均步频】${healthData.stepFreq} 步/分钟
【步态波动】${healthData.instability}%
【健康评分】${healthData.score} 分
【障碍报警】${healthData.obstacleCount} 次
【步态状态】${healthData.gaitStatus}

请从以下方面给出简洁的分析（总共不超过150字）：
1. 整体健康评价
2. 需要注意的问题
3. 日常建议`;

    this.callDeepSeekAPI(prompt, 'health');
  },
  
  // 智能问答
  askAI() {
    const question = this.data.userQuestion;
    if (!question || !question.trim()) {
      wx.showToast({ title: '请输入问题', icon: 'none' });
      return;
    }
    
    this.setData({ asking: true });
    
    // 添加到对话历史
    const chatHistory = this.data.chatHistory || [];
    chatHistory.push({ role: 'user', content: question });
    this.setData({ chatHistory, userQuestion: '' });
    
    // 构建上下文
    const healthContext = `当前老人健康数据：步数${this.data.stepCount}，步频${this.data.gaitData.stepFreq}步/分，波动${this.data.gaitData.instability}%，评分${this.data.gaitData.score}分，状态：${this.data.gaitData.status}`;
    
    const systemPrompt = `你是一个专业的老年健康顾问AI助手，名叫"智护助手"。你的职责是：
1. 回答关于老年人健康、步态、跌倒预防等问题
2. 解读智能拐杖的监测数据
3. 提供日常保健建议
4. 回答一般性问题时也要友好耐心

${healthContext}

请用简洁友好的语气回答，每次回复不超过100字。`;

    this.callDeepSeekAPI(question, 'chat', systemPrompt);
  },
  
  // 调用 DeepSeek API
  callDeepSeekAPI(userMessage, type, systemPrompt) {
    const messages = [
      { 
        role: 'system', 
        content: systemPrompt || '你是专业的老年健康顾问，请简洁专业地回答问题。'
      },
      { role: 'user', content: userMessage }
    ];
    
    wx.request({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.DEEPSEEK_API_KEY
      },
      data: {
        model: 'deepseek-chat',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      },
      success: (res) => {
        if (res.data.choices && res.data.choices[0]) {
          const reply = res.data.choices[0].message.content;
          
          if (type === 'health') {
            this.setData({ aiResult: reply });
          } else if (type === 'chat') {
            const chatHistory = this.data.chatHistory || [];
            chatHistory.push({ role: 'assistant', content: reply });
            this.setData({ chatHistory });
          }
        } else {
          this.handleAIError(type, '分析失败，请重试');
        }
      },
      fail: (err) => {
        console.error('AI请求失败:', err);
        this.handleAIError(type, '网络错误，请检查网络连接');
      },
      complete: () => {
        this.setData({ analyzing: false, asking: false });
      }
    });
  },
  
  handleAIError(type, message) {
    if (type === 'health') {
      this.setData({ aiResult: message });
    } else {
      const chatHistory = this.data.chatHistory || [];
      chatHistory.push({ role: 'assistant', content: '抱歉，' + message });
      this.setData({ chatHistory });
    }
  },
  
  // 输入问题
  onQuestionInput(e) {
    this.setData({ userQuestion: e.detail.value });
  },
  
  // 清空对话
  clearChat() {
    this.setData({ chatHistory: [], aiResult: '' });
  },
  
  // 快捷问题
  quickAsk(e) {
    const question = e.currentTarget.dataset.q;
    this.setData({ userQuestion: question });
    this.askAI();
  }
});
