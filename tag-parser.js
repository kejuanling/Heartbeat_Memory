"use strict";

// tag-parser.js — AI 回复内轻量记号的解析入库与剥离：
//   extractAndStore：各收尾路径各调一次，识别 <memory>/<pin>/<star>/<paper> 并执行入库副作用
//                    （记忆池/永久上下文/标星/留纸），返回剥净全部标签的正文供下发/落盘；
//   stripTags      ：纯剥离，流式过滤与时间线内容匹配复用。

const memoryEngine = require("./memory-engine");

const PIN_TAG_RE = /<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi;
const MEMORY_TAG_RE = /<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi;
// 留纸轻量记号（2026-09-12）：<paper/>、<paper title="标题"/> 或成对 <paper title=".."></paper>（内部内容忽略）。
// 写记号 = 把整条回复落成一张纸（只写不注入上下文）；一条回复写多个也只落一张。
const PAPER_TAG_RE = /<\s*paper\b[^>]*>(?:[\s\S]*?<\s*\/paper\s*>)?/gi;

// 剥离所有 <memory>/<pin>/<star>/<paper> 标签（含属性写法、未闭合标签），供流式过滤/时间线匹配复用
function stripTags(text) {
  return String(text || "")
    .replace(/<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi, "")
    .replace(/<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi, "")
    .replace(/<\s*wake\b[^>]*>([\s\S]*?)<\s*\/wake\s*>/gi, "")
    .replace(/<\s*quiet\b[^>]*>([\s\S]*?)<\s*\/quiet\s*>/gi, "")
    .replace(/<\s*compacted\b[^>]*>([\s\S]*?)<\s*\/compacted\s*>/gi, "")
    .replace(/<\s*star\b[^>]*>(?:\s*<\s*\/star\s*>)?/gi, "")
    .replace(/<\s*paper\b[^>]*>(?:[\s\S]*?<\s*\/paper\s*>)?/gi, "")
    .replace(/<\s*(?:memory|pin|wake|quiet|compacted|star|paper)\b[^>]*>/gi, "")
    .replace(/<\s*(?:memory|pin|wake|quiet|compacted|star|paper)\b[^>]*$/gi, "");
}

