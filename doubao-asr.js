/**
 * doubao-asr.js
 * 火山豆包 流式语音识别（ASR）封装。
 * 协议：单流 bigmodel_nostream（wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream）
 *   - 4 字节 header（version<<4|1, message_type<<4|flags, serialization<<4|compression, reserved）
 *   - + seq(4) + payload_size(4) + gzip(payload)
 *   - 鉴权：Header X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id / X-Api-Connect-Id / X-Api-Sequence
 * 输入：16kHz 单声道 16bit PCM WAV 字节
 * 返回：拼接后的识别文本
 */
"use strict";

const WebSocket = require("ws");
const gzip = require("zlib").gzipSync;
const gunzip = require("zlib").gunzipSync;
const crypto = require("crypto");

// 协议常量
const MSG_CLIENT_FULL_REQUEST = 0b0001;
const MSG_CLIENT_AUDIO_ONLY = 0b0010;
const MSG_SERVER_FULL_RESPONSE = 0b1001;
const MSG_SERVER_ERROR_RESPONSE = 0b1111;
const FLAG_NO_SEQ = 0b0000;
const FLAG_POS_SEQ = 0b0001;
const FLAG_NEG_SEQ = 0b0010;
const FLAG_NEG_WITH_SEQ = 0b0011;
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

function buildHeader(messageType, flags, serialization = SER_JSON, compression = COMP_GZIP) {
  const b = Buffer.alloc(4);
  b[0] = (0b0001 << 4) | 1; // protocol version 1
  b[1] = (messageType << 4) | flags;
  b[2] = (serialization << 4) | compression;
  b[3] = 0x00;
  return b;
}

function buildFullClientRequest(seq, uid) {
  const payload = {
    user: { uid: uid || "dylan-heartbeat" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: false
    }
  };
  const comp = gzip(Buffer.from(JSON.stringify(payload), "utf-8"));
  const head = buildHeader(MSG_CLIENT_FULL_REQUEST, FLAG_POS_SEQ);
  const buf = Buffer.alloc(head.length + 4 + 4 + comp.length);
  head.copy(buf, 0);
  buf.writeInt32BE(seq, head.length);
  buf.writeUInt32BE(comp.length, head.length + 4);
  comp.copy(buf, head.length + 8);
  return buf;
}

function buildAudioRequest(seq, segment, isLast) {
  const flags = isLast ? FLAG_NEG_WITH_SEQ : FLAG_POS_SEQ;
  const s = isLast ? -seq : seq;
  const comp = gzip(Buffer.from(segment));
  const head = buildHeader(MSG_CLIENT_AUDIO_ONLY, flags);
  const buf = Buffer.alloc(head.length + 4 + 4 + comp.length);
  head.copy(buf, 0);
  buf.writeInt32BE(s, head.length);
  buf.writeUInt32BE(comp.length, head.length + 4);
  comp.copy(buf, head.length + 8);
  return buf;
}

function parseServerMessage(msg) {
  if (!msg || msg.length < 4) return {};
  const headerSize = msg[0] & 0x0f;
  const messageType = msg[1] >> 4;
  const mtsf = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  let payload = msg.slice(headerSize * 4);
  const out = { messageType, mtsf, isLast: Boolean(mtsf & 0x02), code: 0 };
  if (mtsf & 0x01) {
    out.seq = payload.readInt32BE(0);
    payload = payload.slice(4);
  }
  if (mtsf & 0x04) {
    out.event = payload.readInt32BE(0);
    payload = payload.slice(4);
  }
  if (messageType === MSG_SERVER_FULL_RESPONSE) {
    out.payloadSize = payload.readUInt32BE(0);
    payload = payload.slice(4);
  } else if (messageType === MSG_SERVER_ERROR_RESPONSE) {
    out.code = payload.readInt32BE(0);
    out.payloadSize = payload.readUInt32BE(4);
    payload = payload.slice(8);
  }
  if (compression === COMP_GZIP && payload.length) {
    try { payload = gunzip(payload); } catch (e) { /* ignore */ }
  }
  if (serialization === SER_JSON && payload.length) {
    try { out.msg = JSON.parse(payload.toString("utf-8")); } catch (e) { /* ignore */ }
  }
  return out;
}

