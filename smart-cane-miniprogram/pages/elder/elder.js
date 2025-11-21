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
    log: '准备就绪'
  },

  onLoad() {
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

  startScan() {
    this.addLog('开始搜索设备...');
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: (res) => {
        wx.onBluetoothDeviceFound((res) => {
          res.devices.forEach(device => {
            // 过滤逻辑：根据设备名称过滤
            // 请将 'ESP32' 或 'Cane' 替换为你 ESP32 设置的蓝牙名称
            if (device.name && (device.name.includes('ESP32') || device.name.includes('Cane') || device.localName.includes('ESP32'))) {
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
          
          console.log('收到 AI 模块数据:', dataStr);
          this.addLog('AI 模块指令: ' + dataStr);

          // 简单的指令解析
          if (dataStr.includes('FALL') || dataStr.includes('01')) {
            this.handleEvent('fall', '检测到跌倒！');
          } else if (dataStr.includes('HELP') || dataStr.includes('SOS')) {
            this.handleEvent('help', '检测到语音呼救！');
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
    
    // 2. 上传状态到云端
    this.updateCloudStatus(true, type);
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
  }
})