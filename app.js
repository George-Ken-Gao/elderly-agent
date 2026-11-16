const CHAT_MODEL = "gemini-3-flash-preview";
const EMBEDDING_MODEL = "gemini-embedding-001";
const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PROFILE_STORAGE_KEY = "elderly-agent:profile:v1";
const CHAT_STORAGE_KEY = "elderly-agent:chat:v1";
const INDEX_CACHE_KEY = "elderly-agent:embeddings:v1";
const API_KEY_STORAGE_KEY = "elderly-agent:gemini-api-key";
const API_KEY_REQUIRED_MESSAGE = "请先设置 Gemini API Key，再开始使用陪伴服务。";
const MAX_TOOL_ROUNDS = 5;
const TOP_K = 3;
const MIN_HEALTH_SIMILARITY = 0.35;

const DEFAULT_PROFILE = {
  name: "",
  morningTime: "08:00",
  noonTime: "12:00",
  nightTime: "21:00",
  interests: "",
  city: "北京",
  childName: "女儿",
};

const TOOL_DECLARATIONS = [
  {
    name: "getReminders",
    description: "查看今天当前时间之后尚未到点的服药和作息提醒。",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "getWeather",
    description: "查询指定城市当前天气。未指定城市时使用用户资料中的城市。",
    parameters: {
      type: "OBJECT",
      properties: {
        city: { type: "STRING", description: "城市名称，例如北京、上海" },
      },
    },
  },
];

const messagesElement = document.querySelector("#chat-messages");
const form = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const sendButton = document.querySelector("#send-button");
const clearButton = document.querySelector("#clear-chat");
const statusElement = document.querySelector("#status");
const errorElement = document.querySelector("#error");
const activityLog = document.querySelector("#activity-log");
const activityBadge = document.querySelector("#activity-badge");
const alertCard = document.querySelector("#alert-card");
const alertDescription = document.querySelector("#alert-description");
const alertContact = document.querySelector("#alert-contact");
const notifyStatus = document.querySelector("#notify-status");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const settingsStatus = document.querySelector("#settings-status");
const simulateDialog = document.querySelector("#simulate-dialog");
const apiKeyForm = document.querySelector("#api-key-form");
const apiKeyInput = document.querySelector("#api-key");
const keyStatusElement = document.querySelector("#key-status");

let profile = loadProfile();
let messages = loadMessages();
let knowledgeIndex = [];
let isWorking = false;
let isIndexing = false;
let isVisitorApiKeyConfigured = false;

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("个人信息格式无效。");
    }
    return {
      ...DEFAULT_PROFILE,
      ...Object.fromEntries(
        Object.keys(DEFAULT_PROFILE).map((key) => [
          key,
          typeof stored[key] === "string" ? stored[key] : DEFAULT_PROFILE[key],
        ]),
      ),
    };
  } catch (error) {
    console.error("读取个人信息失败：", error);
    return { ...DEFAULT_PROFILE };
  }
}

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (error) {
    console.error("保存个人信息失败：", error);
    throw new Error("无法保存个人信息，请检查浏览器存储设置后重试。");
  }
}

function loadMessages() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const stored = JSON.parse(raw);
    if (
      !Array.isArray(stored) ||
      !stored.every(
        (message) =>
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.text === "string",
      )
    ) {
      throw new Error("本地对话记录格式无效。");
    }
    return stored;
  } catch (error) {
    console.error("读取对话记录失败：", error);
    statusElement.textContent = "无法读取本地对话历史；可清空对话后继续使用。";
    return [];
  }
}

function saveMessages() {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
  } catch (error) {
    console.error("保存对话记录失败：", error);
    statusElement.textContent = "回答已生成，但无法保存对话历史；请检查浏览器存储空间。";
  }
}

