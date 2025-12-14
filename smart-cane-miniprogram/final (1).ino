#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Wire.h>
#include <math.h>
#include <afstandssensor.h> // 超声波库

// ================= 硬件引脚定义 =================
// MPU6050 I2C
#define SDA_PIN 4
#define SCL_PIN 5
const int MPU_addr = 0x68;

// 超声波 HC-SR04
#define TRIG_PIN 14
#define ECHO_PIN 47

// PS2 摇杆 (注意：必须使用 ADC1 引脚)
#define JOY_X_PIN 6
#define JOY_Y_PIN 7

// 蜂鸣器 (普中板载蜂鸣器为 GPIO 46)
#define BUZZER_PIN 46 

// 指示灯
#define LED_PIN 1

// ================= 功能开关变量 =================
bool enableGaitAnalysis = false;      // 步态检测开关 (默认关)
bool enableObstacleAvoidance = false; // 红外/超声波避障开关 (默认关)

// ================= BLE 配置 =================
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

BLEServer *pServer = nullptr;
BLECharacteristic *pTxCharacteristic = nullptr;
bool deviceConnected = false;

// ================= 算法参数 =================
// --- 跌倒检测参数 ---
const float FALL_ANGLE_THRESHOLD = 60.0; 

// --- 步态检测参数 ---
const float STEP_THRESHOLD_G = 0.18;
const int STEP_MIN_INTERVAL_MS = 250;
unsigned long lastStepMs = 0;
float lastAg = 0;
int stepCountSession = 0;               // 本次行走步数

// --- 【补全】步态分析缓冲区 (这是之前漏掉的部分) ---
const int WINDOW_SIZE = 5;              // 采样窗口大小：每5步分析一次
unsigned long stepIntervals[WINDOW_SIZE]; // 存储最近5步的时间间隔
int stepBufferIndex = 0;                // 当前存到第几个了
bool isBufferFull = false;              // 缓冲区是否填满过

// --- 超声波参数 ---
AfstandsSensor afstandssensor(TRIG_PIN, ECHO_PIN);
unsigned long lastDistCheckTime = 0;
const int DIST_CHECK_INTERVAL = 200; // 每200ms测一次距

// --- 摇杆控制参数 ---
unsigned long lastJoyCheckTime = 0;
const int JOY_CHECK_INTERVAL = 100;

// --- 步态数据发送定时器 ---
unsigned long lastGaitSendTime = 0;
const int GAIT_SEND_INTERVAL = 2000; // 每2秒发送一次步态详细数据
float lastStepFreq = 0;        // 最近的步频
float lastInstability = 0;     // 最近的波动率

// ================= 辅助类与函数 =================

// BLE 回调
class MyServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        Serial.println("蓝牙已连接");
    };
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        Serial.println("蓝牙已断开");
        // 重新广播以便重连
        pServer->getAdvertising()->start();
    }
};

// 发送 BLE 通知
void bleNotify(String msg) {
    if (deviceConnected && pTxCharacteristic) {
        pTxCharacteristic->setValue(msg.c_str());
        pTxCharacteristic->notify();
        Serial.println("BLE发送: " + msg);
    }
}

// 蜂鸣器控制 (辅助函数)
void tone_buzzer(int duration_ms, int freq = 200) {
    long delayValue = 1000000 / freq / 2; // 计算半周期的微秒数
    long numCycles = duration_ms * 1000 / (delayValue * 2); // 计算循环次数

    for (long i = 0; i < numCycles; i++) {
        digitalWrite(BUZZER_PIN, HIGH);  // 触发（如果是低电平触发）
        delayMicroseconds(delayValue);
        digitalWrite(BUZZER_PIN, LOW); // 关闭
        delayMicroseconds(delayValue);
    }
    // 确保最后是关闭状态
    digitalWrite(BUZZER_PIN, LOW); 
}

// 报警函数
void triggerAlarm(int type) {
    if (type == 1) {
        // 跌倒报警 (急促刺耳)
        Serial.println("!!! 跌倒报警 !!!");
        for(int i=0; i<3; i++){ 
            tone_buzzer(1000, 800); 
            delay(100);
            tone_buzzer(100, 1000); 
            delay(100);
        }
    } else if (type == 2) {
        // 障碍物报警 (低沉长鸣)
        Serial.println("!!! 障碍物报警 !!!");
        tone_buzzer(200, 400); 
    } else if (type == 3) {
        // 模式切换 (短促清脆)
        tone_buzzer(50, 1500); 
    }
}

// 读取 MPU6050
void readMPU(int16_t &AcX, int16_t &AcY, int16_t &AcZ, int16_t &GyX) {
    Wire.beginTransmission(MPU_addr);
    Wire.write(0x3B);
    Wire.endTransmission(false);
    Wire.requestFrom(MPU_addr, 8, true);
    AcX = Wire.read() << 8 | Wire.read();
    AcY = Wire.read() << 8 | Wire.read();
    AcZ = Wire.read() << 8 | Wire.read();
    GyX = Wire.read() << 8 | Wire.read();
}

