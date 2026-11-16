# 安心陪伴：家庭养老 AI 守护

纯 HTML、CSS、JavaScript 的端到端 Agent 演示，没有后端服务。包含温和陪聊、浏览器长期记忆、日常提醒、健康知识 RAG、Open-Meteo 天气查询，以及不实际发送通知的异常演示卡片。

## 本地运行

1. 在 [Google AI Studio](https://aistudio.google.com/apikey) 创建 Gemini API Key。
2. 公开部署时不要填写或发布自己的 Key。在页面顶部输入访客自己的 Gemini API Key 并点击“保存”；Key 使用密码框输入，保存在访客当前浏览器的 `localStorage`，后续优先使用该 Key。若访客尚未保存 Key，程序才读取 `config.js` 中的 Key。`config.js` 已加入 `.gitignore`，可参考 [config.example.js](./config.example.js)。
3. 使用 VS Code Live Server 等本地静态服务器打开 `index.html`。Gemini Embedding 和 Open-Meteo 需要网络连接。

聊天模型为 `gemini-3-flash-preview`，向量模型为 `gemini-embedding-001`。首次加载时为内置健康知识生成 embedding，并缓存到浏览器；聊天记录和个人信息也保存在浏览器 `localStorage`。聊天中的工具调用循环最多 5 轮。

## Agent 工作流程

1. 健康问题先与 [knowledge.js](./knowledge.js) 的 9 段健康知识计算向量相似度，再将命中内容交给 Gemini；回答引用资料标题。没有足够相关的知识时，说明知识库没有相关信息，不猜测。
2. 每次对话都会调用 `getReminders` 查看当天尚未到时间的服药和散步提醒。时间及药物可在“设置我的信息”中修改。
3. 天气问题由 Gemini 调用 `getWeather`，通过 Open-Meteo 地理编码和天气接口查询；天气与散步提醒可在回答中综合考虑。城市可以在个人信息中设置。
4. 检测到摔倒、头晕、胸闷等异常关键词时显示通知子女卡片。“模拟异常”可展示模拟摔倒或长时间未回应场景；“模拟发送通知”只改变页面状态，不联系任何人。

## 演示限制与隐私

本项目不是医疗产品，健康知识仅供一般参考，不用于诊断或治疗。遇到严重胸痛、呼吸困难、意识不清等紧急情况，应联系当地急救服务。提醒功能不会在页面关闭时发送系统通知，也不代表已服药。

这是纯前端演示，写入 `config.js` 的 Key 会随网站文件公开，不应放入自己的真实 Key。公开演示应留空或只使用配置模板，让访客输入自己的受限 Key。个人信息、聊天记录和访客 Key 保存在当前浏览器本地。