function getApiKey() {
  let savedKey;
  try {
    savedKey = localStorage.getItem(API_KEY_STORAGE_KEY)?.trim();
  } catch (error) {
    console.error("读取 Gemini API Key 失败：", error);
    throw new Error("无法读取浏览器本地存储，请检查浏览器设置后重试。");
  }
  isVisitorApiKeyConfigured = Boolean(savedKey);
  if (savedKey) return savedKey;
  const configKey = window.APP_CONFIG?.geminiApiKey?.trim();
  if (configKey && configKey !== "在这里填写你的 Gemini API key") return configKey;
  throw new Error(API_KEY_REQUIRED_MESSAGE);
}

function updateKeyStatus() {
  keyStatusElement.textContent = isVisitorApiKeyConfigured
    ? "已保存访客 Key，将优先使用此 Key。"
    : "未填写时使用 config.js 中的 Key；访客 Key 保存在当前浏览器。";
}

function getKnowledgeChunks() {
  if (!Array.isArray(window.HEALTH_KNOWLEDGE) || window.HEALTH_KNOWLEDGE.length < 8) {
    throw new Error("健康知识库未正确加载，请检查 knowledge.js。");
  }
  return window.HEALTH_KNOWLEDGE;
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
  statusElement.textContent = "";
  activityBadge.textContent = "执行失败";
  activityBadge.classList.remove("is-loading");
}

