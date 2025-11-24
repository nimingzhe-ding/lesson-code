const app = getApp()

Page({
  data: {
    remoteStatus: 'normal', // normal 或 fall
    lastUpdateTime: '暂无数据',
    analyzing: false,
    aiResult: '',
    remindTime: '08:00',
    remindContent: '',
    reminders: [],
    myBindingCode: '', // 当前绑定的老人
    inputCode: '',
    // 聊天相关数据
    chatHistory: [],
    chatInput: '',
    chatLoading: false,
    scrollToView: ''
  },

  onLoad() {
    // 读取本地存储的绑定关系
    const savedCode = wx.getStorageSync('familyBindingCode');
    if (savedCode) {
      this.setData({ myBindingCode: savedCode });
      this.refreshStatus();
      this.loadReminders();
    }
  },

  bindInput(e) {
    this.setData({ inputCode: e.detail.value });
  },

  confirmBind() {
    if (!this.data.inputCode || this.data.inputCode.length !== 6) {
      wx.showToast({ title: '请输入6位绑定码', icon: 'none' });
      return;
    }
    wx.setStorageSync('familyBindingCode', this.data.inputCode);
    this.setData({ myBindingCode: this.data.inputCode });
    this.refreshStatus();
    this.loadReminders();
    wx.showToast({ title: '绑定成功' });
  },

  unbind() {
    wx.removeStorageSync('familyBindingCode');
    this.setData({ 
      myBindingCode: '', 
      remoteStatus: 'normal',
      lastUpdateTime: '暂无数据',
      reminders: []
    });
  },

  // 加载提醒列表
  loadReminders() {
    if (!wx.cloud || !this.data.myBindingCode) return;
    const db = wx.cloud.database();
    db.collection('cane_reminders')
      .where({
        // 实际应用中提醒也应该跟绑定码关联，这里暂简化
        // bindingCode: this.data.myBindingCode 
      })
      .get({
        success: res => {
          this.setData({ reminders: res.data });
        }
      });
  },

  bindTimeChange(e) {
    this.setData({ remindTime: e.detail.value });
  },

  bindContentInput(e) {
    this.setData({ remindContent: e.detail.value });
  },

  addReminder() {
    if (!this.data.remindContent) {
      wx.showToast({ title: '请输入提醒内容', icon: 'none' });
      return;
    }
    
    const db = wx.cloud.database();
    db.collection('cane_reminders').add({
      data: {
        time: this.data.remindTime,
        content: this.data.remindContent,
        createTime: db.serverDate()
      },
      success: () => {
        wx.showToast({ title: '添加成功' });
        this.setData({ remindContent: '' });
        this.loadReminders();
      },
      fail: err => {
        // 如果集合不存在，提示创建
        if (err.errMsg.includes('collection not exist')) {
           wx.showModal({ title: '提示', content: '请在云开发控制台创建 cane_reminders 集合' });
        }
      }
    });
  },

  deleteReminder(e) {
    const id = e.currentTarget.dataset.id;
    const db = wx.cloud.database();
    db.collection('cane_reminders').doc(id).remove({
      success: () => {
        this.loadReminders();
      }
    });
  },

  analyzeHealth() {
    this.setData({ analyzing: true, aiResult: '' });
    
    const status = this.data.remoteStatus === 'fall' ? '曾发生跌倒或呼救' : '状态正常';
    const time = this.formatTime(new Date());
    const prompt = `当前时间是${time}。老人的拐杖监测状态为：${status}。请根据这些信息，生成一份简短的健康建议和安全提示。`;

    // --- 修正方案：测试号无法使用云函数，改为直接在前端调用 ---
    const API_KEY = 'sk-095082e3bd7743ac8ba4c990de8f8d9a'; 
    // DeepSeek 的完整接口地址通常需要加上 /chat/completions
    const API_URL = 'https://api.deepseek.com/chat/completions'; 

    wx.request({
      url: API_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      data: {
        model: "deepseek-chat", // DeepSeek V3/V2 的标准模型名称通常是 deepseek-chat
        messages: [
          { role: "system", content: "你是一个专业的健康顾问，负责分析老人的健康数据并给出建议。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      },
      success: res => {
        console.log('AI API 响应:', res);
        if (res.statusCode === 200 && res.data.choices && res.data.choices.length > 0) {
          this.setData({
            analyzing: false,
            aiResult: res.data.choices[0].message.content
          });
        } else {
          this.setData({
            analyzing: false,
            aiResult: '分析失败：' + (res.data.error ? res.data.error.message : '接口返回错误')
          });
        }
      },
      fail: err => {
        console.error('请求失败', err);
        this.setData({
          analyzing: false,
          aiResult: '请求失败，请确保开发者工具已勾选"不校验合法域名"。'
        });
      }
    });
  },

  refreshStatus() {
    if (!this.data.myBindingCode) return;

    wx.showLoading({ title: '加载中' });

    // 定义处理数据的通用函数
    const handleStatusData = (data) => {
      let statusText = '正常';
      let statusType = 'normal';
      
      if (data.status === 'alarm' || data.status === 'fall') {
        statusType = 'fall';
        if (data.type === 'help') {
          statusText = '语音呼救！';
        } else {
          statusText = '跌倒报警！';
        }
      }

      this.setData({
        remoteStatus: statusType,
        statusText: statusText,
        lastUpdateTime: this.formatTime(data.updateTime)
      });
    };

    // 尝试云端获取
    if (wx.cloud) {
      const db = wx.cloud.database();
      db.collection('cane_status')
        .where({
          bindingCode: this.data.myBindingCode
        })
        .orderBy('updateTime', 'desc')
        .limit(1)
        .get({
          success: res => {
            wx.hideLoading();
            if (res.data.length > 0) {
              handleStatusData(res.data[0]);
            } else {
              // 云端无数据，尝试本地模拟数据
              this.checkLocalSimulation(handleStatusData);
            }
          },
          fail: err => {
            wx.hideLoading();
            console.error('云端获取失败，尝试本地模拟', err);
            this.checkLocalSimulation(handleStatusData);
          }
        });
    } else {
      wx.hideLoading();
      this.checkLocalSimulation(handleStatusData);
    }
  },

  // 检查本地模拟数据 (用于测试号或无云环境)
  checkLocalSimulation(callback) {
    const localData = wx.getStorageSync('simulated_cane_status_' + this.data.myBindingCode);
    if (localData) {
      callback(localData);
      wx.showToast({ title: '已加载本地模拟数据', icon: 'none' });
    } else {
      wx.showToast({ title: '暂无数据', icon: 'none' });
    }
  },

  formatTime(date) {
    if (!date) return '';
    // 处理云开发返回的 Date 对象或字符串
    const d = new Date(date);
    const pad = n => n < 10 ? '0' + n : n;
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  // 聊天输入处理
  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  // 发送聊天消息
  sendChatMessage() {
    const content = this.data.chatInput.trim();
    if (!content) return;

    const newHistory = [...this.data.chatHistory, { role: 'user', content: content }];
    this.setData({
      chatHistory: newHistory,
      chatInput: '',
      chatLoading: true,
      scrollToView: `msg-${newHistory.length - 1}`
    });

    // 准备 API 调用参数
    const API_KEY = 'sk-095082e3bd7743ac8ba4c990de8f8d9a'; 
    const API_URL = 'https://api.deepseek.com/chat/completions';
    
    // 构建上下文消息列表
    const messages = [
      { role: "system", content: "你是一个专业的健康顾问，负责解答关于老人健康、安全和拐杖使用的问题。" },
      ...newHistory.slice(-6) // 只保留最近6条记录作为上下文，避免token超限
    ];

    wx.request({
      url: API_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      data: {
        model: "deepseek-chat",
        messages: messages,
        temperature: 0.7
      },
      success: res => {
        if (res.statusCode === 200 && res.data.choices && res.data.choices.length > 0) {
          const aiReply = res.data.choices[0].message.content;
          const updatedHistory = [...newHistory, { role: 'assistant', content: aiReply }];
          this.setData({
            chatHistory: updatedHistory,
            chatLoading: false,
            scrollToView: `msg-${updatedHistory.length - 1}`
          });
        } else {
          this.handleChatError(newHistory, 'API返回错误');
        }
      },
      fail: err => {
        console.error('聊天请求失败', err);
        this.handleChatError(newHistory, '网络请求失败');
      }
    });
  },

  handleChatError(history, errorMsg) {
    const updatedHistory = [...history, { role: 'assistant', content: `[系统提示] ${errorMsg}，请稍后重试。` }];
    this.setData({
      chatHistory: updatedHistory,
      chatLoading: false,
      scrollToView: `msg-${updatedHistory.length - 1}`
    });
  }
})