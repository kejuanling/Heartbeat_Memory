"use strict";

const memoryEngine = require("./memory-engine");
const fs = require("fs");
const path = require("path");

// ========================
// 配置
// ========================
const TARGET_API_URL = process.env.TARGET_API_URL;
const TARGET_API_KEY = process.env.TARGET_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME;

const SUMMARY_TIMEOUT_MS = 60_000;

// ========================
// 状态
// ========================
let idleTimer = null;
let maxIntervalTimer = null;
let isRunning = false;

// ========================
// 人设加载（优先读时间线里的 system 消息，缺失时用兜底）
// ========================
function loadPersona() {
  try {
    const file = path.join(__dirname, "enhanced_messages.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const sys = (Array.isArray(data) ? data : []).find(m => m && m.role === "system");
    const content = sys && sys.content ? String(sys.content).trim() : "";
    if (content) return content;
  } catch (err) {
    // 人设文件缺失时使用兜底人设
  }
  return "你是一个理性但有温度、表面温柔内心有主见的 AI。你有一位重要的对话伙伴。";
}

const PERSONA = loadPersona();

// ========================
// 摘要提示词（可配置，保存于 data/summary_prompt.json）
// ========================
const SUMMARY_PROMPT_FILE = path.join(__dirname, "data", "summary_prompt.json");

const DEFAULT_SUMMARY_SYSTEM = "请以你的身份和口吻，根据对话内容写出第一人称的回忆摘要；称呼对方为她，不要使用\"用户\"。";

const DEFAULT_SUMMARY_TEMPLATE = `请根据你与对方在最近一段时间内的对话，写一段第一人称回忆摘要。

人设：
\${PERSONA}

要求：
1. 以"我记得……"开头。
2. 全程第一人称，像你在回忆里写下的话；称呼对方为"她"，绝对不要使用"用户"这个词。
3. 只提炼事实脉络、情绪转折和未完成事项，不评价。
4. 若消息很多，优先提炼对方原话中的关键事实和情绪转折，舍弃重复性寒暄。
5. 字数控制在 150 字以内。
6. 记忆自然地展现：叙述中自然地写出相关对话发生的日期和时间，让回忆有时间感。

对话原文：
\${conversationText}

我的回忆摘要（第一人称）：`;

function loadSummaryPromptConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SUMMARY_PROMPT_FILE, "utf-8"));
    if (cfg && typeof cfg.template === "string" && cfg.template.trim()) {
      return {
        system: typeof cfg.system === "string" && cfg.system.trim() ? cfg.system : DEFAULT_SUMMARY_SYSTEM,
        template: cfg.template
      };
    }
  } catch (err) {
    // 配置文件缺失或损坏时使用默认提示词
  }
  return { system: DEFAULT_SUMMARY_SYSTEM, template: DEFAULT_SUMMARY_TEMPLATE };
}

function renderSummaryTemplate(cfg) {
  return cfg.template
    .replace("${PERSONA}", PERSONA)
    .replace("${conversationText}", "【此处为待摘要的对话原文】");
}

function buildSummarySystemPrompt() {
  return loadSummaryPromptConfig().system;
}

function buildSummaryPrompt(messages) {
  const conversationText = messages
    .map(m => {
      const role = m.role === "user" ? (process.env.USER_DISPLAY_NAME || "对方") : "我";
      return `[${role}] ${m.content}`;
    })
    .join("\n\n");

  const cfg = loadSummaryPromptConfig();
  return cfg.template
    .replace("${PERSONA}", PERSONA)
    .replace("${conversationText}", conversationText);
}

function getSummaryPromptForDisplay() {
  const cfg = loadSummaryPromptConfig();
  return {
    system: cfg.system,
    template: cfg.template,
    prompt: renderSummaryTemplate(cfg)
  };
}