function clearError() {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function getUserFacingError(error) {
  if (error instanceof Error && error.message) {
    if (error.name === "TypeError") return "网络连接失败，请检查网络后重试。";
    if (error.name === "SyntaxError") return "服务返回的数据无法解析，请稍后重试。";
    return error.message;
  }
  return "发生未知错误，请稍后重试。";
}

function addActivity(title, content = "") {
  const item = document.createElement("li");
  item.className = "activity-step";
  const heading = document.createElement("strong");
  heading.textContent = title;
  item.append(heading);
  if (content) {
    const detail = document.createElement("p");
    detail.textContent = content;
    item.append(detail);
  }
  activityLog.append(item);
}

function beginActivity() {
  activityLog.replaceChildren();
  activityBadge.textContent = "处理中";
  activityBadge.classList.add("is-loading");
  addActivity("收到消息，开始规划");
}

function finishActivity() {
  activityBadge.textContent = "已完成";
  activityBadge.classList.remove("is-loading");
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = `message message-${message.role}`;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = message.role === "assistant" ? "安" : "我";
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = message.role === "assistant" ? "安心陪伴" : "您";
  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message.text;
  body.append(label, text);

  if (Array.isArray(message.sources) && message.sources.length) {
    const citations = document.createElement("div");
    citations.className = "citations";
    const caption = document.createElement("span");
    caption.textContent = "参考资料";
    citations.append(caption);
    for (const source of message.sources) {
      const chip = document.createElement("span");
      chip.className = "citation-chip";
      chip.textContent = source;
      citations.append(chip);
    }
    body.append(citations);
  }
  article.append(avatar, body);
  messagesElement.append(article);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function welcomeText() {
  const greeting = profile.name ? `您好，${profile.name}。` : "您好，";
  const interests = profile.interests ? `也可以聊聊${profile.interests}。` : "";
  return `${greeting}我是安心陪伴。今天过得怎么样？我会帮您留意吃药和作息提醒。${interests}`;
}

function renderHistory() {
  messagesElement.replaceChildren();
  if (!messages.length) {
    renderMessage({ role: "assistant", text: welcomeText() });
    return;
  }
  for (const message of messages) renderMessage(message);
}

async function requestGemini(model, method, body, key) {
  const response = await fetch(`${API_BASE_URL}/${model}:${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error("解析 Gemini 响应失败：", error);
    throw new Error("Gemini 服务返回了无法识别的数据，请稍后重试。");
  }
  if (!response.ok) {
    console.error("Gemini API 错误：", data.error?.message || response.status);
    throw new Error(
      `Gemini 请求失败（HTTP ${response.status}），请检查 API Key、模型权限或服务状态。`,
    );
  }
  return data;
}

function isValidVector(vector) {
  return Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite);
}

function getKnowledgeFingerprint(chunks) {
  return JSON.stringify(chunks.map(({ id, title, content }) => ({ id, title, content })));
}

function readCachedIndex(fingerprint, chunks) {
  try {
    const raw = localStorage.getItem(INDEX_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (
      cached.model !== EMBEDDING_MODEL ||
      cached.fingerprint !== fingerprint ||
      !Array.isArray(cached.vectors) ||
      cached.vectors.length !== chunks.length
    ) {
      return null;
    }
    const vectorLength = cached.vectors[0]?.values?.length;
    if (
      !vectorLength ||
      !cached.vectors.every(
        (item, index) =>
          item.id === chunks[index].id &&
          isValidVector(item.values) &&
          item.values.length === vectorLength,
      )
    ) {
      return null;
    }
    return cached.vectors.map((item, index) => ({ ...chunks[index], embedding: item.values }));
  } catch (error) {
    console.warn("读取向量缓存失败，将重新生成索引。", error);
    return null;
  }
}

async function embedKnowledge(chunks, key) {
  const data = await requestGemini(
    EMBEDDING_MODEL,
    "batchEmbedContents",
    {
      requests: chunks.map((chunk) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: `${chunk.title}\n${chunk.content}` }] },
      })),
    },
    key,
  );
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== chunks.length) {
    throw new Error("Embedding 服务没有返回完整的知识向量，请刷新页面重试。");
  }
  return chunks.map((chunk, index) => {
    const embedding = data.embeddings[index]?.values;
    if (!isValidVector(embedding)) {
      throw new Error(`知识片段“${chunk.title}”的向量无效，请刷新页面重试。`);
    }
    return { ...chunk, embedding };
  });
}

async function embedText(text, key) {
  const data = await requestGemini(
    EMBEDDING_MODEL,
    "embedContent",
    { content: { parts: [{ text }] } },
    key,
  );
  const embedding = data.embedding?.values;
  if (!isValidVector(embedding)) throw new Error("问题向量生成失败，请稍后重试。");
  return embedding;
}

function cosineSimilarity(vectorA, vectorB) {
  if (vectorA.length !== vectorB.length) {
    throw new Error("问题向量与知识库向量维度不一致，请刷新页面重建索引。");
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < vectorA.length; index += 1) {
    dotProduct += vectorA[index] * vectorB[index];
    normA += vectorA[index] ** 2;
    normB += vectorB[index] ** 2;
  }
  if (!normA || !normB) throw new Error("向量长度为零，无法检索健康知识。");
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function retrieveChunks(questionEmbedding) {
  return knowledgeIndex
    .map((chunk) => ({
      ...chunk,
      similarity: cosineSimilarity(questionEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K);
}

function isHealthQuestion(question) {
  return /健康|身体|吃药|服药|药物|血压|血糖|头晕|胸闷|胸痛|摔倒|跌倒|睡眠|睡觉|失眠|保暖|冬天|饮水|喝水|营养|饮食|散步|运动|骨折|慢性病|心脏|肾脏|跌|不舒服|呼吸|疼痛|医生|疾病|治疗|症状/.test(
    question,
  );
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getReminders(now = new Date()) {
  // 只提示今天尚未到点的项目；个人资料可调整三次服药时间。
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const schedule = [
    { time: profile.morningTime, label: "吃降压药" },
    { time: profile.noonTime, label: "吃钙片" },
    { time: "15:00", label: "散步" },
    { time: profile.nightTime, label: "吃安眠药" },
  ]
    .filter((reminder) => /^\d{2}:\d{2}$/.test(reminder.time))
    .filter((reminder) => reminder.time > formatTime(now))
    .sort((a, b) => a.time.localeCompare(b.time));
  return {
    checkedAt: `${today} ${formatTime(now)}`,
    remaining: schedule.map(({ time, label }) => ({ time, label })),
    message: schedule.length
      ? `今天还没到时间的提醒：${schedule.map(({ time, label }) => `${time} ${label}`).join("；")}。`
      : "今天的服药和散步提醒时间都已到或已过去。",
  };
}

function getWeatherDescription(code) {
  const descriptions = {
    0: "晴朗", 1: "大致晴朗", 2: "局部多云", 3: "阴天", 45: "有雾",
    48: "冻雾", 51: "毛毛雨", 53: "中等毛毛雨", 55: "较强毛毛雨",
    56: "冻毛毛雨", 57: "较强冻毛毛雨", 61: "小雨", 63: "中雨",
    65: "大雨", 66: "冻雨", 67: "较强冻雨", 71: "小雪", 73: "中雪",
    75: "大雪", 77: "雪粒", 80: "阵雨", 81: "中等阵雨", 82: "强阵雨",
    85: "阵雪", 86: "强阵雪", 95: "雷暴", 96: "伴有小冰雹的雷暴",
    99: "伴有大冰雹的雷暴",
  };
  return descriptions[code] || `天气代码 ${code}`;
}

async function findCityCoordinates(city) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({
    name: city,
    count: "1",
    language: "zh",
    format: "json",
  }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`城市定位服务请求失败（HTTP ${response.status}）。`);
  const data = await response.json();
  const match = data.results?.[0];
  if (!match) throw new Error(`没有找到“${city}”的位置，请在个人信息中设置城市。`);
  return {
    name: match.name,
    latitude: match.latitude,
    longitude: match.longitude,
    country: match.country,
  };
}

async function getWeather(city = profile.city) {
  if (typeof city !== "string" || !city.trim()) {
    throw new Error("请先在个人信息中填写所在城市，再查询天气。");
  }
  const location = await findCityCoordinates(city.trim());
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    timezone: "auto",
  }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo 天气服务请求失败（HTTP ${response.status}）。`);
  const data = await response.json();
  if (!data.current) throw new Error("天气服务没有返回当前天气数据，请稍后重试。");
  return {
    city: location.name,
    country: location.country,
    observedAt: data.current.time,
    condition: getWeatherDescription(data.current.weather_code),
    temperature: `${data.current.temperature_2m} ${data.current_units.temperature_2m}`,
    feelsLike: `${data.current.apparent_temperature} ${data.current_units.apparent_temperature}`,
    humidity: `${data.current.relative_humidity_2m}${data.current_units.relative_humidity_2m}`,
    windSpeed: `${data.current.wind_speed_10m} ${data.current_units.wind_speed_10m}`,
    precipitation: `${data.current.precipitation} ${data.current_units.precipitation}`,
  };
}

async function executeTool(functionCall) {
  if (functionCall.name === "getReminders") return getReminders();
  if (functionCall.name === "getWeather") {
    return getWeather(functionCall.args?.city || profile.city);
  }
  throw new Error(`模型请求了不支持的工具：${functionCall.name}`);
}

function buildSystemInstruction() {
  const now = new Date();
  const reminders = getReminders(now);
  const interests = profile.interests || "尚未设置";
  return `你是家庭养老 AI 陪伴助手。请使用温和、亲切、简短的中文，句子简短，避免说教。
用户称呼：${profile.name || "尚未设置"}；兴趣爱好：${interests}；所在城市：${profile.city || "尚未设置"}；建议联系的子女：${profile.childName || "子女"}。
当前本地时间：${now.toLocaleString("zh-CN")}。提醒工具当前结果：${reminders.message}
健康问题只能以本轮提供的健康知识检索内容为依据；资料没有明确支持时，直说“知识库里没有相关信息，我不确定”，不要猜测或给诊断、处方。回答健康知识时引用 [资料：标题]。严重胸痛、呼吸困难、意识不清等紧急情况应建议联系当地急救服务，不要让用户等待聊天助手。
天气信息必须调用 getWeather，并只依据工具返回的数据回答。询问是否适合散步时，必须同时参考 getWeather 和当天的提醒，不可编造天气或提醒。
对话中自然使用已知姓名和兴趣，不要每次重复。多步骤完成所需工具调用，最多 5 轮；完成后再给简短答复。`;
}

async function callAgent(contents, key) {
  return requestGemini(
    CHAT_MODEL,
    "generateContent",
    {
      systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
      contents,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0.3 },
    },
    key,
  );
}

function extractText(content) {
  return content.parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function runAgent(question, key, healthMatches, reminders) {
  const knowledgeText = healthMatches.length
    ? healthMatches
        .map((chunk, index) => `[资料 ${index + 1}] ${chunk.title}\n${chunk.content}`)
        .join("\n\n")
    : "本轮没有检索到足够相关的健康知识。若用户询问健康事实，请明确说明知识库没有相关信息，不要用模型常识补充。";
  const context = `用户问题：${question}
用户资料：姓名 ${profile.name || "未设置"}；兴趣 ${profile.interests || "未设置"}；所在城市 ${profile.city || "未设置"}。
今天尚未到点的提醒：${reminders.message}
本轮检索到的健康资料（仅这些资料可作为健康事实依据）：
${knowledgeText}`;
  const contents = messages.map((message, index) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: index === messages.length - 1 ? context : message.text }],
  }));
  let toolRounds = 0;
  while (true) {
    statusElement.textContent =
      toolRounds === 0 ? "正在准备温和的答复…" : `正在分析第 ${toolRounds} 轮工具结果…`;
    const data = await callAgent(contents, key);
    const modelContent = data.candidates?.[0]?.content;
    if (!modelContent?.parts?.length) {
      throw new Error("Gemini 没有返回有效内容，请稍后重试。");
    }
    const calls = modelContent.parts
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall);
    if (!calls.length) {
      const answer = extractText(modelContent);
      if (!answer) throw new Error("Gemini 没有生成最终文字回答，请稍后重试。");
      return answer;
    }
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      throw new Error("工具调用超过 5 轮上限，请稍后简化问题再试。");
    }
    toolRounds += 1;
    contents.push(modelContent);
    const functionResponses = [];
    for (const functionCall of calls) {
      if (!["getReminders", "getWeather"].includes(functionCall.name)) {
        throw new Error(`模型请求了不支持的工具：${functionCall.name}`);
      }
      const toolLabel =
        functionCall.name === "getWeather" ? "查询实时天气" : "检查当天提醒";
      statusElement.textContent = `第 ${toolRounds} 轮：正在${toolLabel}…`;
      addActivity(`第 ${toolRounds} 轮 · ${toolLabel}`);
      const result = await executeTool(functionCall);
      addActivity(`${functionCall.name} 已返回数据`, JSON.stringify(result));
      functionResponses.push({
        functionResponse: { name: functionCall.name, response: result },
      });
    }
    contents.push({ role: "user", parts: functionResponses });
  }
}

