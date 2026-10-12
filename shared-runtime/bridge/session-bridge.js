/**
 * shared-runtime/bridge/session-bridge.js — SessionStore 页面桥接
 *
 * 职责：仅把 SessionStore 暴露到 window.SessionStore，供未来 inline script 迁移使用。
 *
 * 约束（本文件唯一职责，禁止扩展）：
 *   - 不自动初始化 SessionStore
 *   - 不自动读取 currentSession
 *   - 不自动调用任何 API / 事件 / UI
 *   - 不引入框架
 *
 * 唯一副作用 = 暴露对象本身（这是本桥的定义义务）；其余一律不触发。
 */
import { SessionStore } from "../storage/session.js";

if (typeof window !== "undefined") {
  window.SessionStore = SessionStore;
}