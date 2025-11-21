const app = getApp()

Page({
  data: {
    remoteStatus: 'normal', // normal 或 fall
    lastUpdateTime: '暂无数据',
    analyzing: false,
    aiResult: ''
  },

  onLoad() {
    this.refreshStatus();
  },

  analyzeHealth() {
    this.setData({ analyzing: true, aiResult: '' });
    
    // 模拟 AI 分析过程 (实际开发中这里可以调用云函数连接 ChatGPT/文心一言 API)
    setTimeout(() => {
      let analysis = "";
      const now = new Date();
      const hour = now.getHours();

      if (this.data.remoteStatus === 'fall') {
        analysis = "【紧急风险提示】\n检测到老人近期发生过跌倒事件。建议：\n1. 立即通过电话联系老人确认伤情。\n2. 检查拐杖底座是否磨损，地面是否湿滑。\n3. 建议近期增加看护频率。";
      } else {
        analysis = "【日常健康评估】\n当前设备状态正常。根据今日活动数据分析：\n1. 老人活动频率适中，建议保持。\n2. " + (hour > 18 ? "夜间光线较暗，建议提醒老人开启拐杖照明灯。" : "今日天气适宜，建议适当户外散步。") + "\n3. 拐杖电量充足，连接稳定。";
      }

      this.setData({
        analyzing: false,
        aiResult: analysis
      });
    }, 2000);
  },

  refreshStatus() {
    if (!wx.cloud) {
      wx.showToast({ title: '云开发未启用', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '加载中' });
    const db = wx.cloud.database();
    
    // 获取最新的一条状态记录
    // 实际应用中，这里应该根据绑定的老人ID进行查询
    db.collection('cane_status')
      .orderBy('updateTime', 'desc')
      .limit(1)
      .get({
        success: res => {
          wx.hideLoading();
          if (res.data.length > 0) {
            const data = res.data[0];
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
          } else {
            wx.showToast({ title: '暂无数据', icon: 'none' });
          }
        },
        fail: err => {
          wx.hideLoading();
          console.error(err);
          // 模拟数据，方便演示 UI
          // this.setData({
          //   remoteStatus: 'fall',
          //   statusText: '语音呼救！',
          //   lastUpdateTime: this.formatTime(new Date())
          // })
          wx.showToast({ title: '获取失败，请检查网络或云数据库', icon: 'none' });
        }
      })
  },

  formatTime(date) {
    if (!date) return '';
    // 处理云开发返回的 Date 对象或字符串
    const d = new Date(date);
    const pad = n => n < 10 ? '0' + n : n;
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
})