// ================= 优化后的步态算法 (滑动窗口版) =================
void runGaitLogic(float ag, unsigned long nowMs) {
    float dg = fabs(ag - lastAg);
    
    // 1. 超时重置逻辑：如果超过2秒没走，视为"停下来了"，重置分析缓冲区
    if (nowMs - lastStepMs > 2000) {
        stepBufferIndex = 0; // 重置计数
        isBufferFull = false;
        // Serial.println("状态：用户停止行走，重置步态分析");
    }

    // 2. 物理步态检测
    if (dg > STEP_THRESHOLD_G && (nowMs - lastStepMs) > STEP_MIN_INTERVAL_MS) {
        
        unsigned long currentStepInterval = nowMs - lastStepMs;
        
        // --- 滤除异常值 (Filter) ---
        // 滤除小于200ms(抖动)或大于2000ms(停顿)的数据
        if (currentStepInterval < 200 || currentStepInterval > 2000) {
             lastStepMs = nowMs; 
             return; 
        }

        // --- 存入缓冲区 (Buffer) ---
        // 注意：这里需要 stepIntervals 全局变量
        stepIntervals[stepBufferIndex] = currentStepInterval;
        stepBufferIndex++;
        
        stepCountSession++; 
        bleNotify("STEP:" + String(stepCountSession)); // 实时更新步数
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));

        // --- 只有当攒够了 WINDOW_SIZE (5步) 时，才进行一次健康分析 ---
        if (stepBufferIndex >= WINDOW_SIZE) {
            
            // A. 计算平均间隔
            unsigned long sumInterval = 0;
            for (int i = 0; i < WINDOW_SIZE; i++) {
                sumInterval += stepIntervals[i];
            }
            float avgInterval = sumInterval / (float)WINDOW_SIZE;
            
            // B. 计算平均步频 (SPM)
            float avgSpm = 60000.0 / avgInterval;
            lastStepFreq = avgSpm; // 更新全局变量用于汇总
            
            // C. 计算稳定性 (变异率 CV)
            float sumDiff = 0;
            for (int i = 0; i < WINDOW_SIZE; i++) {
                sumDiff += abs((long)stepIntervals[i] - (long)avgInterval);
            }
            float avgInstability = (sumDiff / WINDOW_SIZE) / avgInterval * 100.0;
            lastInstability = avgInstability; // 更新全局变量用于汇总

            // --- 打印分析报告 ---
            Serial.print("【步态周期报告】");
            Serial.print(" 均速:" + String(avgSpm, 1) + "步/分");
            Serial.print(" | 变异率:" + String(avgInstability, 1) + "%");

            // --- 发送给小程序用于绘图 ---
            String gaitDetail = "GAIT_DETAIL:" + String(avgInterval) + "," + 
                               String(avgSpm, 1) + "," + String(avgInstability, 1);
            bleNotify(gaitDetail);

            // --- 医疗风险判定逻辑 ---
            String riskMsg = "";

            // 判定A: 步频异常 (基于平均值)
            if (avgSpm < 60) {
                 riskMsg = "GAIT_RISK:步速持续过慢-需关注肌力";
                 Serial.println(" -> 警告：步速过慢");
            } 
            else if (avgSpm > 130) {
                 riskMsg = "GAIT_RISK:步速持续过快-慌张步态风险";
                 Serial.println(" -> 警告：步速过快");
            }

            // 判定B: 节律异常 (变异率)
            if (avgInstability > 25.0) {
                 riskMsg = "GAIT_RISK:步律紊乱-跌倒风险高";
                 Serial.println(" -> 警告：步律紊乱");
                 
                 // 只有极度不稳时才让蜂鸣器响
                 if (avgInstability > 40.0) {
                     tone_buzzer(100, 1500); 
                 }
            }

            if (riskMsg != "") {
                bleNotify(riskMsg);
            } else {
                Serial.println(" -> [步态健康]");
            }

            // --- 重置缓冲区 ---
            stepBufferIndex = 0; 
        }

        lastStepMs = nowMs;
    }
    lastAg = ag;
}

// 定期发送步态汇总数据 (生成评分)
void sendGaitSummary(unsigned long nowMs) {
    if (!enableGaitAnalysis) return;
    if (nowMs - lastGaitSendTime < GAIT_SEND_INTERVAL) return;
    
    lastGaitSendTime = nowMs;
    
    if (stepCountSession == 0) return; 
    
    // 简单评分逻辑
    int score = 100;
    if (lastStepFreq < 50) score -= 30;
    else if (lastStepFreq > 140) score -= 40;
    else if (lastStepFreq < 60 || lastStepFreq > 120) score -= 10;
    
    if (lastInstability > 35) score -= 50;
    else if (lastInstability > 25) score -= 30;
    else if (lastInstability > 15) score -= 10;
    
    score = max(0, score);
    float regularity = max(0.0f, 1.0f - lastInstability / 100.0f);
    
    String gaitData = "GAIT_DATA:" + String(lastStepFreq / 60.0, 2) + "," + 
                      String(regularity, 2) + "," +
                      String(lastInstability / 100.0, 2) + "," +
                      String(score);
    bleNotify(gaitData);
}

