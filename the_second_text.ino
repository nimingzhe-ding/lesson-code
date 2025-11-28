/*******************************************************
 * 智能拐杖最终版（含步态 + 跌倒 + 避障 + BLE + 摇杆控制）
 * 作者：小白（UESTC）
 * 功能：
 * 1. MPU6050 跌倒检测
 * 2. 步幅/步频/震颤/左右不对称的步态分析
 * 3. 超声波前向避障
 * 4. BLE 手机通知（FALL / GAIT_WARN / OBSTACLE）
 * 5. 不同事件使用不同蜂鸣器声音
 * 6. PS2 摇杆：用于开关步态检测与避障系统
 ********************************************************/

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Wire.h>
#include <math.h>

/******************** 硬件引脚 *********************/
#define SDA_PIN 4
#define SCL_PIN 5

#define BUZZER  13
#define LED1    2

// 超声波模块（注意 ECHO 如果输出 5V，要分压！）
#define TRIG_PIN 14
#define ECHO_PIN 27

// PS2 摇杆模块（X/Y为模拟口，SW按钮）
#define JOY_X   34
#define JOY_Y   35
#define JOY_SW  15   // PULLUP 输入

/******************** BLE UUID（NUS样式） ************************/
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

BLEServer *pServer = nullptr;
BLECharacteristic *pTxCharacteristic = nullptr;

bool deviceConnected = false;
bool oldDeviceConnected = false;

/******************** MPU6050 ****************************/
const int MPU_addr = 0x68;
const float FALL_ANGLE_THRESHOLD = 60.0;

/******************** 步态检测参数 ****************************/
const float STEP_THRESHOLD_G = 0.18;
const int   STEP_MIN_INTERVAL_MS = 250;

const float MIN_STEP_FREQ = 0.4;
const float MIN_STEP_AMP  = 0.12;
const float ASYM_RATIO_TH = 0.35;
const float TREMOR_DG_TH  = 0.10;
const int   TREMOR_COUNT_TH = 25;

const int SAMPLE_INTERVAL_MS = 20;  // 50Hz
unsigned long lastSampleMs = 0;

unsigned long winStartMs = 0;
const int WIN_MS = 3000;

int stepCount = 0;
float peakSum = 0;
int peakCount = 0;

unsigned long lastStepMs = 0;
float lastAg = 0;
float gyroX_max = -1e9, gyroX_min = 1e9;
int tremorCount = 0;

/******************** 摇杆控制的状态 ****************************/
bool gaitEnabled = true;
bool obstacleEnabled = true;

/******************** BLE 回调 ****************************/
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    deviceConnected = true;
    Serial.println("BLE 设备已连接");
  }
  void onDisconnect(BLEServer* pServer) override {
    deviceConnected = false;
    Serial.println("BLE 设备已断开");
  }
};

/******************** BLE RX 接收（用于LED控制） *****************/
class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) override {
    String rx = pCharacteristic->getValue();
    if (rx == "on")  digitalWrite(LED1, HIGH);
    if (rx == "off") digitalWrite(LED1, LOW);
  }
};

/******************** 蜂鸣器多模式报警 ***************************/
// 跌倒报警：长鸣，高频
void beepFall() {
  tone(BUZZER, 1500);
  delay(1500);
  noTone(BUZZER);
}

// 避障报警：滴滴滴
void beepObstacle() {
  for (int i = 0; i < 3; i++) {
    tone(BUZZER, 1200);
    delay(150);
    noTone(BUZZER);
    delay(100);
  }
}

// 步态过差：短鸣
void beepGaitWarn() {
  tone(BUZZER, 900);
  delay(300);
  noTone(BUZZER);
}

/******************** BLE 通知封装 ******************************/
void bleNotify(const char* msg) {
  if (deviceConnected) {
    pTxCharacteristic->setValue(msg);
    pTxCharacteristic->notify();
  }
}

/******************** MPU6050 读取函数 ***************************/
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

/******************** 步伐检测（基于加速度模长变化） **************/
bool detectStep(float ag, unsigned long nowMs) {
  float dg = fabs(ag - lastAg);
  if (dg > STEP_THRESHOLD_G && (nowMs - lastStepMs) > STEP_MIN_INTERVAL_MS) {
    lastStepMs = nowMs;
    return true;
  }
  return false;
}

/******************* 超声波测距函数（厘米） **********************/
float getDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 25000);
  if (duration == 0) return -1;
  return duration * 0.034 / 2.0;
}

