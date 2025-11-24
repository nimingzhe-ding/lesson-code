// 云函数入口文件
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }) // 使用当前云环境

// 云函数入口函数
exports.main = async (event, context) => {
  const { prompt } = event
  
  // -----------------------------------------------------------
  // 请在此处配置您的 AI API 信息
  // -----------------------------------------------------------
  const API_URL = 'https://api.deepseek.com'; // 示例：OpenAI 接口地址，请替换为您实际使用的 API 地址
  const API_KEY = 'sk-095082e3bd7743ac8ba4c990de8f8d9a'; // 示例：请替换为您的 API Key
  

  const payload = {
    model: "deepseek", // 或者您的模型名称
    messages: [
      { role: "system", content: "你是一个专业的健康顾问，负责分析老人的健康数据并给出建议。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.7
  };

  try {
    const response = await axios.post(API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}` // 根据 API 要求调整认证方式
      }
    });

    // 假设返回的数据结构如下，请根据实际情况修改解析逻辑
    // OpenAI 示例: response.data.choices[0].message.content
    const result = response.data.choices && response.data.choices[0] && response.data.choices[0].message 
      ? response.data.choices[0].message.content 
      : JSON.stringify(response.data);

    return {
      success: true,
      data: result
    }

  } catch (error) {
    console.error('AI API Call Failed:', error);
    return {
      success: false,
      error: error.message || 'API调用失败'
    }
  }
}