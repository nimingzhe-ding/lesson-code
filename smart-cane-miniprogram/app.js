App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        // env: 'your-env-id', // 请在此处填入你的云开发环境ID
        traceUser: true,
      })
    }
    this.globalData = {}
  }
})