/********************* Arduino setup *****************************/
void setup() {
  Serial.begin(115200);

  pinMode(LED1, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(JOY_SW, INPUT_PULLUP);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  Wire.begin(SDA_PIN, SCL_PIN);

  // MPU6050 开机唤醒
  Wire.beginTransmission(MPU_addr);
  Wire.write(0x6B);
  Wire.write(0);
  Wire.endTransmission(true);

  // BLE 初始化
  BLEDevice::init("ESP32_Cane");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE);
  pRxCharacteristic->setCallbacks(new MyCallbacks());

  pService->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("等待 BLE 连接...");
  winStartMs = millis();
}

/*********************** 主循环 loop *****************************/
void loop() {

  unsigned long nowMs = millis();

  /***************************************************
   *  摇杆控制模式开关（前置，不阻塞主逻辑）
   ***************************************************/
  int joyX = analogRead(JOY_X);
  int joyY = analogRead(JOY_Y);
  int joyBtn = digitalRead(JOY_SW);

  // 按下切换步态检测开关
  if (joyBtn == LOW) {
    gaitEnabled = !gaitEnabled;
    Serial.println(gaitEnabled ? "步态检测：开启" : "步态检测：关闭");
    delay(300);
  }

  // 上推开启避障，下推关闭避障
  if (joyY > 3000) obstacleEnabled = true;
  if (joyY < 1000) obstacleEnabled = false;


  /***************************************************
   *   50Hz MPU6050 采样节拍
   ***************************************************/
  if (nowMs - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = nowMs;

    int16_t AcX, AcY, AcZ, GyX;
    readMPU(AcX, AcY, AcZ, GyX);

    float ax = AcX / 16384.0f;
    float ay = AcY / 16384.0f;
    float az = AcZ / 16384.0f;
    float gx = GyX / 131.0f;

    float ag = sqrt(ax*ax + ay*ay + az*az);

    /********** 跌倒检测 **********/
    float angle = acos(fabs(az) / ag) * 180.0 / PI;
    if (angle > FALL_ANGLE_THRESHOLD) {
      Serial.println("【FALL】检测到跌倒！");
      beepFall();
      bleNotify("FALL");
      delay(800);
    }

    /********** 步态检测（可开关） **********/
    if (gaitEnabled) {

      if (detectStep(ag, nowMs)) {
        stepCount++;
        float peak = fabs(ag - lastAg);
        peakSum += peak;
        peakCount++;
      }

      if (gx > gyroX_max) gyroX_max = gx;
      if (gx < gyroX_min) gyroX_min = gx;

      float dg = fabs(ag - lastAg);
      if (dg > TREMOR_DG_TH) tremorCount++;
    }

    lastAg = ag;
  }


  /***************************************************
   *   步态窗口分析（每 3 秒一次）
   ***************************************************/
  if (gaitEnabled && (nowMs - winStartMs >= WIN_MS)) {

    float sec = (nowMs - winStartMs) / 1000.0f;
    float stepFreq = stepCount / sec;
    float avgPeak  = peakSum / (float)max(1, peakCount);
    float swingAmp = gyroX_max - gyroX_min;
    bool freqWarn  = stepFreq < MIN_STEP_FREQ;
    bool ampWarn   = avgPeak  < MIN_STEP_AMP;
    bool asymWarn  = (swingAmp > 0 && (fabs(gyroX_max) - fabs(gyroX_min)) / swingAmp > ASYM_RATIO_TH);
    bool tremorWarn = tremorCount > TREMOR_COUNT_TH;

    if (freqWarn || ampWarn || asymWarn || tremorWarn) {
      Serial.println("【GAIT】步态异常！");
      beepGaitWarn();
      bleNotify("GAIT_WARN");
    }

    // 窗口重置
    winStartMs = nowMs;
    stepCount = 0;
    peakSum = 0;
    peakCount = 0;
    gyroX_max = -1e9;
    gyroX_min = 1e9;
    tremorCount = 0;
  }


  /***************************************************
   *   超声波避障（可开关）
   ***************************************************/
  static unsigned long lastUltraMs = 0;
  if (obstacleEnabled && (nowMs - lastUltraMs >= 150)) {
    lastUltraMs = nowMs;

    float d = getDistanceCM();
    if (d > 0 && d < 60) {
      Serial.print("障碍距离："); Serial.println(d);
      beepObstacle();
      bleNotify("OBSTACLE");
    }
  }

  /***************************************************
   *   BLE 断线重连
   ***************************************************/
  if (!deviceConnected && oldDeviceConnected) {
    delay(300);
    pServer->startAdvertising();
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }
}