// 宽松解析 {key:value,...}：值可不带引号，值里含逗号也能正确处理；
// 按 ",key:" 切分（只认已知键），兼容系统提示词教的 <pin>{title:...,content:...}</pin> 写法
function parseKeyValueBlock(raw, keys) {
  const trimmed = String(raw || "").trim().replace(/^\{|\}$/g, "");
  const re = new RegExp(",\\s*(?=(?:" + keys.join("|") + ")\\s*:)", "i");
  const parts = trimmed.split(re);
  const out = {};
  for (const part of parts) {
    const m = part.match(/^\s*(title|content|type|category|reason|pinned)\s*[:=]\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    out[key] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function parsePinContent(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.content) {
      return {
        title: parsed.title || '',
        content: parsed.content.trim()
      };
    }
  } catch {}

  // importance 已随 0920 重要级全链路删除退出解析（split 键保留 reason 以正确终止 content 取值）
  const out = parseKeyValueBlock(raw, ["title", "content", "reason"]);
  if (out.content) {
    return {
      title: out.title || '',
      content: out.content.trim()
    };
  }

  return null;
}

async function extractAndStore(text, ctx) {
  if (!text) return text;

  const promises = [];

  // --- <paper> 留纸轻量辅助（2026-09-12）：AI 写故事/梦/随手创作 → 落一张纸（只写、不注入上下文）。
  //     记号不包裹内容：整条回复（剥净所有标签后的正文全文）就是纸的内容；一条回复多个记号只落一张。
  //     ctx.sessionId 由各收尾路径传入，决定纸落到哪个会话目录；缺省落 _shared。 ---
  if (/<\s*paper\b/i.test(text)) {
    promises.push(
      Promise.resolve().then(function () {
        const papers = require("./papers");
        let title = "";
        const pm = text.match(/<\s*paper\b[^>]*?title\s*=\s*("([^"]*)"|'([^']*)'|([^\s>/]+))[^>]*>/i);
        if (pm) title = (pm[2] || pm[3] || pm[4] || "").trim();
        const body = stripTags(text).trim();
        if (!body) return null;
        const r = papers.savePaper({ sessionId: ctx && ctx.sessionId, content: body, title });
        if (r && r.ok) console.log("[tag-parser] <paper> 已留纸: id=" + r.id, title ? ("标题=" + title) : "");
        else console.warn("[tag-parser] <paper> 留纸失败:", (r && r.error) || "unknown");
        return r;
      }).catch(function (err) {
        console.warn("[tag-parser] <paper> 留纸异常:", err.message);
      })
    );
  }

  // --- <pin> 轻量辅助：AI 顺手钉选 → 永久注入上下文（memoryEngine.addPinnedMemory；
  //     不传 order 追加到尾部，避免打乱用户手动排序） ---
  const pinMatches = text.matchAll(PIN_TAG_RE);

  for (const match of pinMatches) {
    const raw = match[1];
    const parsed = parsePinContent(raw);

    if (parsed && parsed.content) {
      const entry = {
        title: parsed.title || '',
        content: parsed.content
        // 不传 order：交给 memory-engine 追加到尾部，避免 AI 顺手写的钉选永远插到最前打乱手动排序
      };
      promises.push(
        memoryEngine.addPinnedMemory(entry).then(result => {
          if (result) {
            console.log("[tag-parser] 钉选写入成功:", parsed.title || parsed.content.slice(0, 50));
          }
          return result;
        }).catch(err => {
          console.warn("[tag-parser] 钉选写入失败:", err.message);
        })
      );
    } else {
      console.warn("[tag-parser] pin标签解析失败:", raw.slice(0, 80));
    }

  }

  // <memory> → V2 待审池（2026-10-02 修复+改道）：0928-42 起本分支「直写 V2 主集合」，但 provenance.method
  //   误写 "memory_tag" 不在 PROVENANCE_METHODS 白名单（正确值 tag_inline，tests/admission 已锁定）→
  //   每次入库在 _buildEntry 抛错且失败路径静默无日志 → memory_v2.json 里 origin=memory_tag 恒为 0。
  //   现改为：复用 admission.executorMain 走 review 队列（人工批准才落主集合，与 V2「先审后入」一致），
  //   主集合+待审队列双查重，失败/跳过均有日志。（1002-14：quote 类已删，speaker 兜底逻辑随之移除）
  const V2_KIND_MAP = { "关于她": "fact", "认账": "rule", "拓本": "fact", "压缩摘要": "fact", "对话碎片": "fact", "关于我们": "fact", "锚点": "fact", "信号": "fact", "对话摘要": "fact" };
  const V2_KINDS = ["fact", "rule"];
  function getReviewExecutor() {
    // 优先复用 admission 单例 executorMain（唯一写手，避免多实例并发覆盖队列）；未初始化时自建兜底
    try {
      const adm = require("./memory-admission").getAdmission();
      if (adm && adm.executorMain) return adm.executorMain;
    } catch (e) { /* 自建兜底 */ }
    const { createStore } = require("./memory-v2");
    const { createStateExecutor } = require("./state-executor");
    return createStateExecutor({ store: createStore({ config: {} }) });
  }
  function memoryTagToV2(body, category, pinned, sessionId) {
    const { createStore } = require("./memory-v2");
    const store = createStore({ config: {} });
    const text = String(body || "").trim();
    if (!text) return { skipped: true };
    // 去重1：主集合 active 同正文已存在则跳过（对齐旧池自动去重语义）
    const dup = (store.list({ status: "active" }) || []).some(function (e) { return String(e.text || "").trim() === text; });
    if (dup) return { skipped: true };
    // 分类映射：旧类名 → kind；V2 枚举（fact/rule）直用（1002-14：quote/milestone 已删）
    let kind = category ? (V2_KIND_MAP[category] || (V2_KINDS.includes(category) ? category : null)) : null;
    if (!kind) kind = "fact";
    // 去重2：待审队列 pending_review 同正文（防 AI 每轮回复重复写同一标签堆队列）
    const executor = getReviewExecutor();
    let dupQueue = false;
    try {
      dupQueue = (executor.listQueue("pending_review") || []).some(function (r) { return r.draft && String(r.draft.text || "").trim() === text; });
    } catch (e) { dupQueue = false; }
    if (dupQueue) return { skipped: true };
    const draft = {
      text: text,
      kind: kind,
      origin: "memory_tag",
      provenance: { method: "tag_inline", session_id: sessionId || null },
    };
    const r = executor.review(draft, "AI 标签（<memory>）自动进审，待人工裁决", { details: [{ source: "memory_tag", category: category || null, pinned: pinned === true }] });
    return r && r.ok ? { added: 1, queue_id: r.queue_id } : { skipped: false, error: r && r.error };
  }

  // --- <memory> 轻量辅助：AI 顺手写的重要记忆 → 记忆池（自动去重，非必需） ---
  // 只允许前三类（关于她/认账/拓本），标签内开头写 {category:"认账"} 指定分类（重要级已删，0920），如
  //   <memory>{category:"认账"}她情绪低落时先抱住她，别急着讲道理</memory>
  //   <memory>{category:"拓本"}涵（9-12）："因为是你。"</memory>
  // 写了别的分类（压缩摘要/对话碎片/旧类名）一律视为没写，交给 LLM 从前三类里判
  const memoryMatches = text.matchAll(MEMORY_TAG_RE);
  for (const match of memoryMatches) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    let body = raw, category = "", pinned = false;
    const metaMatch = raw.match(/^\s*\{[\s\S]*?\}\s*([\s\S]*)$/);
    if (metaMatch && /^\s*\{/.test(raw)) {
      const head = raw.slice(0, raw.indexOf("}") + 1);
      const kv = parseKeyValueBlock(head, ["category", "type", "pinned"]); // importance 已删：残留值不解析静默丢弃
      if (kv.category) category = String(kv.category).trim();
      if (kv.pinned) pinned = (String(kv.pinned) === "true" || String(kv.pinned) === "1");
      body = metaMatch[1].trim();
    }
    if (!body) continue;
    promises.push(
      Promise.resolve().then(function () {
        return memoryTagToV2(body, category, pinned, ctx && ctx.sessionId);
      }).then(function (r) {
        if (r && r.added) {
          console.log("[tag-parser] <memory> 已进待审池:", body.slice(0, 50), r.queue_id || "");
        } else if (r && r.skipped) {
          console.log("[tag-parser] <memory> 重复跳过:", body.slice(0, 50));
        } else {
          console.warn("[tag-parser] <memory> 进待审失败:", (r && r.error) || "unknown");
        }
        return r;
      }).catch(function (err) {
        console.warn("[tag-parser] <memory> 入库失败:", err.message);
      })
    );
  }

  // --- <star> 轻量辅助：AI 觉得这条回复重要 → 自标星（原文保留在上下文、不参与压缩，不入记忆池；
  //     与用户手动标星 / context_star 工具共用同一套 marks 存储）。注意：唤醒路径本函数会被执行两次
  //     （wake_up 传剥过 <wake> 的文本、网关传原文），前者的 key 与落盘原文不一致会留一条不命中的幽灵
  //     marks 条目——无害，真正生效的是网关侧那次；setMark 幂等，重复写只是刷新 markedAt。 ---
  //     1007-17 标星改 msgid：主对话路径（routes/chat.js 流式/非流式两处）落盘前就能拿到前端预生成的
  //     reply_msg_id，ctx.msgId 传进来后按消息 id 存，编辑后不漂移。MCP 分支与唤醒路径的落盘在标签解析
  //     之后、拿不到 id，ctx.msgId 为空 → 回落原内容键；marks 判定已是双查，内容键同样认，行为不变。 ---
  if (/<\s*star\b/i.test(text)) {
    promises.push(
      Promise.resolve().then(function () {
        const cr = require("./context-replacements");
        const _mid = (ctx && ctx.msgId) ? String(ctx.msgId).trim() : "";
        const key = _mid || cr.contentKey({ role: "assistant", content: text });
        const r = cr.setMark(key, true, { content: text, role: "assistant", msg_time: new Date().toISOString() });
        if (r && r.ok) console.log("[tag-parser] <star> 已标星本条回复 key=", key);
        return r;
      }).catch(function (err) {
        console.warn("[tag-parser] <star> 标星失败:", err.message);
      })
    );
  }

  await Promise.all(promises);
  return stripTags(text).trim();
}

module.exports = { extractAndStore, stripTags };
