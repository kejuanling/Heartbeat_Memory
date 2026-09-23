'use strict';
// 按用途路由模型（2026-09-24）：压缩/记忆/rerank 等后台任务可各自指定供应商+模型，
// role_models 空 = 跟随全局默认聊天供应商。配置与 providers 同存 ai-providers.json。
// 所有后台 LLM 调用点统一从这里取 {provider, model}，不再各自读 env TARGET_API_*。
const fs = require("fs");
const path = require("path");

const AI_PROVIDERS_CONFIG = path.join(__dirname, "ai-providers.json");

const KNOWN_MODEL_ROLES = {
  compaction:   "压缩摘要",
  memory_admit: "记忆准入",
  memory_pool:  "记忆提炼",
  reparse:      "摘要解析",
  digest:       "回看摘要",
  rerank:       "记忆重排",
  co_chat:      "共影对话"
};

function loadProviders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AI_PROVIDERS_CONFIG, "utf-8"));
    return Array.isArray(cfg) ? cfg : (Array.isArray(cfg.providers) ? cfg.providers : []);
  } catch (e) { return []; }
}
function loadProvidersConfigRaw() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AI_PROVIDERS_CONFIG, "utf-8"));
    return (cfg && typeof cfg === "object") ? cfg : {};
  } catch (e) { return {}; }
}
function loadRoleModelsRaw() {
  const cfg = loadProvidersConfigRaw();
  const rm = cfg.role_models;
  return (rm && typeof rm === "object") ? rm : {};
}
function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}
function saveRoleModel(role, entry) {
  if (!KNOWN_MODEL_ROLES[role]) return false;
  const cfg = loadProvidersConfigRaw();
  const rm = (cfg.role_models && typeof cfg.role_models === "object") ? cfg.role_models : {};
  if (!entry || (!entry.provider_id && !entry.model)) delete rm[role];
  else rm[role] = { provider_id: String(entry.provider_id || ""), model: String(entry.model || "") };
  writeJsonAtomic(AI_PROVIDERS_CONFIG, { providers: loadProviders(), role_models: rm });
  return true;
}
function resolveActiveProvider() {
  const ps = loadProviders();
  const def = ps.find(p => p.is_default === true && p.enabled !== false && (p.api_url || p.base_url) && p.api_key);
  if (def) return def;
  return ps.find(p => p.enabled !== false && (p.api_url || p.base_url) && p.api_key) || null;
}
// 返回 {provider, model}；都没有时 provider=null, model=""（调用方决定是否抛错）
function resolveRoleModel(role) {
  const providers = loadProviders();
  const usable = p => p && p.enabled !== false && (p.api_url || p.base_url) && p.api_key;
  const entry = loadRoleModelsRaw()[role];
  if (entry && entry.provider_id) {
    const hit = providers.find(p => p.id === entry.provider_id && usable(p));
    if (hit) {
      const list = Array.isArray(hit.models) && hit.models.length ? hit.models : (hit.model ? [hit.model] : []);
      const m = entry.model && list.indexOf(entry.model) >= 0 ? entry.model : (hit.model || list[0] || "");
      return { provider: hit, model: m };
    }
    console.warn("[resolveRoleModel] role " + role + " provider unavailable, fallback default: " + entry.provider_id);
  }
  const active = resolveActiveProvider();
  if (active) return { provider: active, model: active.model || (Array.isArray(active.models) ? active.models[0] : "") || "" };
  return { provider: null, model: "" };
}

module.exports = { KNOWN_MODEL_ROLES, loadProviders, loadRoleModelsRaw, saveRoleModel, resolveRoleModel, resolveActiveProvider };