// ================= SETUP =================
void setup() {
    Serial.begin(115200);
    
    // 初始化蜂鸣器
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW); 
 
    pinMode(LED_PIN, OUTPUT);
   
    // MPU6050 初始化
    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.beginTransmission(MPU_addr);
    Wire.write(0x6B);
    Wire.write(0);
    Wire.endTransmission(true);
    Serial.println("MPU6050 OK");

    // BLE 初始化
    BLEDevice::init("Smart_Cane_ESP32");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    BLEService *pService = pServer->createService(SERVICE_UUID);
    pTxCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID_TX,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pTxCharacteristic->addDescriptor(new BLE2902());
    pService->start();
    BLEDevice::getAdvertising()->addServiceUUID(SERVICE_UUID);
    BLEDevice::getAdvertising()->start();
    Serial.println("蓝牙等待连接...");
}

// ================= LOOP =================
void loop() {
    unsigned long currentMillis = millis();

    // 1. --- 摇杆模式控制 (每100ms检测一次) ---
    if (currentMillis - lastJoyCheckTime > JOY_CHECK_INTERVAL) {
        lastJoyCheckTime = currentMillis;
        
        int joyX = analogRead(JOY_X_PIN);
        int joyY = analogRead(JOY_Y_PIN);
        int thresholdLow = 1000;
        int thresholdHigh = 3000;

        // 前推 -> 开启步态
        if (joyY > thresholdHigh && !enableGaitAnalysis) {
            enableGaitAnalysis = true;
            stepCountSession = 0; 
            lastStepMs = currentMillis; 
            Serial.println("CMD: 开启步态检测");
            bleNotify("MODE:GAIT_ON");
            triggerAlarm(3);
        }
        // 后推 -> 关闭步态
        else if (joyY < thresholdLow && enableGaitAnalysis) {
            enableGaitAnalysis = false;
            Serial.println("CMD: 关闭步态检测");
            bleNotify("MODE:GAIT_OFF");
            triggerAlarm(3);
        }

        // 左推 -> 开启避障
        if (joyX < thresholdLow && !enableObstacleAvoidance) {
            enableObstacleAvoidance = true;
            Serial.println("CMD: 开启避障模式");
            bleNotify("MODE:OBS_ON");
            triggerAlarm(3);
        }
        // 右推 -> 关闭避障
        else if (joyX > thresholdHigh && enableObstacleAvoidance) {
            enableObstacleAvoidance = false;
            Serial.println("CMD: 关闭避障模式");
            bleNotify("MODE:OBS_OFF");
            triggerAlarm(3);
        }
    }

   // 2. --- MPU6050 数据读取与智能跌倒检测 ---
    int16_t acX, acY, acZ, gyX;
    readMPU(acX, acY, acZ, gyX);

    // 转换为g值
    float ax = acX / 16384.0;
    float ay = acY / 16384.0;
    float az = acZ / 16384.0;
    float totalG = sqrt(ax*ax + ay*ay + az*az);

    // 计算倾角
    float angle = atan2(ay, az) * 180 / PI; 
    
    // --- 跌倒检测参数 ---
    const unsigned long FALL_CONFIRM_TIME = 2000; 
    static unsigned long fallStartTime = 0; 
    static bool isTilted = false;         

    // 跌倒判断: 角度大 + 持续时间久 + 最终静止
    if (abs(angle) > FALL_ANGLE_THRESHOLD) {
        if (!isTilted) {
            fallStartTime = millis();
            isTilted = true;
            Serial.println("监测：检测到倾斜，开始计时确认...");
        } 
        else {
            if (millis() - fallStartTime > FALL_CONFIRM_TIME) {
                // 静止确认: 排除挥舞动作
                if (totalG > 0.5 && totalG < 1.5) {
                    Serial.println("警告：确认跌倒！(倾斜且静止)");
                    bleNotify("ALARM:FALL");
                    triggerAlarm(1); 
                    isTilted = false; 
                    delay(2000); 
                }
            }
        }
    } 
    else {
        if (isTilted) {
            isTilted = false;
            Serial.println("监测：角度恢复，解除倾斜判定");
        }
    }

    // 3. --- 步态检测 ---
    if (enableGaitAnalysis) {
        runGaitLogic(totalG, currentMillis);
        sendGaitSummary(currentMillis);
    }

    // 4. --- 避障检测 ---
    if (enableObstacleAvoidance) {
        if (currentMillis - lastDistCheckTime > DIST_CHECK_INTERVAL) {
            lastDistCheckTime = currentMillis;
            float distance = afstandssensor.afstandCM();
            
            if (distance > 2.0 && distance < 400.0) {
                if (distance < 40.0) {
                    Serial.println("障碍物靠近！距离: " + String(distance, 1) + " cm");
                    triggerAlarm(2); 
                    bleNotify("ALARM:OBS"); 
                }
            }
        }
    }
}