async function initializeKnowledgeIndex() {
  if (isIndexing) return;
  isIndexing = true;
  updateControls();
  try {
    statusElement.textContent = "正在准备健康知识库…";
    const key = getApiKey();
    const chunks = getKnowledgeChunks();
    const fingerprint = getKnowledgeFingerprint(chunks);
    const cached = readCachedIndex(fingerprint, chunks);
    if (cached) {
      knowledgeIndex = cached;
      statusElement.textContent = `健康知识库已就绪（${chunks.length} 段），可以开始聊天。`;
      updateKeyStatus();
      return;
    }
    statusElement.textContent = `正在为 ${chunks.length} 段健康知识生成语义索引…`;
    knowledgeIndex = await embedKnowledge(chunks, key);
    try {
      localStorage.setItem(
        INDEX_CACHE_KEY,
        JSON.stringify({
          model: EMBEDDING_MODEL,
          fingerprint,
          vectors: knowledgeIndex.map(({ id, embedding }) => ({ id, values: embedding })),
        }),
      );
      statusElement.textContent = "健康知识库已就绪，可以开始聊天。";
    } catch (error) {
      console.warn("保存健康知识向量缓存失败：", error);
      statusElement.textContent = "知识库已就绪，但浏览器无法缓存向量；下次打开需重新生成。";
    }
    updateKeyStatus();
  } catch (error) {
    if (error instanceof Error && error.message === API_KEY_REQUIRED_MESSAGE) {
      statusElement.textContent = API_KEY_REQUIRED_MESSAGE;
      keyStatusElement.textContent = API_KEY_REQUIRED_MESSAGE;
    } else {
      console.error(error);
      showError(getUserFacingError(error));
      keyStatusElement.textContent = "知识库准备失败；请检查 Key、网络或模型权限后重试。";
    }
  } finally {
    isIndexing = false;
    updateControls();
  }
}

