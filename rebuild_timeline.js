// rebuild_timeline.js — 用每条消息 content 里的 <current_time> 标签重新推导秒级 time 字段
// 运行于服务器 /opt/dylan-heartbeat 下: node rebuild_timeline.js
// 只改那些带 <current_time> 标签的消息;先确保已备份 enhanced_messages.json。
const fs = require("fs");
const { zonedWallTimeToDate } = require("./time_utils");

const FILE = "/opt/dylan-heartbeat/enhanced_messages.json";
const TMP = FILE + ".rebuild.tmp";
const TZ = process.env.TIME_ZONE || "Asia/Shanghai";

// 运行前置检查（2026-09-20 审查 F-1）：本脚本与 gateway 并行写同一时间线文件会互相覆盖
// （双进程实测：gateway 持续 append 时跑一次本脚本，约 13% 消息被旧快照吞掉）。
// 检测到 pm2 gateway 在线直接拒绝退出；停写期间跑完再启动（pm2 stop/start gateway）。
const { execSync } = require("child_process");
let gwPid = "";
try { gwPid = execSync("pm2 pid gateway 2>/dev/null", { encoding: "utf8" }).trim(); } catch (e) {}
if (gwPid && Number(gwPid) > 0) {
  console.error("检测到 gateway 正在运行 (pid " + gwPid + ")。与本脚本并行会互相覆盖丢消息（实测丢约 13%）。");
  console.error("请先执行 `pm2 stop gateway`，跑完本脚本后再 `pm2 start gateway`。");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (!Array.isArray(data)) { console.error("not an array: ", typeof data); process.exit(1); }

const re = /<current_time>[\s\S]*?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/;
let tagged = 0, changed = 0;
for (const m of data) {
  const c = String((m && m.content) || "");
  const mm = c.match(re);
  if (!mm) continue;
  tagged++;
  const sec = mm[6] ? Number(mm[6]) : 0;
  const d = zonedWallTimeToDate({
    year: 2000 + Number(mm[1]),
    month: Number(mm[2]),
    day: Number(mm[3]),
    hour: Number(mm[4]),
    minute: Number(mm[5]),
    second: sec
  }, TZ);
  const iso = d.toISOString();
  if (m.time !== iso) { m.time = iso; changed++; }
}

fs.writeFileSync(TMP, JSON.stringify(data, null, 2), "utf8");
fs.renameSync(TMP, FILE);
console.log(`total=${data.length} tagged=${tagged} changed=${changed} TZ=${TZ}`);