function saveSummaryPromptConfig(system, template) {
  const dir = path.dirname(SUMMARY_PROMPT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    system: String(system || "").trim(),
    template: String(template || "")
  };
  if (!cfg.template.trim()) throw new Error("模板不能为空");
  fs.writeFileSync(SUMMARY_PROMPT_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  return cfg;
}

function resetSummaryPromptConfig() {
  if (fs.existsSync(SUMMARY_PROMPT_FILE)) fs.unlinkSync(SUMMARY_PROMPT_FILE);
  return { system: DEFAULT_SUMMARY_SYSTEM, template: DEFAULT_SUMMARY_TEMPLATE };
}

// ========================
// 执行摘要生成
// ========================
async function runSummary() {
  if (isRunning) {
    console.log("[summary-engine] 上一次摘要仍在进行中，跳过本次");
    return;
  }

  const pending = memoryEngine.getPendingMessages();
  if (!pending || pending.length === 0) {
    console.log("[summary-engine] 无待处理消息，跳过摘要");
    return;
  }

  isRunning = true;
  memoryEngine.setSummaryRunning(true);

  // Move toProcess outside try so catch block can restore it
  const toProcess = pending.splice(0, 50);

  if (toProcess.length === 0) {
    isRunning = false;
    memoryEngine.setSummaryRunning(false);
    return;
  }

  console.log(`[summary-engine] 开始摘要，处理 ${toProcess.length} 条消息`);

  try {
    const prompt = buildSummaryPrompt(toProcess);

    if (!TARGET_API_URL || !TARGET_API_KEY || !MODEL_NAME) {
      console.warn("[summary-engine] TARGET_API_URL / TARGET_API_KEY / MODEL_NAME 未配置，回填消息");
      pending.unshift(...toProcess);
      memoryEngine.persistPendingMessages();
      isRunning = false;
      memoryEngine.setSummaryRunning(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TARGET_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: buildSummarySystemPrompt() },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1200,
        stream: false
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === "length") {
      console.warn("[summary-engine] 摘要被输出上限截断（finish_reason=length），回填消息稍后重试");
      pending.unshift(...toProcess);
      memoryEngine.persistPendingMessages();
      isRunning = false;
      memoryEngine.setSummaryRunning(false);
      return;
    }
    const summaryText = data.choices?.[0]?.message?.content?.trim();

    if (!summaryText) {
      console.warn("[summary-engine] 摘要内容为空，回填消息");
      pending.unshift(...toProcess);
      memoryEngine.persistPendingMessages();
      isRunning = false;
      memoryEngine.setSummaryRunning(false);
      return;
    }

    // 提取时间范围
    const now = new Date();
    const timeRange = {
      start: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      end: now.toISOString()
    };

    // 存入记忆池
    await memoryEngine.addMemory({
      content: summaryText,
      type: "summary",
      importance: 0.55,
      source: "summary",
      time_range: timeRange
    });

    // 更新最后摘要时间
    memoryEngine.setLastSummaryTime(now.toISOString());
    // 成功路径也要落盘：已处理的消息从 state.json 中移除，避免重启后重复总结
    memoryEngine.persistPendingMessages();

    console.log("[summary-engine] 摘要已生成并存入记忆池");
  } catch (err) {
    // Restore messages on ANY failure (timeout, network, parse error)
    console.error("[summary-engine] 摘要生成失败，回填消息:", err.message);
    pending.unshift(...toProcess);
    memoryEngine.persistPendingMessages();
  } finally {
    isRunning = false;
    memoryEngine.setSummaryRunning(false);
  }
}

// ========================
// 重置沉默计时器（每次用户发消息时调用）
// ========================
function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const config = memoryEngine.config;
  const threshold = (config.idle_threshold_minutes || 5) * 60 * 1000;

  idleTimer = setTimeout(() => {
    if (!memoryEngine.config.auto_summary_enabled) {
      console.log("[summary-engine] 自动摘要已关闭，跳过沉默触发");
      return;
    }
    console.log("[summary-engine] 沉默触发：已超过阈值，生成摘要");
    runSummary();
  }, threshold);
}

// ========================
// 启动时钟兜底（保底触发）
// ========================
function startMaxIntervalTimer() {
  if (maxIntervalTimer) {
    clearInterval(maxIntervalTimer);
  }

  const config = memoryEngine.config;
  const interval = (config.max_interval_minutes || 30) * 60 * 1000;

  maxIntervalTimer = setInterval(() => {
    if (!memoryEngine.config.auto_summary_enabled) {
      console.log("[summary-engine] 自动摘要已关闭，跳过兜底触发");
      return;
    }
    console.log("[summary-engine] 时钟兜底触发：已到最大间隔");
    runSummary();
  }, interval);
}

// ========================
// 初始化
// ========================
function init() {
  startMaxIntervalTimer();
  console.log("[summary-engine] 已启动，沉默阈值:", memoryEngine.config.idle_threshold_minutes || 5, "分钟，兜底间隔:", memoryEngine.config.max_interval_minutes || 30, "分钟");
}

// ========================
// 手动触发（供管理页调用）
// ========================
async function triggerNow() {
  return runSummary();
}

// ========================
// 清理
// ========================
function shutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  if (maxIntervalTimer) clearInterval(maxIntervalTimer);
  idleTimer = null;
  maxIntervalTimer = null;
}

// Allows dynamic restart of max interval timer after config changes
function restartMaxIntervalTimer() {
  if (maxIntervalTimer) {
    clearInterval(maxIntervalTimer);
    maxIntervalTimer = null;
  }
  startMaxIntervalTimer();
  console.log("[summary-engine] maxIntervalTimer 已重启，间隔:", memoryEngine.config.max_interval_minutes || 30, "分钟");
}

module.exports = { init, resetIdleTimer, triggerNow, shutdown, restartMaxIntervalTimer, buildSummarySystemPrompt, getSummaryPromptForDisplay, saveSummaryPromptConfig, resetSummaryPromptConfig };
