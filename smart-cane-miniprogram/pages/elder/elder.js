const app = getApp()

// 注意：这里的 UUID 需要根据你的 ESP32 代码进行修改
// 常见的串口透传服务 UUID 可能是 0000FFE0...
// 请确保 ESP32 广播的服务 UUID 与此处匹配，或者在代码中动态查找
const SERVICE_UUID_FILTER = ""; // 如果为空，则扫描所有设备

Page({
  data: {
    connected: false,
    isFall: false,
    deviceId: '',
    serviceId: '',
    characteristicId: '',
    log: '准备就绪',
    weatherData: { temp: '25', text: '晴', city: '北京' },
    isPlayingNews: false,
    innerAudioContext: null
  },

  onLoad() {
    // 初始化音频
    this.initAudio();
    // 获取天气 (模拟)
    this.getWeather();
    // 启动定时器检查提醒
    this.startReminderCheck();

    // 初始化蓝牙模块
    wx.openBluetoothAdapter({
      success: (res) => {
        this.addLog('蓝牙初始化成功');
      },
      fail: (res) => {
        if (res.errCode === 10001) {
          wx.showModal({
            title: '提示',
            content: '请打开手机蓝牙',
            showCancel: false
          })
        } else {
          this.addLog('蓝牙初始化失败: ' + res.errMsg);
        }
      }
    })
  },

  onUnload() {
    this.disconnect();
    wx.closeBluetoothAdapter();
    if (this.data.innerAudioContext) {
      this.data.innerAudioContext.destroy();
    }
    if (this.reminderTimer) clearInterval(this.reminderTimer);
  },

  addLog(str) {
    console.log(str);
    // 只保留最近的几行日志
    let currentLog = this.data.log + '\n' + str;
    if (currentLog.length > 500) {
      currentLog = currentLog.substring(currentLog.length - 500);
    }
    this.setData({ log: currentLog })
  },

  initAudio() {
    const iac = wx.createInnerAudioContext();
    // 这里使用一个示例音频地址，实际请替换为新闻联播的音频流或文件
    iac.src = 'https://down.ear0.com:3321/preview?soundid=38668&type=mp3'; 
    iac.onPlay(() => this.setData({ isPlayingNews: true }));
    iac.onPause(() => this.setData({ isPlayingNews: false }));
    iac.onEnded(() => this.setData({ isPlayingNews: false }));
    iac.onError((res) => console.log(res.errMsg));
    this.setData({ innerAudioContext: iac });
  },

  playNews() {
    wx.showActionSheet({
      itemList: ['手机播放', '拐杖(AI模块)播报'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 手机播放
          if (this.data.isPlayingNews) {
            this.data.innerAudioContext.pause();
          } else {
            this.data.innerAudioContext.play();
          }
        } else {
          // 设备播报 (发送文本给 AI 模块进行 TTS)
          // 这里模拟一条新闻摘要，实际可从 API 获取
          const newsSummary = "今日新闻摘要：全国大部地区气温回升，适合户外活动。社区医院将开展免费体检活动。";
          this.sendToDevice('TTS:' + newsSummary);
          this.addLog('已发送新闻播报指令');
        }
      }
    })
  },

  getWeather() {
    // 实际开发中请调用 wx.request 请求天气 API (如和风天气、高德地图)
    // 这里模拟数据
    this.setData({
      weatherData: { temp: '22', text: '多云', city: '上海' }
    });
  },

  broadcastWeather() {
    const text = `今天${this.data.weatherData.city}天气${this.data.weatherData.text}，气温${this.data.weatherData.temp}度`;
    this.sendToDevice('TTS:' + text);
    wx.showToast({ title: '已发送播报指令' });
  },

  startReminderCheck() {
    // 每分钟检查一次是否有提醒
    this.reminderTimer = setInterval(() => {
      const now = new Date();
      const timeStr = `${('0'+now.getHours()).slice(-2)}:${('0'+now.getMinutes()).slice(-2)}`;
      
      if (!wx.cloud) return;
      const db = wx.cloud.database();
      db.collection('cane_reminders').where({
        time: timeStr
      }).get({
        success: res => {
          if (res.data.length > 0) {
            res.data.forEach(reminder => {
              // 触发提醒
              this.handleReminder(reminder.content);
            });
          }
        }
      });
    }, 60000); // 60秒检查一次
  },

  handleReminder(content) {
    // 1. 手机端弹窗/震动
    wx.vibrateLong();
    wx.showModal({
      title: '吃药提醒',
      content: content,
      showCancel: false
    });
    
    // 2. 发送给 AI 模块进行语音播报
    this.sendToDevice('TTS:请注意，' + content);
  },

  startScan() {
    this.addLog('开始搜索设备...');
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: (res) => {
        wx.onBluetoothDeviceFound((res) => {
          res.devices.forEach(device => {
            // 过滤逻辑：根据设备名称过滤
            // 请将 'ESP32' 或 'Cane' 替换为你 ESP32 设置的蓝牙名称
            if (device.name && (
              device.name.includes('ESP32') || 
              device.name.includes('Cane') || 
              device.name.includes('BT-11') || // 新增：匹配 BT-11 模块名称
              device.localName.includes('BT-11') || // 新增：匹配本地名称
              device.localName.includes('ESP32')
            )) {
              this.addLog('发现目标设备: ' + device.name);
              wx.stopBluetoothDevicesDiscovery(); // 找到后停止搜索
              this.connectDevice(device.deviceId);
            }
          })
        })
      },
      fail: (err) => {
        this.addLog('搜索失败: ' + err.errMsg);
      }
    })
  },

  connectDevice(deviceId) {
    this.addLog('正在连接: ' + deviceId);
    wx.createBLEConnection({
      deviceId,
      success: () => {
        this.setData({ connected: true, deviceId });
        this.addLog('连接成功');
        // 稍微延迟一下再获取服务，保证连接稳定
        setTimeout(() => {
          this.getServices(deviceId);
        }, 1000);
      },
      fail: (err) => {
        this.addLog('连接失败: ' + err.errMsg);
        this.setData({ connected: false });
      }
    })
  },

  getServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId,
      success: (res) => {
        this.addLog('获取服务列表成功，数量: ' + res.services.length);
        // 遍历服务，找到我们需要的主服务
        // 这里为了通用性，我们尝试寻找包含 notify 属性特征值的服务
        // 实际开发中，最好指定 UUID，例如：
        // const targetService = res.services.find(s => s.uuid.indexOf('FFE0') > -1);
        
        if (res.services.length > 0) {
          // 简单策略：遍历所有服务，寻找特征值
          // 注意：iOS 上获取到的 UUID 可能是大写且带横杠的
          // 这里我们取最后一个服务尝试（通常自定义服务在后面），或者你可以指定索引
          let serviceId = res.services[res.services.length - 1].uuid;
          this.setData({ serviceId });
          this.addLog('尝试使用服务: ' + serviceId);
          this.getCharacteristics(deviceId, serviceId);
        }
      },
      fail: (err) => {
        this.addLog('获取服务失败: ' + err.errMsg);
      }
    })
  },

  getCharacteristics(deviceId, serviceId) {
    wx.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (res) => {
        this.addLog('获取特征值成功，数量: ' + res.characteristics.length);
        // 寻找支持 notify 或 indicate 的特征值
        let char = res.characteristics.find(c => c.properties.notify || c.properties.indicate);
        
        if (char) {
          this.setData({ characteristicId: char.uuid });
          this.addLog('找到通知特征值: ' + char.uuid);
          this.notifyBLECharacteristicValueChange(deviceId, serviceId, char.uuid);
        } else {
          this.addLog('该服务下未找到支持通知的特征值，尝试其他服务...');
        }
      },
      fail: (err) => {
        this.addLog('获取特征值失败: ' + err.errMsg);
      }
    })
  },

  notifyBLECharacteristicValueChange(deviceId, serviceId, characteristicId) {
    wx.notifyBLECharacteristicValueChange({
      state: true,
      deviceId,
      serviceId,
      characteristicId,
      success: () => {
        this.addLog('监听数据开启成功');
        // 监听数据变化
        wx.onBLECharacteristicValueChange((res) => {
          // 处理接收到的数据
          // 适配 AI 模块：假设 AI 模块通过串口发给 ESP32，ESP32 再转发给小程序
          // 建议协议：字符串指令，例如 "AI:FALL" (跌倒), "AI:HELP" (语音呼救)
          
          let buffer = res.value;
          // 将 ArrayBuffer 转为字符串
          let dataStr = '';
          let dataView = new DataView(buffer);
          for (let i = 0; i < buffer.byteLength; i++) {
            dataStr += String.fromCharCode(dataView.getUint8(i));
          }
          
          console.log('收到设备数据:', dataStr);
          this.addLog('收到指令: ' + dataStr);

          // 简单的指令解析
          // 兼容多种模块：
          // 1. 防跌倒模块 -> ESP32 -> "FALL"
          // 2. AI 模块 -> ESP32 -> "AI:HELP", "AI:NEWS", "AI:WEATHER"
          if (dataStr.includes('FALL') || dataStr.includes('01')) {
            this.handleEvent('fall', '检测到跌倒！');
          } else if (dataStr.includes('HELP') || dataStr.includes('SOS')) {
            this.handleEvent('help', '检测到语音呼救！');
          } else if (dataStr.includes('NEWS')) {
            // AI 语音控制播放新闻
            this.playNews();
            this.addLog('执行指令: 播放/暂停新闻');
          } else if (dataStr.includes('WEATHER')) {
            // AI 语音查询天气
            this.broadcastWeather();
            this.addLog('执行指令: 查询天气');
          }
        })
      },
      fail: (err) => {
        this.addLog('开启监听失败: ' + err.errMsg);
      }
    })
  },

  handleEvent(type, message) {
    if (this.data.isFall) return; // 已经在报警中
    
    this.setData({ 
      isFall: true,
      eventMessage: message // 新增：显示具体的报警原因
    });
    this.addLog(message + ' 触发报警！');
    
    // 1. 震动
    wx.vibrateLong();
    
    // 2. 上传状态到云端 (包含蜂鸣器状态)
    if (wx.cloud) {
      const db = wx.cloud.database();
      db.collection('cane_status').add({
        data: {
          status: 'fall',  // 统一标记为跌倒/报警状态
          type: type,      // 'fall'或'help'
          message: message,
          hasBuzzer: true, // 标记蜂鸣器已报警
          updateTime: db.serverDate(),
          deviceInfo: 'ESP32 + AI Module'
        },
        success: res => {
          this.addLog('报警信息已同步到云端');
        },
        fail: err => {
          this.addLog('云端同步失败: ' + err.errMsg);
        }
      });
    }
  },

  resetStatus() {
    this.setData({ isFall: false, eventMessage: '' });
    this.addLog('警报已解除');
    this.updateCloudStatus(false, 'normal');
  },

  updateCloudStatus(isAlarm, type) {
    // 检查云开发是否初始化
    if (!wx.cloud) {
      this.addLog('云开发未初始化，无法同步状态');
      return;
    }

    const db = wx.cloud.database();
    db.collection('cane_status').add({
      data: {
        status: isAlarm ? 'alarm' : 'normal',
        type: type, // fall, help, normal
        updateTime: db.serverDate(),
        deviceInfo: 'ESP32 + AI Module'
      },
      success: res => {
        console.log('状态已同步到云端');
      },
      fail: err => {
        console.error('云端同步失败', err);
      }
    })
  },

  disconnect() {
    if (this.data.deviceId) {
      wx.closeBLEConnection({
        deviceId: this.data.deviceId,
        success: () => {
          this.setData({ connected: false, isFall: false });
          this.addLog('已断开连接');
        }
      })
    }
  },

  // 发送数据给 ESP32 (支持分包发送长文本)
  sendToDevice(msg) {
    if (!this.data.connected || !this.data.deviceId || !this.data.serviceId || !this.data.characteristicId) {
      this.addLog('未连接设备，无法发送: ' + msg);
      return;
    }

    // 将字符串转为 ArrayBuffer
    let buffer = new ArrayBuffer(msg.length);
    let dataView = new DataView(buffer);
    for (let i = 0; i < msg.length; i++) {
      dataView.setUint8(i, msg.charCodeAt(i));
    }

    // 分包发送逻辑 (BLE 每包通常限制 20 字节)
    const MAX_CHUNK = 20;
    let offset = 0;

    const sendLoop = () => {
      if (offset >= buffer.byteLength) {
        this.addLog('指令发送完成: ' + (msg.length > 10 ? msg.substring(0,10)+'...' : msg));
        return;
      }

      let length = Math.min(MAX_CHUNK, buffer.byteLength - offset);
      let chunk = buffer.slice(offset, offset + length);

      wx.writeBLECharacteristicValue({
        deviceId: this.data.deviceId,
        serviceId: this.data.serviceId,
        characteristicId: this.data.characteristicId,
        value: chunk,
        success: () => {
          offset += length;
          // 增加 50ms 延时，防止发送过快导致丢包
          setTimeout(sendLoop, 50);
        },
        fail: (err) => {
          this.addLog('发送失败: ' + err.errMsg);
        }
      })
    };

    sendLoop();
  },
})