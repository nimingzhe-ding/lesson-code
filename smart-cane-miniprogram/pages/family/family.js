const app = getApp()

Page({
  data: {
    remoteStatus: 'normal', // normal 或 fall
    lastUpdateTime: '暂无数据'
  },

  onLoad() {
    this.refreshStatus();
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
            this.setData({
              remoteStatus: data.status,
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