/**
 * 识别一段 16kHz/单声道/16bit PCM WAV。
 * @param {Buffer} wavBytes 16k mono 16bit WAV 的原始字节（含 WAV 头）
 * @param {Object} opts { token, resourceId, uid, segmentMs, connectTimeout }
 * @returns {Promise<string>} 识别出的文字
 */
function recognizeAsr(wavBytes, opts = {}) {
  const token = opts.token;
  const resourceId = opts.resourceId || "volc.seedasr.sauc.duration";
  const uid = opts.uid || "dylan-heartbeat";
  const segmentMs = opts.segmentMs || 200;
  const url = opts.url || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
  if (!token) return Promise.reject(new Error("缺少豆包 ASR API Key"));

  // 提取 WAV 里的 PCM data 区
  const pcm = extractWavPcm(wavBytes);
  if (!pcm || pcm.length === 0) return Promise.reject(new Error("无效音频数据"));

  return new Promise((resolve, reject) => {
    const headers = {
      "X-Api-Key": token,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
      "X-Api-Connect-Id": crypto.randomUUID(),
      "X-Api-Sequence": "-1"
    };
    const ws = new WebSocket(url, { headers });
    let seq = 1;
    let text = "";
    let finished = false;
    const segBytes = Math.floor(16000 * 2 * (segmentMs / 1000));

    // 超时随音频时长自适应：音频按 1:1 实时节奏分段发送（16k 采样 16bit 单声道 = 32000 字节/秒），
    // 固定超时会让长语音在发完前就被 abort；取「调用方上限」与「预计发送时长 + 15s 余量」的较大者。
    const asrTimeoutMs = Math.max(opts.timeoutMs || 20000, Math.ceil((pcm.length || 0) / 32000) * 1000 + 15000);
    const timer = setTimeout(() => {
      if (!finished) { try { ws.close(); } catch (e) {} reject(new Error("ASR 超时")); }
    }, asrTimeoutMs);

    function finish(err, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (err) reject(err);
      else resolve(result);
    }

    ws.on("open", () => {
      try {
        ws.send(buildFullClientRequest(seq, uid), { binary: true });
        seq += 1;
      } catch (e) { finish(new Error("ASR 发送请求失败: " + e.message)); return; }

      // 开始音频分段发送
      let pos = 0;
      const sender = setInterval(() => {
        try {
          const end = Math.min(pos + segBytes, pcm.length);
          const seg = pcm.slice(pos, end);
          const isLast = end >= pcm.length;
          ws.send(buildAudioRequest(seq, seg, isLast), { binary: true });
          seq += 1;
          pos = end;
          if (isLast) clearInterval(sender);
        } catch (e) { clearInterval(sender); finish(new Error("ASR 发送音频失败: " + e.message)); }
      }, Math.max(30, segmentMs));
    });

    ws.on("message", (data) => {
      try {
        const resp = parseServerMessage(data);
        if (resp.msg && resp.msg.result && resp.msg.result.text) {
          text += resp.msg.result.text;
        }
        // 结束条件：server error 或 msg 标记 is_last，或响应层 is_last
        if (resp.code !== 0) {
          const em = (resp.msg && (resp.msg.message || resp.msg.error)) || ("code=" + resp.code);
          finish(new Error("ASR 识别失败: " + em));
          return;
        }
        const msgIsLast = resp.msg && resp.msg.result && resp.msg.result.is_last;
        if (msgIsLast || resp.isLast) {
          finish(null, text.trim());
        }
      } catch (e) { /* ignore malformed frame */ }
    });

    ws.on("error", (err) => { finish(new Error("ASR WebSocket 错误: " + err.message)); });
    ws.on("close", () => {
      if (!finished) { finished = true; clearTimeout(timer); resolve(text.trim()); }
    });
  });
}

// 从 WAV 字节里提取 PCM data 区（支持标准 WAV 头）
function extractWavPcm(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  // 遍历 subchunks 找 'data'
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") return buf.slice(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  return null;
}

module.exports = { recognizeAsr };