function updateControls() {
  sendButton.disabled = isWorking || isIndexing || knowledgeIndex.length === 0;
  questionInput.disabled = isWorking || isIndexing;
  clearButton.disabled = isWorking;
  document.querySelector("#save-api-key").disabled = isWorking || isIndexing;
}

function resizeInput() {
  questionInput.style.height = "auto";
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 160)}px`;
}

function showAlert(description) {
  alertDescription.textContent = description;
  alertContact.textContent = `建议联系：${profile.childName || "您的子女"}`;
  notifyStatus.textContent = "";
  alertCard.hidden = false;
  alertCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function detectAnomaly(question) {
  if (/摔倒|跌倒|摔了一跤|摔跤|跌了一跤/.test(question)) {
    showAlert("检测到您提到摔倒。请先不要勉强起身；如有受伤或剧烈疼痛，请立即求助。");
  } else if (/胸闷|胸痛|呼吸困难|喘不上气|昏倒|昏厥|意识不清/.test(question)) {
    showAlert("检测到您提到较严重的不适。请立即联系身边的人和当地急救服务。");
  } else if (/不舒服|头晕|眩晕/.test(question)) {
    showAlert("检测到您提到身体不舒服。建议先坐下休息，并联系家人或医护人员。");
  }
}

function populateSettings() {
  settingsForm.elements.namedItem("name").value = profile.name;
  settingsForm.elements.namedItem("morningTime").value = profile.morningTime;
  settingsForm.elements.namedItem("noonTime").value = profile.noonTime;
  settingsForm.elements.namedItem("nightTime").value = profile.nightTime;
  settingsForm.elements.namedItem("interests").value = profile.interests;
  settingsForm.elements.namedItem("city").value = profile.city;
  settingsForm.elements.namedItem("childName").value = profile.childName;
  settingsStatus.textContent = "";
}

document.querySelector("#settings-button").addEventListener("click", () => {
  populateSettings();
  settingsDialog.showModal();
});
document.querySelector("#close-settings").addEventListener("click", () => settingsDialog.close());
document.querySelector("#cancel-settings").addEventListener("click", () => settingsDialog.close());
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(settingsForm);
  const previousProfile = profile;
  profile = Object.fromEntries(
    Object.keys(DEFAULT_PROFILE).map((key) => [key, String(formData.get(key) || "").trim()]),
  );
  try {
    saveProfile();
    document.querySelector("#welcome-heading").textContent = profile.name
      ? `您好，${profile.name}！`
      : "您好，今天想聊些什么？";
    renderHistory();
    settingsDialog.close();
    statusElement.textContent = "个人信息已保存。";
  } catch (error) {
    profile = previousProfile;
    settingsStatus.textContent = getUserFacingError(error);
  }
});

document.querySelector("#simulate-button").addEventListener("click", () => {
  simulateDialog.showModal();
});
document.querySelector("#close-simulate").addEventListener("click", () => simulateDialog.close());
document.querySelector("#simulate-fall").addEventListener("click", () => {
  simulateDialog.close();
  showAlert("演示：系统模拟检测到摔倒。请先不要勉强起身；如有受伤，请立即求助。");
});
document.querySelector("#simulate-no-response").addEventListener("click", () => {
  simulateDialog.close();
  showAlert("演示：检测到您可能长时间没有回应。建议联系子女确认您的情况。");
});
document.querySelector("#notify-button").addEventListener("click", (event) => {
  // 仅更新演示界面状态，不向外部服务发送消息。
  event.currentTarget.disabled = true;
  notifyStatus.textContent = `已通知（演示）：${profile.childName || "您的子女"}。没有发送真实消息。`;
});
document.querySelector("#dismiss-alert").addEventListener("click", () => {
  alertCard.hidden = true;
  document.querySelector("#notify-button").disabled = false;
});

apiKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isWorking || isIndexing) return;
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatusElement.textContent = "请先输入 Gemini API Key。";
    apiKeyInput.focus();
    return;
  }
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  } catch (error) {
    console.error("保存 Gemini API Key 失败：", error);
    keyStatusElement.textContent = "无法保存 API Key，请检查浏览器存储设置。";
    return;
  }
  apiKeyInput.value = "";
  clearError();
  isVisitorApiKeyConfigured = true;
  keyStatusElement.textContent = "Key 已保存到当前浏览器，正在准备健康知识库…";
  knowledgeIndex = [];
  await initializeKnowledgeIndex();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question || isWorking || isIndexing) return;
  if (!knowledgeIndex.length) {
    showError("健康知识库尚未就绪，请先设置 Gemini API Key 并等待准备完成。");
    return;
  }

  clearError();
  isWorking = true;
  updateControls();
  const userMessage = { role: "user", text: question };
  messages.push(userMessage);
  renderMessage(userMessage);
  saveMessages();
  questionInput.value = "";
  resizeInput();
  beginActivity();
  addActivity("收到的消息", question);
  detectAnomaly(question);

  try {
    const key = getApiKey();
    statusElement.textContent = "正在检查今天的提醒…";
    const reminders = getReminders();
    addActivity("getReminders 已完成", reminders.message);
    let healthMatches = [];
    if (isHealthQuestion(question)) {
      statusElement.textContent = "正在检索健康知识…";
      const queryEmbedding = await embedText(question, key);
      const matches = retrieveChunks(queryEmbedding);
      if (matches[0]?.similarity >= MIN_HEALTH_SIMILARITY) {
        healthMatches = matches
          .filter((match) => match.similarity >= MIN_HEALTH_SIMILARITY)
          .slice(0, TOP_K);
      }
      addActivity(
        healthMatches.length ? "健康知识检索完成" : "未找到足够相关的健康知识",
        healthMatches.map((chunk) => chunk.title).join("、") || "回答时将说明知识库没有相关信息。",
      );
    }
    const answer = await runAgent(question, key, healthMatches, reminders);
    const assistantMessage = {
      role: "assistant",
      text: answer,
      sources: healthMatches.map((chunk) => chunk.title),
    };
    messages.push(assistantMessage);
    renderMessage(assistantMessage);
    saveMessages();
    statusElement.textContent = "回答完成。";
    finishActivity();
  } catch (error) {
    console.error(error);
    showError(getUserFacingError(error));
  } finally {
    isWorking = false;
    updateControls();
    questionInput.focus();
  }
});

questionInput.addEventListener("input", resizeInput);
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

clearButton.addEventListener("click", () => {
  if (isWorking) return;
  messages = [];
  try {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch (error) {
    console.error("清除对话记录失败：", error);
    showError("无法清除浏览器中的对话记录，请检查浏览器存储设置。");
    return;
  }
  clearError();
  statusElement.textContent = "对话已清空。";
  renderHistory();
});

renderHistory();
updateControls();
initializeKnowledgeIndex();
