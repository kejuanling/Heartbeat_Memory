#!/usr/bin/env python3
"""
📷 图片转文字 OCR API
端口: 8790
支持: 中英文识别
用法: POST /ocr 上传图片返回文字 / POST /upload 仅上传保存返回路径
"""
from flask import Flask, request, jsonify
import pytesseract
from PIL import Image
import io
import base64
import logging
import os
import time
import uuid

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('ocr-api')

app = Flask(__name__)

API_TOKEN = os.environ.get('OCR_TOKEN', '')  # 值在 /opt/dylan-heartbeat/.env（启动时 set -a source 注入）
DEFAULT_LANG = os.environ.get('OCR_LANG', 'chi_sim+eng')
MAX_SIZE = 10 * 1024 * 1024
UPLOAD_DIR = '/tmp/ocr_uploads'
os.makedirs(UPLOAD_DIR, exist_ok=True)

def check_token():
    if not API_TOKEN:
        return True
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    token = token or request.args.get('token', '')
    return token == API_TOKEN

def do_ocr(image_bytes, lang=None):
    lang = lang or DEFAULT_LANG
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode != 'L':
        img = img.convert('L')
    text = pytesseract.image_to_string(img, lang=lang, config='--psm 6')
    return text.strip()

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'service': 'ocr-api', 'lang': DEFAULT_LANG})

@app.route('/ocr', methods=['POST'])
def ocr():
    if not check_token():
        return jsonify({'error': '未授权'}), 401
    lang = request.args.get('lang', DEFAULT_LANG)
    start = time.time()
    try:
        if 'image' in request.files:
            f = request.files['image']
            data = f.read()
        elif request.is_json and 'image' in request.json:
            data = base64.b64decode(request.json['image'])
        elif request.data:
            data = request.data
        else:
            return jsonify({'error': '未提供图片，请用 image 字段上传'}), 400
        if len(data) > MAX_SIZE:
            return jsonify({'error': f'图片过大，上限 {MAX_SIZE//1024//1024}MB'}), 413
        text = do_ocr(data, lang)
        elapsed = round(time.time() - start, 2)
        log.info(f'OCR 完成 lang={lang} size={len(data)} time={elapsed}s chars={len(text)}')
        return jsonify({'text': text, 'lang': lang, 'time': elapsed, 'chars': len(text)})
    except Exception as e:
        log.error(f'OCR 失败: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/upload', methods=['POST'])
def upload():
    """仅上传图片保存到服务器，返回文件路径（不做 OCR）"""
    if not check_token():
        return jsonify({'error': '未授权'}), 401
    try:
        if 'image' in request.files:
            f = request.files['image']
            ext = os.path.splitext(f.filename)[1] or '.jpg'
            data = f.read()
        elif request.is_json and 'image' in request.json:
            data = base64.b64decode(request.json['image'])
            ext = '.jpg'
        elif request.data:
            data = request.data
            ext = '.jpg'
        else:
            return jsonify({'error': '未提供图片'}), 400
        if len(data) > MAX_SIZE:
            return jsonify({'error': f'图片过大，上限 {MAX_SIZE//1024//1024}MB'}), 413
        filename = f"img_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
        filepath = os.path.join(UPLOAD_DIR, filename)
        with open(filepath, 'wb') as fp:
            fp.write(data)
        log.info(f'图片已保存: {filepath} size={len(data)}')
        return jsonify({'path': filepath, 'filename': filename, 'size': len(data)})
    except Exception as e:
        log.error(f'上传失败: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/')
def index():
    return jsonify({
        'service': '图片转文字 OCR API',
        'endpoints': {
            'POST /ocr': '上传图片识别文字 (multipart image 字段 或 base64 JSON)',
            'POST /upload': '仅上传图片保存到服务器，返回文件路径',
            'GET /health': '健康检查',
        },
        'params': 'lang=chi_sim+eng(默认) / eng / chi_sim',
        'auth': 'Header Authorization: Bearer <token> 或 ?token=<token>',
        'upload_dir': UPLOAD_DIR
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8790, debug=False)
