require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mysql = require('mysql2');
const ExcelJS = require('exceljs');
const session = require('express-session');
const path = require('path');



const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadBufferToCloudinary(buffer, mimetype) {
  return new Promise((resolve, reject) => {
    const isVideo = mimetype?.startsWith('video/');
    const isHeic = mimetype === 'image/heic' || mimetype === 'image/heif';

    const resource_type = isVideo ? 'video' : 'image';

    // ✅ ถ้าเป็น HEIC/HEIF ให้แปลงเป็น JPG ตอนอัปโหลด
    const options = {
      resource_type,
      folder: 'hi-form',
      ...(isHeic ? { format: 'jpg' } : {})
    };

    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });

    stream.end(buffer);
  });
}




// =========================
// File Upload Limits Config
// =========================
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;      // 10MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;      // 50MB
const MAX_TOTAL_SIZE_SUBMIT = 100 * 1024 * 1024;   // 100MB (รวมทั้งหมด /submit)
const MAX_TOTAL_SIZE_COMPLETE = 50 * 1024 * 1024;  // 50MB (รวมทั้งหมด /complete)

const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic', // ✅ เพิ่ม
  'image/heif', // ✅ เพิ่ม

  // Videos
  'video/mp4',
  'video/quicktime', // .mov
  'video/webm'
];

const memoryStorage = multer.memoryStorage();

// กรองชนิดไฟล์
function commonFileFilter(req, file, cb) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();

  // ✅ อนุญาตจาก MIME ที่เรารู้จัก
  if (ALLOWED_MIME_TYPES.includes(mime)) return cb(null, true);

  // ✅ กันเคส iPhone / Browser ส่งมาเป็น octet-stream แต่ชื่อไฟล์เป็น .heic/.heif/.jpg/.png/.mp4 ฯลฯ
  const extOK = /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|webm)$/i.test(name);
  if (mime === 'application/octet-stream' && extOK) return cb(null, true);

  return cb(new Error(`ไม่รองรับไฟล์ประเภท ${file.mimetype}`));
}

// สำหรับ /submit (ประชาชนส่งคำร้อง)
const uploadSubmit = multer({
  storage: memoryStorage,
  limits: {
    files: 10,               // ✅ สูงสุด 10 ไฟล์
    fileSize: MAX_VIDEO_SIZE // ✅ จำกัดต่อไฟล์สูงสุด 50MB
  },
  fileFilter: commonFileFilter
});

// สำหรับ /complete-with-media/:id (แนบไฟล์ตอนเสร็จสิ้น)
const uploadComplete = multer({
  storage: memoryStorage,
  limits: {
    files: 5,                // ✅ สูงสุด 5 ไฟล์
    fileSize: MAX_VIDEO_SIZE // ✅ จำกัดต่อไฟล์สูงสุด 50MB
  },
  fileFilter: commonFileFilter
});

// เช็กละเอียด (แยกรูป/วิดีโอ + ขนาดรวม)
function validateFiles(files = [], options = {}) {
  const {
    maxTotalSize = MAX_TOTAL_SIZE_SUBMIT,
    maxImageSize = MAX_IMAGE_SIZE,
    maxVideoSize = MAX_VIDEO_SIZE
  } = options;

  let totalSize = 0;

  for (const f of files) {
    totalSize += (f.size || 0);

    const mime = (f.mimetype || '').toLowerCase();
    const name = (f.originalname || '').toLowerCase();

    let isImage = mime.startsWith('image/');
    let isVideo = mime.startsWith('video/');

    // ✅ เคส octet-stream ให้เดาจากนามสกุลไฟล์
    if (!isImage && !isVideo && mime === 'application/octet-stream') {
      if (/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) isImage = true;
      if (/\.(mp4|mov|webm)$/i.test(name)) isVideo = true;
    }

if (!isImage && !isVideo) {
  throw new Error(`ไฟล์ "${f.originalname}" ไม่ใช่รูปภาพหรือวิดีโอ`);
}

    if (isImage && f.size > maxImageSize) {
      throw new Error(`ไฟล์รูป "${f.originalname}" มีขนาดเกิน 10MB`);
    }

    if (isVideo && f.size > maxVideoSize) {
      throw new Error(`ไฟล์วิดีโอ "${f.originalname}" มีขนาดเกิน 50MB`);
    }
  }

  if (totalSize > maxTotalSize) {
    const maxMB = Math.round(maxTotalSize / (1024 * 1024));
    throw new Error(`ขนาดไฟล์รวมเกิน ${maxMB}MB กรุณาลดจำนวนหรือขนาดไฟล์`);
  }

  return true;
}

// แปลง Multer error เป็นข้อความไทย
function handleMulterError(err, res) {
  console.error('Multer error:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('ไฟล์มีขนาดใหญ่เกินกำหนด (สูงสุด 50MB ต่อไฟล์)');
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).send('จำนวนไฟล์เกินที่ระบบกำหนด');
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).send('ชื่อฟิลด์ไฟล์ไม่ถูกต้อง');
    }
    return res.status(400).send(`อัปโหลดไฟล์ไม่สำเร็จ: ${err.code}`);
  }

  return res.status(400).send(err.message || 'อัปโหลดไฟล์ไม่สำเร็จ');
}
function detectFileType(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();

  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';

  // octet-stream → เดาจากนามสกุล
  if (/\.(mp4|mov|webm)$/i.test(name)) return 'video';
  if (/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) return 'image';

  return 'raw';
}


// LINE Webhook (ต้องอยู่ก่อน 404)
// =========================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  ssl: { rejectUnauthorized: false }
});

db.query('SELECT 1', (err) => {
  if (err) console.error('❌ MySQL error:', err);
  else console.log('✅ MySQL connected!');
});


const crypto = require('crypto');



function normalizeThaiPhone(input = '') {
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('66') && digits.length >= 11) return '0' + digits.slice(2);
  return digits;
}

function genBindToken() {
  return crypto.randomBytes(18).toString('base64url'); // เดายาก + ใช้ใน URL ได้
}

function maskPhone(phone='') {
  const p = normalizeThaiPhone(phone);
  if (p.length < 10) return p;
  return `${p.slice(0,3)}-xxx-${p.slice(-4)}`;
}

async function pushLineMessage(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK push]', to, text);
    return;
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text }]
    })
  });

  if (!res.ok) console.error('LINE push failed:', await res.text());
}
async function unlinkRichMenuFromUser(lineUserId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!token || !lineUserId) {
    console.log('[LINE richmenu unlink skip]', { lineUserId, hasToken: !!token });
    return false;
  }

  const res = await fetch(
    `https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('LINE richmenu unlink failed:', text);
    return false;
  }

  console.log('[LINE richmenu unlink success]', { lineUserId });
  return true;
}
async function linkRichMenuToUser(lineUserId, richMenuId) {

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  await unlinkRichMenuFromUser(lineUserId);
  if (!token || !lineUserId || !richMenuId) {
    console.log('[LINE richmenu skip]', {
      lineUserId,
      richMenuId,
      hasToken: !!token
    });
    return false;
  }

  console.log('[LINE richmenu link start]', { lineUserId, richMenuId });

  const res = await fetch(
    `https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('LINE richmenu link failed:', text);
    return false;
  }

  console.log('[LINE richmenu link success]', { lineUserId, richMenuId });
  return true;
}

async function relinkGuestRichMenu(lineUserId) {
  if (!lineUserId) return false;

  const guestRichMenuId = process.env.LINE_RICHMENU_GUEST_ID;
  if (!guestRichMenuId) {
    console.log('[LINE guest richmenu skip] missing LINE_RICHMENU_GUEST_ID');
    return false;
  }

  return await linkRichMenuToUser(lineUserId, guestRichMenuId);
}

async function hasLineLink(lineUserId) {
  if (!lineUserId) return false;

  const [rows] = await db.promise().query(
    'SELECT id FROM line_links WHERE line_user_id = ? LIMIT 1',
    [lineUserId]
  );

  return rows.length > 0;
}

function toJpgCloudinary(url = '') {
  // แปลง Cloudinary URL ให้เป็น .jpg (แบบง่ายสุด)
  // ถ้า url ไม่ใช่ cloudinary ก็คืนเหมือนเดิม
  if (!url.includes('res.cloudinary.com')) return url;
  if (url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)) return url;

  // ใส่ f_jpg ก่อนส่วนชื่อไฟล์
  // .../upload/...  -> .../upload/f_jpg/...
  return url.replace('/upload/', '/upload/f_jpg/');
}

async function pushLineImage(to, imageUrl) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK push image]', to, imageUrl);
    return;
  }

  const safeUrl = toJpgCloudinary(imageUrl);

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to,
      messages: [
        { type: 'image', originalContentUrl: safeUrl, previewImageUrl: safeUrl }
      ]
    })
  });

  if (!res.ok) console.error('LINE push image failed:', await res.text());
}

async function replyLineMessage(replyToken, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK reply]', text);
    return;
  }

  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });

  if (!res.ok) console.error('LINE reply failed:', await res.text());
}
async function replyLineFlex(replyToken, altText, contents) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK flex]', altText, JSON.stringify(contents, null, 2));
    return;
  }

  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'flex',
          altText,
          contents
        }
      ]
    })
  });

  if (!res.ok) {
    console.error('LINE flex reply failed:', await res.text());
  }
}
async function replyLineQuickReply(replyToken, text, items = []) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK quick reply]', text, items);
    return;
  }

  const safeItems = Array.isArray(items) ? items.slice(0, 13) : [];

  const body = {
    replyToken,
    messages: [
      {
        type: 'text',
        text,
        quickReply: {
          items: safeItems
        }
      }
    ]
  };

  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    console.error('LINE quick reply failed:', await res.text());
  }
}



function mapCategoryToDept(category) {
  const map = {
    'ขยะ': 'สาธารณสุข',
    'ไฟฟ้า': 'ไฟฟ้า',
    'ถนน/เสาไฟชำรุด': 'กองช่าง'
  };
  return map[(category || '').trim()] || null;
}
// ✅ ต้องอยู่ก่อน app.use(express.json())
app.post('/line/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.LINE_CHANNEL_SECRET;
    const signature = req.headers['x-line-signature'];

    const rawBody = req.body;
    const bodyText = rawBody.toString('utf8');

    // Verify signature
    if (secret) {
      const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      if (hash !== signature) return res.status(401).send('Invalid signature');
    }

    const payload = JSON.parse(bodyText);
    const events = payload.events || [];

    for (const ev of events) {
      const userId = ev.source?.userId;

      if (ev.type === 'follow' && userId) {
        try {
          const linked = await hasLineLink(userId);
          await linkRichMenuToUser(
            userId,
            linked
              ? process.env.LINE_RICHMENU_LINKED_ID
              : process.env.LINE_RICHMENU_GUEST_ID
          );
        } catch (e) {
          console.error('link rich menu from follow event error:', e);
        }
        continue;
      }

      if (ev.type !== 'message') continue;
      if (ev.message?.type !== 'text') continue;

      const text = (ev.message.text || '').trim();
      const replyToken = ev.replyToken;

      // =========================
      // 1) BIND / ผูก LINE
      // =========================
      const mToken = text.match(/^(?:BIND|ผูก)\s+([A-Za-z0-9\-_]{10,80})$/i);

      if (mToken && userId) {
        const token = mToken[1];

        const [rows] = await db.promise().query(
          `SELECT request_id, phone, used, expires_at
           FROM line_bind_tokens
           WHERE token = ?
           LIMIT 1`,
          [token]
        );

        if (!rows.length) {
          await replyLineMessage(replyToken, '❌ โค้ดไม่ถูกต้อง');
          continue;
        }

        const t = rows[0];

        if (t.used) {
          await replyLineMessage(replyToken, '⚠️ โค้ดนี้ถูกใช้ไปแล้ว');
          continue;
        }

        const expired = new Date(t.expires_at).getTime() < Date.now();
        if (expired) {
          await replyLineMessage(replyToken, '⏳ โค้ดหมดอายุแล้ว กรุณากลับไปหน้าเดิมเพื่อสร้างใหม่');
          continue;
        }

        const phone = normalizeThaiPhone(t.phone);

        await db.promise().query(
          `INSERT INTO line_links (phone, line_user_id)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE
             line_user_id = VALUES(line_user_id),
             updated_at = NOW()`,
          [phone, userId]
        );
        try {
          await linkRichMenuToUser(
            userId,
            process.env.LINE_RICHMENU_LINKED_ID
          );
        } catch (e) {
          console.error('link rich menu from webhook bind error:', e);
        }
        await db.promise().query(
          `UPDATE line_bind_tokens SET used = 1 WHERE token = ?`,
          [token]
        );

        const [reqRows] = await db.promise().query(
          `SELECT id, status FROM requests WHERE id = ? LIMIT 1`,
          [t.request_id]
        );

        const latestStatus = reqRows.length
          ? reqRows[0].status
          : 'รอแผนกรับเรื่อง';

        await replyLineMessage(
          replyToken,
          `✅ ผูก LINE สำเร็จ\nเลขคำร้อง: ${t.request_id}\nสถานะล่าสุด: ${latestStatus}\n\nเมื่อมีการอัปเดตสถานะ ระบบจะแจ้งให้ทราบทาง LINE`
        );
        continue;
      }

      // =========================
      // 2) ติดตามหลายคำร้อง
      // =========================
      const isTrackCommand = ['ติดตาม', 'สถานะ', 'คำร้องของฉัน'].includes(text);
      if (isTrackCommand) {
        if (!userId) {
          await replyLineMessage(replyToken, '❌ ไม่พบ LINE user');
          continue;
        }

        const page = 1;
        const limit = 5;
        const offset = 0;

        const total = await countRequestsByLineUserId(userId);
        const rows = await getLatestRequestsByLineUserId(userId, limit, offset);

        if (!rows.length) {
          await relinkGuestRichMenu(userId);
          await replyLineMessage(
            replyToken,
            '📭 ยังไม่พบคำร้องที่ผูกกับ LINE นี้\n\nหากคุณเพิ่งส่งคำร้อง กรุณากลับไปหน้าส่งคำร้องสำเร็จ แล้วกดผูก LINE ก่อน'
          );
          continue;
        }

        const hasNextPage = total > rows.length;
        const flexContents = buildTrackingFlexCarousel(rows, page, hasNextPage);

        await replyLineFlex(replyToken, 'คำร้องล่าสุดของคุณ', flexContents);
        continue;
      }

      // =========================
      // 3) คำร้องล่าสุด
      // =========================
      if (text === 'คำร้องล่าสุด') {
        if (!userId) {
          await replyLineMessage(replyToken, '❌ ไม่พบ LINE user');
          continue;
        }

        const latest = await getLatestSingleRequestByLineUserId(userId);

        if (!latest) {
          await relinkGuestRichMenu(userId);
          await replyLineMessage(
            replyToken,
            '📭 ยังไม่พบคำร้องล่าสุดของคุณ\n\nหากคุณเพิ่งส่งคำร้อง กรุณาผูก LINE ก่อน'
          );
          continue;
        }

        await replyLineMessage(replyToken, buildLatestRequestMessage(latest));
        continue;
      }

      // =========================
      // 4) รายละเอียด <id>
      // =========================
      const detailMatch = text.match(/^รายละเอียด\s+(\d+)$/i);
      const moreMatch = text.match(/^เพิ่มเติม\s*(\d+)$/i);
      if (detailMatch) {
        if (!userId) {
          await replyLineMessage(replyToken, '❌ ไม่พบ LINE user');
          continue;
        }

        const requestId = Number(detailMatch[1]);
        const detail = await getRequestDetailForLineUser(userId, requestId);

        if (!detail) {
          const linked = await hasLineLink(userId);
          if (!linked) {
            await relinkGuestRichMenu(userId);
          }
          await replyLineMessage(
            replyToken,
            `❌ ไม่พบคำร้องเลข #${requestId}\nหรือคำร้องนี้ไม่ได้ผูกกับ LINE ของคุณ`
          );
          continue;
        }

        await replyLineMessage(replyToken, buildTrackingDetailMessage(detail));
        continue;
      }
      if (moreMatch) {
        if (!userId) {
          await replyLineMessage(replyToken, '❌ ไม่พบ LINE user');
          continue;
        }

        const page = Math.max(1, Number(moreMatch[1] || 1));
        const limit = 5;
        const offset = (page - 1) * limit;

        const total = await countRequestsByLineUserId(userId);
        const rows = await getLatestRequestsByLineUserId(userId, limit, offset);

        if (!rows.length) {
          const linked = await hasLineLink(userId);
          if (!linked) {
            await relinkGuestRichMenu(userId);
          }
          await replyLineMessage(replyToken, '📭 ไม่พบคำร้องเพิ่มเติมแล้ว');
          continue;
        }

        const hasNextPage = total > offset + rows.length;
        const flexContents = buildTrackingFlexCarousel(rows, page, hasNextPage);

        await replyLineFlex(replyToken, `คำร้องของคุณ หน้า ${page}`, flexContents);
        continue;
      }
      // =========================
      // 5) วิธีผูกบัญชี
      // =========================
      if (text === 'วิธีผูกบัญชี') {
        await replyLineMessage(
          replyToken,
          '🔗 วิธีผูกบัญชี LINE กับคำร้อง\n\n' +
          '1) ส่งคำร้องผ่านเว็บไซต์\n' +
          '2) เข้า LINE OA ของระบบรับคำร้อง\n' +
          '3) กดเมนู "ผูกบัญชีไลน์" ที่ Rich Menu\n' +
          '4) กรอกเบอร์โทรที่ใช้ส่งคำร้อง\n' +
          '5) กดยืนยัน เพื่อเชื่อมบัญชีให้เรียบร้อย\n\n' +
          '✅ หลังผูกสำเร็จ คุณจะได้รับแจ้งเตือนสถานะคำร้องผ่าน LINE อัตโนมัติ'
        );
        continue;
      }

      // =========================
      // 6) ติดต่อเจ้าหน้าที่
      // =========================
      if (text === 'ติดต่อเจ้าหน้าที่') {
        await replyLineMessage(
          replyToken,
          '☎️ ติดต่อเจ้าหน้าที่\n' +
          'อบต.ท่าช้าง จ.จันทบุรี\n' +
          'เวลาทำการ: จันทร์-ศุกร์ 08:30-16:30 น.\n' +
          'โทร: 0xx-xxx-xxxx\n\n' +
          'หากเป็นเหตุด่วน กรุณาติดต่อทางโทรศัพท์'
        );
        continue;
      }
      // =========================
      // 7) fallback
      // =========================
      await replyLineMessage(
        replyToken,
        'คำสั่งที่ใช้ได้:\n' +
        '- ติดตาม\n' +
        '- คำร้องล่าสุด\n' +
        '- คำร้องของฉัน\n' +
        '- รายละเอียด <เลขคำร้อง>\n' +
        '- เพิ่มเติม <เลขหน้า>\n' +
        '- วิธีผูกบัญชี\n' +
        '- ติดต่อเจ้าหน้าที่'
      );
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('LINE webhook error:', e);
    return res.status(500).send('Server error');
  }
});

app.post('/api/line/force-guest-menu', express.json(), async (req, res) => {
  try {
    const { lineUserId } = req.body || {};

    if (!lineUserId) {
      return res.status(400).json({ ok: false, message: 'missing lineUserId' });
    }

    const ok = await relinkGuestRichMenu(lineUserId);
    return res.json({ ok });
  } catch (e) {
    console.error('force guest menu error:', e);
    return res.status(500).json({ ok: false, message: 'failed' });
  }
});

async function getLineUserIdByPhone(phone) {
  const normalizedPhone = normalizeThaiPhone(phone || '');
  if (!normalizedPhone) return null;

  const [rows] = await db.promise().query(
    'SELECT line_user_id FROM line_links WHERE phone = ? LIMIT 1',
    [normalizedPhone]
  );

  return rows.length ? rows[0].line_user_id : null;
}
async function getPhonesByLineUserId(lineUserId) {
  if (!lineUserId) return [];

  const [rows] = await db.promise().query(
    `SELECT phone
     FROM line_links
     WHERE line_user_id = ?
     ORDER BY updated_at DESC, created_at DESC`,
    [lineUserId]
  );

  // กันเบอร์ซ้ำ
  const phones = rows
    .map(r => normalizeThaiPhone(r.phone))
    .filter(Boolean);

  return [...new Set(phones)];
}

function formatThaiDateTime(dateValue) {
  if (!dateValue) return '-';

  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue);

  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
function getStatusColor(status = '') {
  const s = String(status || '').trim();

  if (s === 'รอแผนกรับเรื่อง') return '#F59E0B';
  if (s === 'รอแอดมินหลัก') return '#EF4444';
  if (s === 'รอดำเนินการ') return '#F59E0B';
  if (s === 'กำลังดำเนินการ') return '#2563EB';
  if (s === 'เสร็จสิ้น') return '#16A34A';
  if (s === 'ไม่อนุมัติ') return '#DC2626';

  return '#64748B';
}
function shortText(text = '', max = 120) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '-';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

async function getLatestRequestsByLineUserId(lineUserId, limit = 5, offset = 0) {
  const phones = await getPhonesByLineUserId(lineUserId);
  if (!phones.length) return [];

  const placeholders = phones.map(() => '?').join(',');

  const [rows] = await db.promise().query(
    `SELECT
      id, phone, category, message, department, status,
      created_at, completed_at, reject_reason, dept_reason
     FROM requests
     WHERE phone IN (${placeholders})
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...phones, Number(limit), Number(offset)]
  );

  return rows;
}
async function countRequestsByLineUserId(lineUserId) {
  const phones = await getPhonesByLineUserId(lineUserId);
  if (!phones.length) return 0;

  const placeholders = phones.map(() => '?').join(',');

  const [rows] = await db.promise().query(
    `SELECT COUNT(*) AS total
     FROM requests
     WHERE phone IN (${placeholders})`,
    [...phones]
  );

  return rows.length ? Number(rows[0].total || 0) : 0;
}
async function getLatestSingleRequestByLineUserId(lineUserId) {
  const rows = await getLatestRequestsByLineUserId(lineUserId, 1);
  return rows.length ? rows[0] : null;
}

async function getRequestDetailForLineUser(lineUserId, requestId) {
  const phones = await getPhonesByLineUserId(lineUserId);
  if (!phones.length) return null;

  const placeholders = phones.map(() => '?').join(',');

  const [rows] = await db.promise().query(
    `SELECT
      id, name, phone, address, category, message,
      department, status, reject_reason, dept_reason,
      dept_accept, created_at, completed_at, photo
     FROM requests
     WHERE id = ?
       AND phone IN (${placeholders})
     LIMIT 1`,
    [requestId, ...phones]
  );

  return rows.length ? rows[0] : null;
}

function buildTrackingListMessage(rows = []) {
  if (!rows.length) {
    return '📭 ยังไม่พบคำร้องของคุณในระบบ';
  }

  let msg = '📋 คำร้องล่าสุดของคุณ\n\n';

  msg += rows.map((r, index) => {
    return (
      `${index + 1}) #${r.id}\n` +
      `ประเภท: ${r.category || '-'}\n` +
      `สถานะ: ${r.status || '-'}\n` +
      `หน่วยงาน: ${r.department || '-'}`
    );
  }).join('\n\n');

  msg += '\n\n👇 กดปุ่มด้านล่างเพื่อดูรายละเอียด';

  return msg;
}

function buildLatestRequestMessage(r) {
  if (!r) return '📭 ยังไม่พบคำร้องล่าสุดของคุณ';

  let msg =
    `📌 คำร้องล่าสุดของคุณ\n\n` +
    `เลขคำร้อง: #${r.id}\n` +
    `ประเภท: ${r.category || '-'}\n` +
    `สถานะ: ${r.status || '-'}\n` +
    `หน่วยงาน: ${r.department || '-'}\n` +
    `วันที่แจ้ง: ${formatThaiDateTime(r.created_at)}\n` +
    `วันที่เสร็จสิ้น: ${formatThaiDateTime(r.completed_at)}\n` +
    `ข้อความ: ${shortText(r.message, 100)}`;

  return msg;
}
function getCategoryEmoji(category = '') {
  const c = String(category).trim();

  if (c.includes('ขยะ')) return '🗑️';
  if (c.includes('ไฟ')) return '💡';
  if (c.includes('ไฟฟ้า')) return '⚡';
  if (c.includes('ถนน')) return '🛣️';
  if (c.includes('ก่อสร้าง')) return '🏗️';
  if (c.includes('น้ำ')) return '💧';
  if (c.includes('ท่อ')) return '🚰';
  if (c.includes('ต้นไม้')) return '🌳';
  if (c.includes('หญ้า')) return '🌿';
  if (c.includes('สุนัข')) return '🐕';
  if (c.includes('แมว')) return '🐈';
  if (c.includes('ควัน') || c.includes('กลิ่น')) return '💨';
  if (c.includes('ความสะอาด')) return '🧹';
  if (c.includes('สุขภาพ') || c.includes('สาธารณสุข')) return '🏥';

  return '📂';
}

function getDepartmentEmoji(department = '') {
  const d = String(department).trim();

  if (d.includes('สาธารณสุข')) return '🏥';
  if (d.includes('ไฟฟ้า')) return '⚡';
  if (d.includes('กองช่าง')) return '🏗️';
  if (d.includes('สำนักงานปลัด')) return '🏛️';
  if (d.includes('อื่น')) return '📁';

  return '🏢';
}

function getStatusEmoji(status = '') {
  const s = String(status).trim();

  if (s.includes('รอแผนก')) return '🟠';
  if (s.includes('รอดำเนินการ')) return '🟡';
  if (s.includes('กำลังดำเนินการ')) return '🔧';
  if (s.includes('เสร็จสิ้น')) return '✅';
  if (s.includes('ไม่อนุมัติ') || s.includes('ไม่รับเรื่อง')) return '❌';

  return '📌';
}
function buildTrackingDetailMessage(r) {
  if (!r) return '❌ ไม่พบรายละเอียดคำร้อง';

  const category = r.category || '-';
  const status = r.status || '-';
  const department = r.department || '-';
  const createdAt = formatThaiDateTime(r.created_at);
  const completedAt = formatThaiDateTime(r.completed_at);
  const messageText = shortText(r.message, 250) || '-';

  const categoryEmoji = getCategoryEmoji(category);
  const statusEmoji = getStatusEmoji(status);
  const departmentEmoji = getDepartmentEmoji(department);

  let msg =
    `📄 รายละเอียดคำร้อง #${r.id}\n\n` +

    `${categoryEmoji} ประเภท\n${category}\n\n` +

    `${statusEmoji} สถานะ\n${status}\n\n` +

    `${departmentEmoji} หน่วยงาน\n${department}\n\n` +

    `🕒 วันที่แจ้ง\n${createdAt}\n\n` +

    `🏁 วันที่เสร็จสิ้น\n${completedAt}\n\n` +

    `📝 ข้อความคำร้อง\n${messageText}`;

  if (r.dept_reason) {
    msg += `\n\n🏬 เหตุผลจากหน่วยงาน\n${r.dept_reason}`;
  }

  if (r.reject_reason) {
    msg += `\n\n🚫 เหตุผลไม่อนุมัติ\n${r.reject_reason}`;
  }

  if (status.includes('เสร็จสิ้น')) {
    msg += `\n\n🙏 ขอบคุณที่แจ้งคำร้องเข้ามา`;
  } else if (status.includes('กำลังดำเนินการ')) {
    msg += `\n\n🔧 คำร้องของคุณกำลังอยู่ระหว่างดำเนินการ`;
  } else if (status.includes('รอดำเนินการ') || status.includes('รอแผนก')) {
    msg += `\n\n⏳ กรุณารอสักครู่ ระบบจะแจ้งเตือนเมื่อมีการอัปเดต`;
  } else if (status.includes('ไม่รับเรื่อง') || status.includes('ไม่อนุมัติ')) {
    msg += `\n\n📞 หากต้องการข้อมูลเพิ่มเติม กรุณาติดต่อเจ้าหน้าที่`;
  }

  return msg;
}
function buildTrackingFlexCarousel(rows = [], currentPage = 1, hasNextPage = false) {
  const bubbles = (rows || []).map((r) => ({
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: getStatusColor(r.status),
          cornerRadius: '8px',
          paddingAll: '8px',
          contents: [
            {
              type: 'text',
              text: r.status || '-',
              color: '#FFFFFF',
              weight: 'bold',
              size: 'sm',
              align: 'center'
            }
          ]
        },
        {
          type: 'text',
          text: `คำร้อง #${r.id}`,
          weight: 'bold',
          size: 'xl',
          color: '#111827'
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: 'ประเภท',
              size: 'sm',
              color: '#6B7280',
              flex: 2
            },
            {
              type: 'text',
              text: r.category || '-',
              size: 'sm',
              color: '#111827',
              flex: 5,
              wrap: true
            }
          ]
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: 'สถานะ',
              size: 'sm',
              color: '#6B7280',
              flex: 2
            },
            {
              type: 'text',
              text: r.status || '-',
              size: 'sm',
              color: getStatusColor(r.status),
              weight: 'bold',
              flex: 5,
              wrap: true
            }
          ]
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: 'หน่วยงาน',
              size: 'sm',
              color: '#6B7280',
              flex: 2
            },
            {
              type: 'text',
              text: r.department || '-',
              size: 'sm',
              color: '#111827',
              flex: 5,
              wrap: true
            }
          ]
        },
        {
          type: 'separator',
          margin: 'md'
        },
        {
          type: 'text',
          text: `แจ้งเมื่อ ${formatThaiDateTime(r.created_at)}`,
          size: 'xs',
          color: '#6B7280',
          wrap: true
        }
      ],
      paddingAll: '20px'
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'md',
          color: '#155263',
          action: {
            type: 'message',
            label: 'ดูรายละเอียด',
            text: `รายละเอียด ${r.id}`
          }
        }
      ],
      paddingAll: '16px'
    }
  }));

  if (hasNextPage) {
    bubbles.push({
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        justifyContent: 'center',
        alignItems: 'center',
        paddingAll: '24px',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'มีคำร้องเพิ่มเติม',
            weight: 'bold',
            size: 'xl',
            color: '#111827',
            align: 'center'
          },
          {
            type: 'text',
            text: `กดเพื่อดูหน้าถัดไป (หน้า ${currentPage + 1})`,
            size: 'sm',
            color: '#6B7280',
            wrap: true,
            align: 'center'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            action: {
              type: 'message',
              label: 'ดูเพิ่มเติม',
              text: `เพิ่มเติม ${currentPage + 1}`
            }
          }
        ],
        paddingAll: '16px'
      }
    });
  }

  return {
    type: 'carousel',
    contents: bubbles
  };
}



function getStatusMeta(status = '') {
  const s = String(status || '').trim();

  const map = {
    'รอแผนกรับเรื่อง': {
      titleIcon: '📬',
      statusIcon: '📬'
    },
    'รอแอดมินหลัก': {
      titleIcon: '👤',
      statusIcon: '👤'
    },
    'รอดำเนินการ': {
      titleIcon: '🟡',
      statusIcon: '🟡'
    },
    'กำลังดำเนินการ': {
      titleIcon: '🟠',
      statusIcon: '🟠'
    },
    'เสร็จสิ้น': {
      titleIcon: '🟢',
      statusIcon: '🟢'
    },
    'ไม่อนุมัติ': {
      titleIcon: '🔴',
      statusIcon: '🔴'
    }
  };

  return map[s] || {
    titleIcon: '📢',
    statusIcon: '📍'
  };
}
async function notifyRequestStatusLine(requestId, status, extraText = '') {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, phone, department, status, category
       FROM requests
       WHERE id = ?
       LIMIT 1`,
      [requestId]
    );

    if (!rows.length) return false;

    const rq = rows[0];
    const lineUserId = await getLineUserIdByPhone(rq.phone);

    if (!lineUserId) {
      console.log(`ℹ️ ไม่พบ LINE ที่ผูกกับเบอร์คำร้อง #${requestId}`);
      return false;
    }

    const meta = getStatusMeta(status);

    let msg =
      `${meta.titleIcon} อัปเดตคำร้องของคุณ\n` +
      `เลขคำร้อง: ${rq.id}\n` +
      `ประเภท: ${rq.category || '-'}\n` +
      `หน่วยงาน: ${rq.department || '-'}\n` +
      `สถานะ: ${meta.statusIcon} ${status}`;

    if (extraText && String(extraText).trim()) {
      msg += `\n\n${String(extraText).trim()}`;
    }

    await pushLineMessage(lineUserId, msg);
    console.log(`✅ ส่ง LINE แจ้งสถานะสำเร็จ #${requestId} -> ${status}`);
    return true;
  } catch (err) {
    console.error('notifyRequestStatusLine error:', err);
    return false;
  }
}



app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.get('/line/is-linked', async (req, res) => {
  try {
    const phone = normalizeThaiPhone(req.query.phone || '');
    if (!phone) return res.status(400).json({ linked: false });

    const [rows] = await db.promise().query(
      'SELECT line_user_id FROM line_links WHERE phone = ? LIMIT 1',
      [phone]
    );

    return res.json({ linked: rows.length > 0 });
  } catch (e) {
    console.error('is-linked error:', e);
    return res.status(500).json({ linked: false });
  }
});
app.get('/line/bind-info', async (req, res) => {
  try {
    const token = String(req.query.t || '').trim();
    if (!token) return res.status(400).json({ ok:false, message:'missing token' });

    const [rows] = await db.promise().query(
      `SELECT token, request_id, phone, used, expires_at
       FROM line_bind_tokens
       WHERE token = ? LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ ok:false, message:'token not found' });

    const r = rows[0];
    const expired = new Date(r.expires_at).getTime() < Date.now();
    if (expired) return res.status(410).json({ ok:false, message:'token expired' });

    const phone = normalizeThaiPhone(r.phone);

    const [linkRows] = await db.promise().query(
      'SELECT line_user_id FROM line_links WHERE phone = ? LIMIT 1',
      [phone]
    );

    return res.json({
      ok:true,
      requestId: r.request_id,
      phoneMasked: maskPhone(phone),
      linked: linkRows.length > 0
    });
  } catch (e) {
    console.error('bind-info error:', e);
    return res.status(500).json({ ok:false });
  }
});
app.post('/api/line/bind-phone', async (req, res) => {
  console.log('[bind-phone hit]', req.body);
  try {
    const { phone, lineUserId } = req.body;

    if (!phone || !lineUserId) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_INPUT',
        message: 'ข้อมูลไม่ครบ'
      });
    }

    const cleanPhone = normalizeThaiPhone(phone);

    if (!/^0\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_PHONE',
        message: 'รูปแบบเบอร์โทรไม่ถูกต้อง'
      });
    }

    // 1) เช็กว่าเบอร์นี้มีอยู่ใน requests จริงไหม
    const [requestRows] = await db.promise().query(
      'SELECT id, phone FROM requests WHERE phone = ? ORDER BY id DESC LIMIT 1',
      [cleanPhone]
    );

    if (!requestRows.length) {
      return res.status(404).json({
        ok: false,
        code: 'PHONE_NOT_FOUND',
        message: 'ไม่พบเบอร์นี้ในระบบคำร้อง'
      });
    }

    // 2) เช็กว่า "เบอร์นี้" เคยผูกกับใครอยู่ไหม
    const [phoneLinkRows] = await db.promise().query(
      'SELECT phone, line_user_id FROM line_links WHERE phone = ? LIMIT 1',
      [cleanPhone]
    );

    // 3) เช็กว่า "LINE user นี้" เคยผูกกับเบอร์อะไรไหม
    const [userLinkRows] = await db.promise().query(
      'SELECT phone, line_user_id FROM line_links WHERE line_user_id = ? LIMIT 1',
      [lineUserId]
    );

    const phoneLinked = phoneLinkRows.length ? phoneLinkRows[0] : null;
    const userLinked = userLinkRows.length ? userLinkRows[0] : null;

    // =========================
    // CASE A: LINE เดิม + เบอร์เดิม
    // =========================
    if (
      phoneLinked &&
      userLinked &&
      phoneLinked.line_user_id === lineUserId &&
      normalizeThaiPhone(userLinked.phone) === cleanPhone
    ) {
      try {
        await linkRichMenuToUser(
          lineUserId,
          process.env.LINE_RICHMENU_LINKED_ID
        );
      } catch (e) {
        console.error('link rich menu (already linked) error:', e);
      }

      await pushLineMessage(
        lineUserId,
        `ℹ️ บัญชีนี้ผูกกับระบบไว้แล้ว\n\n` +
        `📱 เบอร์ที่ผูก: ${maskPhone(cleanPhone)}\n` +
        `✅ คุณยังคงได้รับแจ้งเตือนสถานะคำร้องผ่าน LINE ตามปกติ`
      );

      return res.json({
        ok: true,
        code: 'ALREADY_LINKED',
        message: `บัญชีนี้ผูกกับเบอร์ ${maskPhone(cleanPhone)} อยู่แล้ว`
      });
    }

    // =========================
    // CASE B: LINE นี้เคยผูกเบอร์อื่น -> ลบของเก่าของ LINE นี้ก่อน
    // =========================
    if (userLinked && normalizeThaiPhone(userLinked.phone) !== cleanPhone) {
      await db.promise().query(
        'DELETE FROM line_links WHERE line_user_id = ?',
        [lineUserId]
      );
    }

    // =========================
    // CASE C: เบอร์นี้เคยผูกกับ LINE คนอื่น -> update ทับเป็นคนปัจจุบัน
    // CASE D: ยังไม่เคยผูก -> insert ใหม่
    // =========================
    await db.promise().query(
      `
      INSERT INTO line_links (phone, line_user_id)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE
        line_user_id = VALUES(line_user_id),
        updated_at = NOW()
      `,
      [cleanPhone, lineUserId]
    );

    try {
      await linkRichMenuToUser(
        lineUserId,
        process.env.LINE_RICHMENU_LINKED_ID
      );
    } catch (e) {
      console.error('link rich menu after bind error:', e);
    }

    const wasPhoneLinkedToAnother =
      phoneLinked && phoneLinked.line_user_id !== lineUserId;

    const wasUserLinkedToAnotherPhone =
      userLinked && normalizeThaiPhone(userLinked.phone) !== cleanPhone;

    let responseCode = 'LINKED_SUCCESS';
    let responseMessage = `ผูกบัญชีสำเร็จ (${maskPhone(cleanPhone)})`;
    let pushText =
      `🎉 ผูกบัญชี LINE สำเร็จแล้ว\n\n` +
      `📱 เบอร์ที่ผูก: ${maskPhone(cleanPhone)}\n` +
      `🔔 จากนี้คุณจะได้รับแจ้งเตือนสถานะคำร้องผ่าน LINE อัตโนมัติ\n\n` +
      `คุณสามารถใช้เมนูด้านล่างเพื่อ:\n` +
      `• ติดตามคำร้อง\n` +
      `• ดูคำร้องล่าสุด\n` +
      `• ติดต่อเจ้าหน้าที่`;

    if (wasPhoneLinkedToAnother || wasUserLinkedToAnotherPhone) {
      responseCode = 'LINK_UPDATED';
      responseMessage = `อัปเดตการผูกบัญชีสำเร็จ (${maskPhone(cleanPhone)})`;
      pushText =
        `🔄 อัปเดตการผูกบัญชี LINE สำเร็จ\n\n` +
        `📱 เบอร์ที่ผูกล่าสุด: ${maskPhone(cleanPhone)}\n` +
        `🔔 จากนี้ระบบจะส่งการแจ้งเตือนไปยัง LINE บัญชีนี้\n\n` +
        `คุณสามารถใช้เมนูด้านล่างเพื่อ:\n` +
        `• ติดตามคำร้อง\n` +
        `• ดูคำร้องล่าสุด\n` +
        `• ติดต่อเจ้าหน้าที่`;
    }

    // 4) ส่งข้อความแจ้งกลับเข้า LINE chat
    await pushLineMessage(lineUserId, pushText);

    return res.json({
      ok: true,
      code: responseCode,
      message: responseMessage
    });

  } catch (err) {
    console.error('❌ bind-phone error:', err);
    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'บันทึกการผูกบัญชีไม่สำเร็จ'
    });
  }
});
app.post('/line/update-phone', async (req, res) => {
  try {
    const token = String(req.body?.t || '').trim();
    const newPhone = normalizeThaiPhone(req.body?.phone || '');

    if (!token) return res.status(400).json({ ok:false, message:'missing token' });
    if (!/^0\d{9}$/.test(newPhone)) return res.status(400).json({ ok:false, message:'invalid phone' });

    const [rows] = await db.promise().query(
      `SELECT request_id, expires_at FROM line_bind_tokens WHERE token=? LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ ok:false, message:'token not found' });

    const expired = new Date(rows[0].expires_at).getTime() < Date.now();
    if (expired) return res.status(410).json({ ok:false, message:'token expired' });

    const requestId = rows[0].request_id;

    // ✅ อัปเดตใน requests ด้วย (กันเบอร์ผิด)
    await db.promise().query(`UPDATE requests SET phone=? WHERE id=?`, [newPhone, requestId]);
    // ✅ อัปเดตใน token ด้วย
    await db.promise().query(`UPDATE line_bind_tokens SET phone=? WHERE token=?`, [newPhone, token]);

    return res.json({ ok:true, phoneMasked: maskPhone(newPhone) });
  } catch (e) {
    console.error('update-phone error:', e);
    return res.status(500).json({ ok:false });
  }
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'hi-form-secret',
  resave: false,
  saveUninitialized: false
}));


const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,          // 587 ต้อง false
  requireTLS: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 30000
});

// เช็กตอนเริ่ม server
transporter.verify((err, success) => {
  if (err) {
    console.error('❌ SMTP verify error:', err);
  } else {
    console.log('✅ SMTP พร้อมใช้งาน');
  }
});

const sendEmail = (subject, body) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_RECEIVER,
    subject: subject,
    text: body
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('❌ ส่งอีเมลไม่สำเร็จ:', error);
    } else {
      console.log('✅ ส่งอีเมลสำเร็จ:', info.response);
    }
  });
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin-login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin-login'));
});

app.get('/admin', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.redirect('/admin-login');
  }
});
// 🆕 เพิ่มระบบล็อกอินเฉพาะ admin-sp
app.get('/admin-sp-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-sp-login.html'));
});

app.post('/admin-sp-login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_SP_PASSWORD) {
    req.session.isSpLoggedIn = true;
    return res.redirect('/admin-sp');
  }
  res.send('<script>alert("รหัสผ่านไม่ถูกต้อง"); window.location="/admin-sp-login";</script>');
});
// 🔒 Admin Health Login
app.get('/admin-health-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-health-login.html'));
});
app.post('/admin-health-login', (req, res) => {
  if (req.body.password === process.env.ADMIN_HEALTH_PASSWORD) {
    req.session.isHealthLoggedIn = true;
    return res.redirect('/admin-health');
  }
  res.send('<script>alert("รหัสผ่านไม่ถูกต้อง"); window.location="/admin-health-login";</script>');
});
app.use('/admin-health', (req, res, next) => {
  if (!req.session.isHealthLoggedIn) return res.redirect('/admin-health-login');
  next();
});

// 🔒 Admin Engineer Login
app.get('/admin-engineer-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-engineer-login.html'));
});
app.post('/admin-engineer-login', (req, res) => {
  if (req.body.password === process.env.ADMIN_ENGINEER_PASSWORD) {
    req.session.isEngineerLoggedIn = true;
    return res.redirect('/admin-engineer');
  }
  res.send('<script>alert("รหัสผ่านไม่ถูกต้อง"); window.location="/admin-engineer-login";</script>');
});
app.use('/admin-engineer', (req, res, next) => {
  if (!req.session.isEngineerLoggedIn) return res.redirect('/admin-engineer-login');
  next();
});

// 🔒 Admin Electric Login
app.get('/admin-electric-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-electric-login.html'));
});
app.post('/admin-electric-login', (req, res) => {
  if (req.body.password === process.env.ADMIN_ELECTRIC_PASSWORD) {
    req.session.isElectricLoggedIn = true;
    return res.redirect('/admin-electric');
  }
  res.send('<script>alert("รหัสผ่านไม่ถูกต้อง"); window.location="/admin-electric-login";</script>');
});
app.use('/admin-electric', (req, res, next) => {
  if (!req.session.isElectricLoggedIn) return res.redirect('/admin-electric-login');
  next();
});

// 🔒 Admin Other Login
app.get('/admin-other-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-other-login.html'));
});
app.post('/admin-other-login', (req, res) => {
  if (req.body.password === process.env.ADMIN_OTHER_PASSWORD) {
    req.session.isOtherLoggedIn = true;
    return res.redirect('/admin-other');
  }
  res.send('<script>alert("รหัสผ่านไม่ถูกต้อง"); window.location="/admin-other-login";</script>');
});
app.use('/admin-other', (req, res, next) => {
  if (!req.session.isOtherLoggedIn) return res.redirect('/admin-other-login');
  next();
});

app.use('/admin-sp', (req, res, next) => {
  if (!req.session.isSpLoggedIn) {
    return res.redirect('/admin-sp-login');
  }
  next();
});
app.post('/submit', (req, res) => {
  uploadSubmit.array('mediaFiles', 10)(req, res, async (err) => {
    if (err) return handleMulterError(err, res);

    try {
      console.log('📨 รับข้อมูลใหม่:', JSON.stringify(req.body, null, 2));
      console.log('🖼️ req.files:', req.files);

      const files = req.files || [];

      // ✅ ตรวจขนาดรวม + แยกรูป/วิดีโอ
      validateFiles(files, {
        maxTotalSize: MAX_TOTAL_SIZE_SUBMIT,
        maxImageSize: MAX_IMAGE_SIZE,
        maxVideoSize: MAX_VIDEO_SIZE
      });

      const { name, phone, address, message } = req.body;
      const latitude = req.body.latitude ? parseFloat(req.body.latitude) : null;
      const longitude = req.body.longitude ? parseFloat(req.body.longitude) : null;

      // ✅ รับค่าจาก dropdown ที่หน้า index
      const category = (req.body.category || '').trim();

      // ✅ map ไปแผนกทันทีตามประเภท
      const department = mapCategoryToDept(category);
      if (!department) {
        return res.status(400).send('❌ กรุณาเลือกประเภทเรื่องให้ถูกต้อง');
      }

      // ✅ สถานะเริ่มต้นใหม่: รอให้แผนกกดรับ/ไม่รับ
      const status = 'รอแผนกรับเรื่อง';

      // ✅ คอลัมน์ใหม่ใน DB
      const routed_to = department;
      const dept_accept = null;   // ให้เป็น NULL ตอนส่งใหม่
      const dept_reason = null;   // ยังไม่มีเหตุผลตอนส่ง

      if (!name || !phone || !address || !message) {
        return res.status(400).send('❌ ข้อมูลไม่ครบ');
      }

      // ✅ อัปโหลดทุกไฟล์ขึ้น Cloudinary
      const uploaded = await Promise.all(
        files.map(async (f) => {
          const result = await uploadBufferToCloudinary(f.buffer, f.mimetype);

          return {
            url: result.secure_url,
            public_id: result.public_id,
            type: detectFileType(f)
          };
        })
      );

      const photoUrl = JSON.stringify(uploaded);

      const sql = `
        INSERT INTO requests
        (name, phone, address, category, message, latitude, longitude, photo,
        department, status, routed_to, dept_accept, dept_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?)
      `;

      const values = [
        name, phone, address, category, message, latitude, longitude, photoUrl,
        department, status, routed_to, dept_accept, dept_reason
      ];

      db.query(sql, values, async (err, result) => {
        if (err) {
          console.error('❌ บันทึกข้อมูลล้มเหลว:', err);
          return res.status(500).send('❌ บันทึกไม่สำเร็จ');
        }

        sendEmail(
          '📬 แจ้งเตือนคำร้องใหม่',
          `ชื่อ: ${name}\nเบอร์โทร: ${phone}\nที่อยู่: ${address}\nข้อความ: ${message}\nจำนวนไฟล์แนบ: ${files.length} ไฟล์`
        );

        const requestId = result.insertId; // ✅ เลขคำร้อง

        // ✅ สร้าง token ผูก LINE (หมดอายุ 30 นาที)
        const token = genBindToken();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        // ✅ บันทึก token ลง DB
        await db.promise().query(
          `INSERT INTO line_bind_tokens (token, request_id, phone, expires_at)
          VALUES (?, ?, ?, ?)`,
          [token, requestId, normalizeThaiPhone(phone), expiresAt]
        );

        // ✅ redirect แบบใหม่ (ไม่ส่ง phone ใน URL)
        return res.redirect(`/submit-success.html?rid=${requestId}&t=${encodeURIComponent(token)}`);
      });

    } catch (error) {
      console.error('💥 เกิดข้อผิดพลาดไม่คาดคิด:', error);
      return res.status(400).send(error.message || '💥 เกิดข้อผิดพลาดไม่คาดคิด');
    }
  });
});
app.post('/dept-accept/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const etaText = (req.body?.etaText || '').trim();
    const remarkText = (req.body?.remarkText || '').trim();

    let finalEtaText = etaText || '';
    if (remarkText) {
      finalEtaText += `\nหมายเหตุ: ${remarkText}`;
    }
    finalEtaText = finalEtaText.trim() || null;

    await db.promise().query(
      "UPDATE requests SET dept_accept = 1, status = 'รอดำเนินการ', eta_text = ? WHERE id = ?",
      [finalEtaText, id]
    );

    let extraText = 'หน่วยงานรับเรื่องของคุณแล้ว และกำลังเข้าสู่ขั้นตอนดำเนินการ';
    if (etaText) extraText += `\nกำหนดการเบื้องต้น: ${etaText}`;
    if (remarkText) extraText += `\nหมายเหตุ: ${remarkText}`;

    await notifyRequestStatusLine(id, 'รอดำเนินการ', extraText);

    return res.json({ ok: true });
  } catch (e) {
    console.error('dept-accept error:', e);
    return res.status(500).json({ ok: false });
  }
});

app.post('/dept-reject/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const reason = (req.body?.reason || '').trim();

    await db.promise().query(
      "UPDATE requests SET dept_accept = 0, dept_reason = ?, status = 'รอแอดมินหลัก', department = NULL WHERE id = ?",
      [reason, id]
    );

    // ✅ แจ้ง LINE เมื่อหน่วยงานไม่รับเรื่องและส่งกลับแอดมินหลัก
    await notifyRequestStatusLine(
      id,
      'รอแอดมินหลัก',
      reason ? `เหตุผล: ${reason}` : 'คำร้องถูกส่งกลับให้แอดมินหลักพิจารณาอีกครั้ง'
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('dept-reject error:', e);
    return res.status(500).json({ ok: false });
  }
});
app.get('/data-today', (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });

  const sql = `
    SELECT * FROM requests
    WHERE processed = false
      AND DATE(created_at) = CURDATE()
      AND (status = 'รอแอดมินหลัก' OR department IS NULL)
    ORDER BY id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลคำร้องวันนี้' });
    res.json(results);
  });
});
app.get('/data', (req, res) => {
  // ✅ admin หลักเห็นเฉพาะ:
  // 1) งานที่แผนก "ไม่รับ" แล้วส่งกลับ (status = 'รอแอดมินหลัก')
  // 2) งานที่ยังไม่มีแผนก (department IS NULL) (เช่นยังไม่ได้จัดสรร/หรือถูกเด้งกลับ)
  const sql = `
    SELECT * FROM requests
    WHERE processed = false
      AND (status = 'รอแอดมินหลัก' OR department IS NULL)
    ORDER BY id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.get('/data-approved', (req, res) => {
  const department = req.query.department;
  if (!department) return res.status(400).json({ error: 'กรุณาระบุแผนก' });

  const sql = `
    SELECT * FROM requests 
    WHERE department = ? AND approved = 1 AND processed = true
    ORDER BY id DESC
  `;

  db.query(sql, [department], (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.get('/processed', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'processed.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-sp', (req, res) => {
  if (req.session.isSpLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-sp.html'));
  } else {
    res.redirect('/admin-sp-login');
  }
});


app.get('/admin-health', (req, res) => {
  if (req.session.isHealthLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-health.html'));
  } else {
    res.redirect('/admin-health-login');
  }
});

app.get('/admin-engineer', (req, res) => {
  if (req.session.isEngineerLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-engineer.html'));
  } else {
    res.redirect('/admin-engineer-login');
  }
});

app.get('/admin-electric', (req, res) => {
  if (req.session.isElectricLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-electric.html'));
  } else {
    res.redirect('/admin-electric-login');
  }
});

app.get('/admin-other', (req, res) => {
  if (req.session.isOtherLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-other.html'));
  } else {
    res.redirect('/admin-other-login');
  }
});


app.get('/data-processed', (req, res) => {
  const department = req.query.department;
  let sql = 'SELECT * FROM requests WHERE processed = true';
  const params = [];

  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }

  sql += ' ORDER BY id DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.post('/approve/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.promise().query(
      'UPDATE requests SET approved = 1, processed = true WHERE id = ?',
      [id]
    );

    // ✅ แจ้ง LINE เมื่อแอดมินหลักอนุมัติ (หลังจากเลือกแผนกแล้ว status จะเป็น "รอแผนกรับเรื่อง")
    await notifyRequestStatusLine(
      id,
      'รอแผนกรับเรื่อง',
      'แอดมินหลักอนุมัติคำร้องแล้ว และส่งต่อให้หน่วยงานดำเนินการ'
    );

    return res.send('✅ อนุมัติสำเร็จ');
  } catch (err) {
    console.error('approve error:', err);
    return res.status(500).send('❌ อนุมัติไม่สำเร็จ');
  }
});

app.post('/reject/:id', async (req, res) => {
  const id = req.params.id;
  const { reason } = req.body;

  try {
    await db.promise().query(
      'UPDATE requests SET status = ?, reject_reason = ?, approved = 0, processed = true WHERE id = ?',
      ['ไม่อนุมัติ', reason || null, id]
    );

    // ✅ แจ้ง LINE เมื่อแอดมินหลัก “ไม่อนุมัติ”
    await notifyRequestStatusLine(
      id,
      'ไม่อนุมัติ',
      reason ? `เหตุผล: ${reason}` : 'แอดมินหลักไม่อนุมัติคำร้องของคุณ'
    );

    return res.send('ไม่อนุมัติคำร้องเรียบร้อยแล้ว');
  } catch (err) {
    console.error('reject error:', err);
    return res.status(500).send('เกิดข้อผิดพลาด');
  }
});



app.post('/set-department/:id', (req, res) => {
  const { department } = req.body;
  const id = req.params.id;

  console.log(`📌 รับข้อมูลเปลี่ยนแผนก id=${id}, department=${department}`);

  if (!department) {
    return res.status(400).json({ message: '❌ ต้องระบุแผนก' });
  }

  db.query(
    'SELECT id, status, dept_accept, routed_to FROM requests WHERE id = ? LIMIT 1',
    [id],
    (findErr, rows) => {
      if (findErr) {
        console.error('❌ SQL find error:', findErr);
        return res.status(500).json({ message: '❌ ตรวจสอบข้อมูลไม่สำเร็จ' });
      }

      if (!rows.length) {
        return res.status(404).json({ message: '❌ ไม่พบคำร้องนี้' });
      }

      const row = rows[0];

      const isBouncedBack =
        row.status === 'รอแอดมินหลัก' && Number(row.dept_accept) === 0;

      const blockedDepartment = row.routed_to || '';

      if (isBouncedBack && blockedDepartment && department === blockedDepartment) {
        return res.status(400).json({
          message: `❌ คำร้องนี้ถูก ${blockedDepartment} ตีกลับแล้ว จึงไม่สามารถส่งกลับไปแผนกเดิมได้`
        });
      }

      db.query(
        `UPDATE requests
        SET department = ?,
            status = 'รอแผนกรับเรื่อง',
            dept_accept = NULL,
            dept_reason = NULL
        WHERE id = ?`,
        [department, id],
        (err, result) => {
          if (err) {
            console.error('❌ SQL error:', err);
            return res.status(500).json({ message: '❌ เปลี่ยนแผนกไม่สำเร็จ' });
          }

          if (result.affectedRows === 0) {
            return res.status(404).json({ message: '❌ ไม่พบคำร้องนี้' });
          }

          console.log(`✅ อัปเดตแผนก id=${id} -> ${department}`);
          res.json({ message: '✅ เปลี่ยนแผนกแล้ว' });
        }
      );
    }
  );
});

app.post('/disapprove/:id', (req, res) => {
  const id = req.params.id;
  db.query('UPDATE requests SET approved = 0, processed = true WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('เกิดข้อผิดพลาด');
    res.sendStatus(200);
  });
});
// ---- helpers สำหรับ copy ระหว่างตารางสถานะ ----
function normalizePhoto(val) {
  if (val == null) return null;
  return (typeof val === 'string') ? val : JSON.stringify(val);
}

function upsertToBucket(tableName, r, cb) {
  const sql = `
    INSERT INTO ${tableName}
      (original_id, name, phone, address, category, message,
       latitude, longitude, photo, department, status,
       approved, processed, created_at, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name=VALUES(name),
      phone=VALUES(phone),
      address=VALUES(address),
      category=VALUES(category),
      message=VALUES(message),
      latitude=VALUES(latitude),
      longitude=VALUES(longitude),
      photo=VALUES(photo),
      department=VALUES(department),
      status=VALUES(status),
      approved=VALUES(approved),
      processed=VALUES(processed),
      created_at=VALUES(created_at),
      reject_reason=VALUES(reject_reason),
      copied_at=CURRENT_TIMESTAMP
  `;
  const vals = [
    r.id, r.name, r.phone, r.address, r.category, r.message,
    r.latitude, r.longitude, normalizePhoto(r.photo),
    r.department, r.status, r.approved, r.processed, r.created_at, r.reject_reason
  ];
  db.query(sql, vals, cb);
}

function removeFromOtherBuckets(originalId, keepTable, cb) {
  const tables = ['pending', 'inprogress', 'completed'].filter(t => t !== keepTable);
  const tasks = tables.map(t => new Promise(resolve => {
    db.query(`DELETE FROM ${t} WHERE original_id = ?`, [originalId], () => resolve());
  }));
  Promise.all(tasks).then(() => cb && cb());
}
// -----------------------------------------------
// ✅ เปลี่ยนสถานะ (รอดำเนินการ / กำลังดำเนินการ) + คัดลอกไป bucket
app.post('/set-status/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { status, etaText, remarkText } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: '❌ ต้องระบุ status' });
    }

    if (status === 'เสร็จสิ้น') {
      return res.status(400).json({
        success: false,
        message: '❌ สถานะ "เสร็จสิ้น" กรุณาใช้ /complete-with-media/:id'
      });
    }

    let finalEtaText = null;

    if (status === 'รอดำเนินการ' || status === 'กำลังดำเนินการ') {
      const cleanEta = (etaText || '').trim();
      const cleanRemark = (remarkText || '').trim();

      finalEtaText = cleanEta || '';
      if (cleanRemark) {
        finalEtaText += `\nหมายเหตุ: ${cleanRemark}`;
      }
      finalEtaText = finalEtaText.trim() || null;
    } else {
      finalEtaText = null;
    }

    await db.promise().query(
      'UPDATE requests SET status = ?, eta_text = ? WHERE id = ?',
      [status, finalEtaText, id]
    );

    const [rows] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
    }
    const r = rows[0];

    let bucket = null;
    if (status === 'รอดำเนินการ') bucket = 'pending';
    if (status === 'กำลังดำเนินการ') bucket = 'inprogress';

    if (bucket) {
      await new Promise((resolve, reject) => {
        upsertToBucket(bucket, r, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise((resolve) => removeFromOtherBuckets(r.id, bucket, resolve));
    }

    let extraText = '';
    if (status === 'รอดำเนินการ') {
      extraText = 'คำร้องของคุณอยู่ระหว่างรอการดำเนินงานจากหน่วยงาน';
    } else if (status === 'กำลังดำเนินการ') {
      extraText = 'ขณะนี้หน่วยงานกำลังดำเนินการตามคำร้องของคุณ';
    }

    if ((etaText || '').trim()) {
      extraText += `\nกำหนดการเบื้องต้น: ${(etaText || '').trim()}`;
    }
    if ((remarkText || '').trim()) {
      extraText += `\nหมายเหตุ: ${(remarkText || '').trim()}`;
    }

    await notifyRequestStatusLine(id, status, extraText);

    return res.json({ success: true, message: '✅ อัปเดตสถานะเรียบร้อย' });
  } catch (err) {
    console.error('❌ set-status error:', err);
    return res.status(500).json({ success: false, message: '❌ Server error' });
  }
});

// ✅ เพิ่มฟังก์ชันเปลี่ยนสถานะ
// ✅ เปลี่ยนสถานะ + ถ้าเป็น "กำลังดำเนินการ" ให้คัดลอกไป inprogress
// เปลี่ยนสถานะ + คัดลอกเข้า bucket ที่ตรงสถานะ + ลบออกจาก bucket อื่น
app.post('/complete-with-media/:id', (req, res) => {
  uploadComplete.array('extraFiles', 5)(req, res, async (err) => {
    if (err) return handleMulterError(err, res);

    try {
      const id = req.params.id;
      const files = req.files || [];

      // ✅ ถ้าไม่มีไฟล์ ก็ยังผ่านได้
      if (files.length > 0) {
        validateFiles(files, {
          maxTotalSize: MAX_TOTAL_SIZE_COMPLETE,
          maxImageSize: MAX_IMAGE_SIZE,
          maxVideoSize: MAX_VIDEO_SIZE
        });
      }

      const [rows] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
      if (!rows || rows.length === 0) {
        return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
      }
      const r = rows[0];

      let list = [];
      try { list = Array.isArray(r.photo) ? r.photo : JSON.parse(r.photo || '[]'); } catch { list = []; }

      const uploadedExtra = await Promise.all(
        files.map(async (f) => {
          const result = await uploadBufferToCloudinary(f.buffer, f.mimetype);
          return {
            url: result.secure_url,
            public_id: result.public_id,
            type: detectFileType(f),
            from: 'completed',
            tag: 'completed'
          };
        })
      );

      const merged = [...list, ...uploadedExtra];

      await db.promise().query(
        `UPDATE requests 
         SET status='เสร็จสิ้น', photo=?, completed_at=NOW(), can_rate=1
         WHERE id=?`,
        [JSON.stringify(merged), id]
      );

      const [rows2] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
      if (rows2 && rows2.length > 0) {
        const r2 = rows2[0];

        await new Promise((resolve, reject) => {
          upsertToBucket('completed', r2, (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve) => removeFromOtherBuckets(r2.id, 'completed', resolve));
      }

      try {
        const [rqRows] = await db.promise().query(
          'SELECT id, phone, notified_completed_at FROM requests WHERE id = ?',
          [id]
        );

        if (rqRows?.length) {
          const rq = rqRows[0];

          if (!rq.notified_completed_at) {
            const [linkRows] = await db.promise().query(
              'SELECT line_user_id FROM line_links WHERE phone = ? LIMIT 1',
              [normalizeThaiPhone(rq.phone)]
            );

            if (linkRows?.length) {
              const lineUserId = linkRows[0].line_user_id;

              const doneMeta = getStatusMeta('เสร็จสิ้น');

              const msg =
                `${doneMeta.titleIcon} อัปเดตคำร้องของคุณ\n` +
                `เลขคำร้อง: ${rq.id}\n` +
                `สถานะ: ${doneMeta.statusIcon} เสร็จสิ้น\n\n` +
                `คำร้องของคุณดำเนินการเสร็จเรียบร้อยแล้ว\nขอบคุณที่แจ้งเรื่องครับ`;

              await pushLineMessage(lineUserId, msg);

              const trackUrl = `${process.env.BASE_URL || 'https://hi-render.onrender.com'}/track.html`;

              let linkMsg =
                `🔗 ดูรายละเอียดคำร้องและไฟล์แนบล่าสุด\n` +
                `${trackUrl}\n\n` +
                `หากมีการลบหรืออัปเดตไฟล์ ระบบจะแสดงข้อมูลล่าสุดจากหน้าเว็บ`;

              await pushLineMessage(lineUserId, linkMsg);

              await db.promise().query(
                'UPDATE requests SET notified_completed_at = NOW() WHERE id = ?',
                [rq.id]
              );
            }
          }
        }
      } catch (e) {
        console.error('LINE notify error:', e);
      }

      return res.json({
        success: true,
        message: files.length > 0
          ? '✅ อัปเดตเป็น "เสร็จสิ้น" และแนบไฟล์เรียบร้อย'
          : '✅ อัปเดตเป็น "เสร็จสิ้น" เรียบร้อย'
      });

    } catch (error) {
      console.error('❌ complete-with-media error:', error);
      return res.status(400).json({ success: false, message: error.message || '❌ เกิดข้อผิดพลาดใน complete-with-media' });
    }
  });
});
// ✅ ลบเฉพาะไฟล์ที่แนบตอน "เสร็จสิ้น"
// ✅ ลบ “เฉพาะไฟล์ที่แนบตอนเสร็จสิ้น” + ซิงก์ตาราง completed
app.post('/delete-completed-file/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { fileUrl } = req.body || {};
    if (!fileUrl) return res.status(400).json({ success:false, message:'❌ ต้องระบุ fileUrl' });

    // 1) ดึงรายการเดิม
    const [rows] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ success:false, message:'❌ ไม่พบคำร้องนี้' });

    const r = rows[0];
    let list = [];
    try { list = Array.isArray(r.photo) ? r.photo : JSON.parse(r.photo || '[]'); } catch { list = []; }
    const normUrl = (u) => decodeURIComponent((u || '').trim()).split('?')[0];


    // 2) หา item ที่จะลบ (ต้องเป็น completed)
    const targetItem = list.find(item => {
      if (typeof item !== 'object') return false;
      const isCompleted = item.from === 'completed' || item.tag === 'completed';
      return isCompleted && normUrl(item.url) === normUrl(fileUrl);
    });


    if (!targetItem) {
      return res.json({ success:true, message:'⚠️ ไม่พบไฟล์ completed ที่ตรงกับ URL นี้' });
    }

    // 3) ลบไฟล์บน Cloudinary (ถ้ามี public_id)
if (targetItem.public_id) {
  const resource_type =
    targetItem.type === 'video' ? 'video'
    : targetItem.type === 'image' ? 'image'
    : 'raw';

  const destroyRes = await cloudinary.uploader.destroy(targetItem.public_id, { resource_type });
  console.log('🗑️ cloudinary destroy:', destroyRes);
}



    // 4) ลบออกจาก array แล้วอัปเดต DB
    const filtered = list.filter(item => !(
  typeof item === 'object' &&
  (item.from === 'completed' || item.tag === 'completed') &&
  normUrl(item.url) === normUrl(fileUrl)
));

    await db.promise().query('UPDATE requests SET photo = ? WHERE id = ?', [JSON.stringify(filtered), id]);

    // 5) sync ไปตาราง completed ด้วย
    const [rows2] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
    if (rows2 && rows2.length > 0) {
      await new Promise((resolve, reject) => {
        upsertToBucket('completed', rows2[0], (err) => err ? reject(err) : resolve());
      });
    }

    return res.json({ success:true, message:'✅ ลบไฟล์ completed แล้ว (ทั้ง DB + Cloudinary)' });

  } catch (err) {
    console.error('delete-completed-file error:', err);
    return res.status(500).json({ success:false, message:'❌ ลบไฟล์ไม่สำเร็จ' });
  }
});

app.get('/data-health-all', (req, res) => {
  const sql = `
    SELECT *
    FROM requests
    WHERE department = ?
      AND dept_accept = 1
      AND status IN ('รอดำเนินการ', 'กำลังดำเนินการ')
    ORDER BY id DESC
  `;

  db.query(sql, ['สาธารณสุข'], (err, results) => {
    if (err) {
      console.error('data-health-all error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get('/data-electric-all', (req, res) => {
  const sql = `
    SELECT *
    FROM requests
    WHERE department = ?
      AND dept_accept = 1
      AND status IN ('รอดำเนินการ', 'กำลังดำเนินการ')
    ORDER BY id DESC
  `;

  db.query(sql, ['ไฟฟ้า'], (err, results) => {
    if (err) {
      console.error('data-electric-all error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get('/data-engineer-all', (req, res) => {
  const sql = `
    SELECT *
    FROM requests
    WHERE department = ?
      AND dept_accept = 1
      AND status IN ('รอดำเนินการ', 'กำลังดำเนินการ')
    ORDER BY id DESC
  `;

  db.query(sql, ['กองช่าง'], (err, results) => {
    if (err) {
      console.error('data-engineer-all error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get('/data-other-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['อื่นๆ'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});
app.get('/data-approved-all', (req, res) => {
  const sql = `
    SELECT
      id,
      name,
      phone,
      address,
      category,
      message,
      latitude,
      longitude,
      photo,
      department,
      status,
      approved,
      processed,
      reject_reason,
      dept_reason,
      dept_accept,
      routed_to,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at
    FROM requests
    WHERE department IN ('สาธารณสุข', 'กองช่าง', 'ไฟฟ้า')
      AND (
        approved = 1
        OR dept_accept = 1
        OR status IN ('รอแผนกรับเรื่อง', 'รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น')
      )
      AND status NOT IN ('ไม่อนุมัติ', 'รอแอดมินหลัก')
    ORDER BY id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error('data-approved-all error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});


app.get('/data-health-inbox', (req, res) => {
  db.query(
    `SELECT * FROM requests
     WHERE department='สาธารณสุข'
       AND status='รอแผนกรับเรื่อง'
       AND dept_accept IS NULL
     ORDER BY id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(results);
    }
  );
});
app.get('/data-electric-inbox', (req, res) => {
  db.query(
    `SELECT * FROM requests
     WHERE department='ไฟฟ้า'
       AND status='รอแผนกรับเรื่อง'
       AND dept_accept IS NULL
     ORDER BY id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(results);
    }
  );
});
app.get('/data-engineer-inbox', (req, res) => {
  db.query(
    `SELECT * FROM requests
     WHERE department='กองช่าง'
       AND status='รอแผนกรับเรื่อง'
       AND dept_accept IS NULL
     ORDER BY id DESC`,
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(results);
    }
  );
});
app.get('/data-rejected', (req, res) => {
  const sql = 'SELECT * FROM requests WHERE processed = true AND approved = 0 ORDER BY id DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});
app.get('/rejected', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'rejected.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/approved-all', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'approved-all.html'));
  } else {
    res.redirect('/admin-login');
  }
});


app.get('/data-sp-all', (req, res) => {
  db.query(
    'SELECT * FROM requests WHERE department = ? ORDER BY id DESC',
    ['สำนักงานปลัด'],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
      res.json(results);
    }
  );
});

// GET /track (เอารายการล่าสุดของเบอร์นั้น)
app.get('/track', (req, res) => {
  const phone = req.query.phone;
  const sql = `
  SELECT
    id,
    message,
    status,
    reject_reason,
    photo,
    can_rate,
    rating,
    rating_comment,
    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
    DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at,
    DATE_FORMAT(rating_created_at, '%Y-%m-%d %H:%i:%s') AS rating_created_at
  FROM requests
  WHERE phone = ?
  ORDER BY created_at DESC
  LIMIT 1
`;
  db.query(sql, [phone], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (results.length === 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    res.json(results[0]);
  });
});

// POST /track-requests (รายการทั้งหมดของเบอร์นั้น)
app.post('/track-requests', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'กรุณาระบุเบอร์โทร' });

  const sql = `
    SELECT
      id,
      message,
      status,
      eta_text,
      reject_reason,
      photo,
      can_rate,
      rating,
      rating_comment,
      DATE_FORMAT(created_at,  '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(completed_at,'%Y-%m-%d %H:%i:%s') AS completed_at,
      DATE_FORMAT(rating_created_at,'%Y-%m-%d %H:%i:%s') AS rating_created_at
    FROM requests
    WHERE phone = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [phone], (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    res.json(results);
  });
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).send('❌ กรุณาระบุเบอร์โทร');
  }

  const sql = `INSERT INTO user_logins (phone) VALUES (?)`;

  db.query(sql, [phone], (err, result) => {
    if (err) {
      console.error('❌ บันทึกเบอร์โทรไม่สำเร็จ:', err);
      return res.status(500).send('❌ เกิดข้อผิดพลาดในการบันทึก');
    }

    console.log('✅ บันทึกเบอร์โทรแล้ว:', phone);
    res.json({ success: true });
  });
});
app.get('/track.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'track.html'));
});
// ✅ endpoint ใหม่สำหรับดึงข้อมูล "กำลังดำเนินการ"
// ดึงจากตาราง inprogress (แนะนำ)

app.get('/data-pending', (req, res) => {
  const { department } = req.query;

  let sql = `
    SELECT *
    FROM requests
    WHERE status = 'รอดำเนินการ'
      AND dept_accept = 1
  `;
  const params = [];

  if (department) {
    sql += ` AND department = ?`;
    params.push(department);
  }

  sql += ` ORDER BY id DESC`;

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('data-pending error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get('/data-in-progress', (req, res) => {
  const { department } = req.query;

  let sql = `
    SELECT *
    FROM requests
    WHERE status = 'กำลังดำเนินการ'
      AND dept_accept = 1
  `;
  const params = [];

  if (department) {
    sql += ` AND department = ?`;
    params.push(department);
  }

  sql += ` ORDER BY id DESC`;

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('data-in-progress error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

app.get('/data-completed', (req, res) => {
  const { department } = req.query;

  let sql = `
    SELECT *
    FROM requests
    WHERE status = 'เสร็จสิ้น'
      AND dept_accept = 1
  `;
  const params = [];

  if (department) {
    sql += ` AND department = ?`;
    params.push(department);
  }

  sql += ` ORDER BY id DESC`;

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('data-completed error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});



app.get('/export-health-excel', async (req, res) => {
  try {
    const sql = `
      SELECT id, name, phone, message, department, status, latitude, longitude, created_at
      FROM requests
      WHERE department = 'สาธารณสุข'
      ORDER BY created_at DESC
    `;

    db.query(sql, async (err, results) => {
      if (err) {
        console.error('Export health excel error:', err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานสาธารณสุข');

      // =========================
      // หัวรายงาน
      // =========================
      worksheet.mergeCells('A1:L1');
      worksheet.getCell('A1').value = 'รายงานคำร้อง - แผนกสาธารณสุข';
      worksheet.getCell('A1').font = {
        bold: true,
        size: 18
      };
      worksheet.getCell('A1').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };

      worksheet.mergeCells('A2:L2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };
      worksheet.getCell('A2').font = {
        size: 12,
        italic: true
      };

      worksheet.addRow([]);

      // =========================
      // คอลัมน์
      // =========================
      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 12 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ค้างกี่วัน', key: 'pending_days', width: 14 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at', width: 24 }
      ];

      const headerRowNumber = 4;
      const headerRow = worksheet.getRow(headerRowNumber);

      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ค้างกี่วัน',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      // =========================
      // style หัวตาราง
      // =========================
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      headerRow.height = 24;

      const now = new Date();

      // =========================
      // ใส่ข้อมูล
      // =========================
      results.forEach((row, index) => {
        let pendingDays = '';
        let mapLink = '';

        if (row.created_at) {
          const createdAt = new Date(row.created_at);
          const diffMs = now - createdAt;
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          pendingDays = `${diffDays} วัน`;
        }

        if (row.latitude && row.longitude) {
          mapLink = `https://maps.google.com/?q=${row.latitude},${row.longitude}`;
        }

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: row.id || '',
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          pending_days: pendingDays,
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        // จัดกลางบางคอลัมน์
        excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' };


        // ใส่สีตามสถานะในคอลัมน์ "สถานะ" (คอลัมน์ที่ 7)
        const statusCell = excelRow.getCell(7);
        const statusText = String(row.status || '').trim();

        if (
          statusText === 'รอดำเนินการ' ||
          statusText === 'รอแผนกรับเรื่อง' ||
          statusText === 'ใหม่'
        ) {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3CD' } // เหลืองอ่อน
          };
          statusCell.font = {
            bold: true,
            color: { argb: '856404' }
          };
        } else if (statusText === 'กำลังดำเนินการ') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5B4' } // ส้มอ่อน
          };
          statusCell.font = {
            bold: true,
            color: { argb: '9A3412' }
          };
        } else if (statusText === 'เสร็จสิ้น') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'D1FAE5' } // เขียวอ่อน
          };
          statusCell.font = {
            bold: true,
            color: { argb: '065F46' }
          };
        }

        
        // ทำคอลัมน์ลิงก์แผนที่ให้กดได้
        if (mapLink) {
          excelRow.getCell(11).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(11).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(11).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      // =========================
      // Freeze หัวตาราง
      // =========================
      worksheet.views = [
        { state: 'frozen', ySplit: 4 }
      ];

      // =========================
      // ตั้งชื่อไฟล์
      // =========================
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const fileName = `รายงานคำร้อง-สาธารณสุข-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export health excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
});

// ======================================
// Export Excel Health - Helper
// ======================================
async function exportHealthExcelFile(res, title, whereClause = '', params = []) {
  try {
    const sql = `
      SELECT id, name, phone, message, department, status, latitude, longitude, created_at
      FROM requests
      WHERE department = 'สาธารณสุข'
      ${whereClause}
      ORDER BY created_at DESC
    `;

    db.query(sql, params, async (err, results) => {
      if (err) {
        console.error('Export health excel error:', err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานสาธารณสุข');

      worksheet.mergeCells('A1:L1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = {
        bold: true,
        size: 18
      };
      worksheet.getCell('A1').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };

      worksheet.mergeCells('A2:L2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };
      worksheet.getCell('A2').font = {
        size: 12,
        italic: true
      };

      worksheet.addRow([]);

      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 12 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ค้างกี่วัน', key: 'pending_days', width: 14 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at', width: 24 }
      ];

      const headerRowNumber = 4;
      const headerRow = worksheet.getRow(headerRowNumber);

      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ค้างกี่วัน',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      headerRow.height = 24;

      const now = new Date();

      results.forEach((row, index) => {
        let pendingDays = '';
        let mapLink = '';

        if (row.created_at) {
          const createdAt = new Date(row.created_at);
          const diffMs = now - createdAt;
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          pendingDays = `${diffDays} วัน`;
        }

        if (row.latitude && row.longitude) {
          mapLink = `https://maps.google.com/?q=${row.latitude},${row.longitude}`;
        }

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: row.id || '',
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          pending_days: pendingDays,
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' };

        // สีตามสถานะ
        const statusCell = excelRow.getCell(7);
        const statusText = String(row.status || '').trim();

        if (
          statusText === 'รอดำเนินการ' ||
          statusText === 'รอแผนกรับเรื่อง' ||
          statusText === 'ใหม่'
        ) {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3CD' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '856404' }
          };
        } else if (statusText === 'กำลังดำเนินการ') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5B4' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '9A3412' }
          };
        } else if (statusText === 'เสร็จสิ้น') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'D1FAE5' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '065F46' }
          };
        }

        // ลิงก์แผนที่
        if (mapLink) {
          excelRow.getCell(11).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(11).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(11).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export health excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}

// ======================================
// Export Excel Electric - Helper
// ======================================
async function exportElectricExcelFile(res, title, whereClause = '', params = []) {
  try {
    const sql = `
      SELECT id, name, phone, message, department, status, latitude, longitude, created_at
      FROM requests
      WHERE department = 'ไฟฟ้า'
      ${whereClause}
      ORDER BY created_at DESC
    `;

    db.query(sql, params, async (err, results) => {
      if (err) {
        console.error('Export electric excel error:', err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานไฟฟ้า');

      // =========================
      // หัวรายงาน
      // =========================
      worksheet.mergeCells('A1:L1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = {
        bold: true,
        size: 18
      };
      worksheet.getCell('A1').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };

      worksheet.mergeCells('A2:L2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };
      worksheet.getCell('A2').font = {
        size: 12,
        italic: true
      };

      worksheet.addRow([]);

      // =========================
      // คอลัมน์
      // =========================
      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 12 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ค้างกี่วัน', key: 'pending_days', width: 14 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at', width: 24 }
      ];

      const headerRowNumber = 4;
      const headerRow = worksheet.getRow(headerRowNumber);

      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ค้างกี่วัน',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      // =========================
      // style หัวตาราง
      // =========================
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      headerRow.height = 24;

      const now = new Date();

      // =========================
      // ใส่ข้อมูล
      // =========================
      results.forEach((row, index) => {
        let pendingDays = '';
        let mapLink = '';

        if (row.created_at) {
          const createdAt = new Date(row.created_at);
          const diffMs = now - createdAt;
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          pendingDays = `${diffDays} วัน`;
        }

        if (row.latitude && row.longitude) {
          mapLink = `https://maps.google.com/?q=${row.latitude},${row.longitude}`;
        }

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: row.id || '',
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          pending_days: pendingDays,
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        // จัดกลางบางคอลัมน์
        excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' };

        // สีตามสถานะในคอลัมน์ "สถานะ"
        const statusCell = excelRow.getCell(7);
        const statusText = String(row.status || '').trim();

        if (
          statusText === 'รอดำเนินการ' ||
          statusText === 'รอแผนกรับเรื่อง' ||
          statusText === 'ใหม่'
        ) {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3CD' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '856404' }
          };
        } else if (statusText === 'กำลังดำเนินการ') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5B4' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '9A3412' }
          };
        } else if (statusText === 'เสร็จสิ้น') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'D1FAE5' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '065F46' }
          };
        }

        // ทำคอลัมน์ลิงก์แผนที่ให้กดได้
        if (mapLink) {
          excelRow.getCell(11).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(11).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(11).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      // Freeze หัวตาราง
      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      // ตั้งชื่อไฟล์
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export electric excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}

// ======================================
// Export Excel Electric - Bucket Helper
// ======================================
async function exportElectricBucketExcelFile(res, title, tableName) {
  try {
    const allowedTables = ['pending', 'inprogress', 'completed'];
    if (!allowedTables.includes(tableName)) {
      return res.status(400).send('ตารางที่ต้องการ export ไม่ถูกต้อง');
    }

    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE department = 'ไฟฟ้า'
      ORDER BY created_at DESC
    `;

    db.query(sql, async (err, results) => {
      if (err) {
        console.error(`Export electric bucket excel error [${tableName}]:`, err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานไฟฟ้า');

      worksheet.mergeCells('A1:K1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = { bold: true, size: 18 };
      worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

      worksheet.mergeCells('A2:K2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getCell('A2').font = { size: 12, italic: true };

      worksheet.addRow([]);

      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 14 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at_text', width: 24 }
      ];

      const headerRowNumber = 4;
      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      const headerRow = worksheet.getRow(headerRowNumber);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      results.forEach((row, index) => {
        const requestId = row.original_id || row.id || '';
        const mapLink = (row.latitude && row.longitude)
          ? `https://maps.google.com/?q=${row.latitude},${row.longitude}`
          : '';

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: requestId,
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at_text: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        if (mapLink) {
          excelRow.getCell(10).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(10).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(10).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export electric bucket excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}


function bangkokDateOnly(input = new Date()) {
  const d = new Date(input);
  const y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(d);
  const m = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', month: '2-digit' }).format(d);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', day: '2-digit' }).format(d);
  return `${y}-${m}-${day}`;
}

function buildAdminExcelFilters(req, opts = {}) {
  const { q = '', filter = 'all', status = 'all', departmentType = 'general' } = opts;
  const safeQ = String(q || '').trim().toLowerCase();
  const safeFilter = ['all', 'today', 'stale'].includes(String(filter || '').trim())
    ? String(filter || '').trim()
    : 'all';

  const clauses = ['AND dept_accept = 1'];
  const params = [];

  if (status === 'pending') {
    clauses.push(`AND status = 'รอดำเนินการ'`);
  } else if (status === 'inprogress') {
    clauses.push(`AND status = 'กำลังดำเนินการ'`);
  } else if (status === 'completed') {
    clauses.push(`AND status = 'เสร็จสิ้น'`);
  } else if (status === 'open') {
    clauses.push(`AND status IN ('รอดำเนินการ', 'กำลังดำเนินการ')`);
  } else if (status === 'all') {
    clauses.push(`AND status IN ('รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น')`);
  }

  if (safeQ) {
    clauses.push(`AND (LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(phone, '')) LIKE ?)`);
    params.push(`%${safeQ}%`, `%${safeQ}%`);
  }

  if (safeFilter === 'today') {
    clauses.push(`AND DATE(CONVERT_TZ(created_at, '+00:00', '+07:00')) = ?`);
    params.push(bangkokDateOnly(new Date()));
  } else if (safeFilter === 'stale') {
    if (status === 'pending') {
      clauses.push(`AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= ?`);
      params.push(7);
    } else if (status === 'inprogress') {
      clauses.push(`AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= ?`);
      params.push(3);
    } else if (status === 'open') {
      clauses.push(`AND ((status = 'รอดำเนินการ' AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= 7) OR (status = 'กำลังดำเนินการ' AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= 3))`);
    } else if (status === 'all') {
      clauses.push(`AND (
        (status = 'รอดำเนินการ' AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= 7)
        OR
        (status = 'กำลังดำเนินการ' AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= 3)
        OR
        (status = 'เสร็จสิ้น')
      )`);
    }
  }

  return { extraWhere: clauses.join('\n      '), params };
}

// ======================================
// Export Routes - Electric
// ======================================
app.get('/export-electric-excel-all', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'all',
    departmentType: 'electric'
  });

  exportElectricExcelFile(
    res,
    'รายงานคำร้อง-ไฟฟ้า-ทั้งหมด',
    extraWhere,
    params
  );
});

app.get('/export-electric-excel-pending', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'pending',
    departmentType: 'electric'
  });

  exportElectricExcelFile(
    res,
    'รายงานคำร้อง-ไฟฟ้า-รอดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-electric-excel-inprogress', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'inprogress',
    departmentType: 'electric'
  });

  exportElectricExcelFile(
    res,
    'รายงานคำร้อง-ไฟฟ้า-กำลังดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-electric-excel-completed', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'completed',
    departmentType: 'electric'
  });

  exportElectricExcelFile(
    res,
    'รายงานคำร้อง-ไฟฟ้า-เสร็จสิ้น',
    extraWhere,
    params
  );
});

// ======================================
// Export Excel Engineer - Helper
// ======================================
async function exportEngineerExcelFile(res, title, whereClause = '', params = []) {
  try {
    const sql = `
      SELECT id, name, phone, message, department, status, latitude, longitude, created_at
      FROM requests
      WHERE department = 'กองช่าง'
      ${whereClause}
      ORDER BY created_at DESC
    `;

    db.query(sql, params, async (err, results) => {
      if (err) {
        console.error('Export engineer excel error:', err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานกองช่าง');

      worksheet.mergeCells('A1:L1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = {
        bold: true,
        size: 18
      };
      worksheet.getCell('A1').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };

      worksheet.mergeCells('A2:L2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = {
        horizontal: 'center',
        vertical: 'middle'
      };
      worksheet.getCell('A2').font = {
        size: 12,
        italic: true
      };

      worksheet.addRow([]);

      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 12 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ค้างกี่วัน', key: 'pending_days', width: 14 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at', width: 24 }
      ];

      const headerRowNumber = 4;
      const headerRow = worksheet.getRow(headerRowNumber);

      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ค้างกี่วัน',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      headerRow.height = 24;

      const now = new Date();

      results.forEach((row, index) => {
        let pendingDays = '';
        let mapLink = '';

        if (row.created_at) {
          const createdAt = new Date(row.created_at);
          const diffMs = now - createdAt;
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          pendingDays = `${diffDays} วัน`;
        }

        if (row.latitude && row.longitude) {
          mapLink = `https://maps.google.com/?q=${row.latitude},${row.longitude}`;
        }

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: row.id || '',
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          pending_days: pendingDays,
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(10).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(12).alignment = { horizontal: 'center', vertical: 'middle' };

        const statusCell = excelRow.getCell(7);
        const statusText = String(row.status || '').trim();

        if (
          statusText === 'รอดำเนินการ' ||
          statusText === 'รอแผนกรับเรื่อง' ||
          statusText === 'ใหม่'
        ) {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3CD' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '856404' }
          };
        } else if (statusText === 'กำลังดำเนินการ') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE5B4' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '9A3412' }
          };
        } else if (statusText === 'เสร็จสิ้น') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'D1FAE5' }
          };
          statusCell.font = {
            bold: true,
            color: { argb: '065F46' }
          };
        }

        if (mapLink) {
          excelRow.getCell(11).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(11).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(11).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export engineer excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}

// ======================================
// Export Excel Engineer - Bucket Helper
// ======================================
async function exportEngineerBucketExcelFile(res, title, tableName) {
  try {
    const allowedTables = ['pending', 'inprogress', 'completed'];
    if (!allowedTables.includes(tableName)) {
      return res.status(400).send('ตารางที่ต้องการ export ไม่ถูกต้อง');
    }

    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE department = 'กองช่าง'
      ORDER BY created_at DESC
    `;

    db.query(sql, async (err, results) => {
      if (err) {
        console.error(`Export engineer bucket excel error [${tableName}]:`, err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานกองช่าง');

      worksheet.mergeCells('A1:K1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = { bold: true, size: 18 };
      worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

      worksheet.mergeCells('A2:K2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getCell('A2').font = { size: 12, italic: true };

      worksheet.addRow([]);

      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 14 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at_text', width: 24 }
      ];

      const headerRowNumber = 4;
      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      const headerRow = worksheet.getRow(headerRowNumber);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      results.forEach((row, index) => {
        const requestId = row.original_id || row.id || '';
        const mapLink = (row.latitude && row.longitude)
          ? `https://maps.google.com/?q=${row.latitude},${row.longitude}`
          : '';

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: requestId,
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at_text: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        if (mapLink) {
          excelRow.getCell(10).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(10).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(10).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export engineer bucket excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}

// ======================================
// Export Routes - Engineer
// ======================================
app.get('/export-engineer-excel', async (req, res) => {
  exportEngineerExcelFile(res, 'รายงานคำร้อง-กองช่าง');
});

app.get('/export-engineer-excel-all', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'all',
    departmentType: 'engineer'
  });

  exportEngineerExcelFile(
    res,
    'รายงานคำร้อง-กองช่าง-ทั้งหมด',
    extraWhere,
    params
  );
});

app.get('/export-engineer-excel-pending', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'pending',
    departmentType: 'engineer'
  });

  exportEngineerExcelFile(
    res,
    'รายงานคำร้อง-กองช่าง-รอดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-engineer-excel-inprogress', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'inprogress',
    departmentType: 'engineer'
  });

  exportEngineerExcelFile(
    res,
    'รายงานคำร้อง-กองช่าง-กำลังดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-engineer-excel-completed', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'completed',
    departmentType: 'engineer'
  });

  exportEngineerExcelFile(
    res,
    'รายงานคำร้อง-กองช่าง-เสร็จสิ้น',
    extraWhere,
    params
  );
});




// ======================================
// Export Routes
// ======================================
async function exportHealthBucketExcelFile(res, title, tableName) {
  try {
    const allowedTables = ['pending', 'inprogress', 'completed'];
    if (!allowedTables.includes(tableName)) {
      return res.status(400).send('ตารางที่ต้องการ export ไม่ถูกต้อง');
    }

    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE department = 'สาธารณสุข'
      ORDER BY created_at DESC
    `;

    db.query(sql, async (err, results) => {
      if (err) {
        console.error(`Export health bucket excel error [${tableName}]:`, err);
        return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูล');
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('งานสาธารณสุข');

      worksheet.mergeCells('A1:K1');
      worksheet.getCell('A1').value = title;
      worksheet.getCell('A1').font = { bold: true, size: 18 };
      worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

      worksheet.mergeCells('A2:K2');
      worksheet.getCell('A2').value = `วันที่ออกรายงาน: ${new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok'
      })}`;
      worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getCell('A2').font = { size: 12, italic: true };

      worksheet.addRow([]);

      worksheet.columns = [
        { header: 'ลำดับ', key: 'no', width: 10 },
        { header: 'รหัสคำร้อง', key: 'id', width: 14 },
        { header: 'ชื่อผู้แจ้ง', key: 'name', width: 22 },
        { header: 'เบอร์โทร', key: 'phone', width: 18 },
        { header: 'รายละเอียด', key: 'message', width: 38 },
        { header: 'แผนก', key: 'department', width: 18 },
        { header: 'สถานะ', key: 'status', width: 20 },
        { header: 'ละติจูด', key: 'latitude', width: 15 },
        { header: 'ลองจิจูด', key: 'longitude', width: 15 },
        { header: 'ลิงก์แผนที่', key: 'map_link', width: 34 },
        { header: 'วันที่แจ้ง', key: 'created_at_text', width: 24 }
      ];

      const headerRowNumber = 4;
      worksheet.getRow(headerRowNumber).values = [
        'ลำดับ',
        'รหัสคำร้อง',
        'ชื่อผู้แจ้ง',
        'เบอร์โทร',
        'รายละเอียด',
        'แผนก',
        'สถานะ',
        'ละติจูด',
        'ลองจิจูด',
        'ลิงก์แผนที่',
        'วันที่แจ้ง'
      ];

      const headerRow = worksheet.getRow(headerRowNumber);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '155263' }
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'CCCCCC' } },
          left: { style: 'thin', color: { argb: 'CCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
          right: { style: 'thin', color: { argb: 'CCCCCC' } }
        };
      });

      results.forEach((row, index) => {
        const requestId = row.original_id || row.id || '';
        const mapLink = (row.latitude && row.longitude)
          ? `https://maps.google.com/?q=${row.latitude},${row.longitude}`
          : '';

        const excelRow = worksheet.addRow({
          no: index + 1,
          id: requestId,
          name: row.name || '',
          phone: row.phone || '',
          message: row.message || '',
          department: row.department || '',
          status: row.status || '',
          latitude: row.latitude || '',
          longitude: row.longitude || '',
          map_link: mapLink,
          created_at_text: row.created_at
            ? new Date(row.created_at).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok'
              })
            : ''
        });

        excelRow.eachCell((cell) => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'left',
            wrapText: true
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'DDDDDD' } },
            left: { style: 'thin', color: { argb: 'DDDDDD' } },
            bottom: { style: 'thin', color: { argb: 'DDDDDD' } },
            right: { style: 'thin', color: { argb: 'DDDDDD' } }
          };
        });

        if (mapLink) {
          excelRow.getCell(10).value = {
            text: 'เปิดแผนที่',
            hyperlink: mapLink
          };
          excelRow.getCell(10).font = {
            color: { argb: '0000FF' },
            underline: true
          };
          excelRow.getCell(10).alignment = {
            horizontal: 'center',
            vertical: 'middle'
          };
        }
      });

      worksheet.views = [{ state: 'frozen', ySplit: 4 }];

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const safeTitle = title
        .replace(/\s+/g, '-')
        .replace(/[\/\\?%*:|"<>]/g, '');

      const fileName = `${safeTitle}-${yyyy}-${mm}-${dd}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    console.error('Export health bucket excel fatal error:', error);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้างไฟล์ Excel');
  }
}
// Excel ทั้งหมด
app.get('/export-health-excel-all', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'all',
    departmentType: 'health'
  });

  exportHealthExcelFile(
    res,
    'รายงานคำร้อง-สาธารณสุข-ทั้งหมด',
    extraWhere,
    params
  );
});

app.get('/export-health-excel-pending', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'pending',
    departmentType: 'health'
  });

  exportHealthExcelFile(
    res,
    'รายงานคำร้อง-สาธารณสุข-รอดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-health-excel-inprogress', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'inprogress',
    departmentType: 'health'
  });

  exportHealthExcelFile(
    res,
    'รายงานคำร้อง-สาธารณสุข-กำลังดำเนินการ',
    extraWhere,
    params
  );
});

app.get('/export-health-excel-completed', async (req, res) => {
  const { extraWhere, params } = buildAdminExcelFilters(req, {
    q: req.query.q,
    filter: req.query.filter,
    status: 'completed',
    departmentType: 'health'
  });

  exportHealthExcelFile(
    res,
    'รายงานคำร้อง-สาธารณสุข-เสร็จสิ้น',
    extraWhere,
    params
  );
});

app.post('/rate-request/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rating, comment } = req.body;

    const score = Number(rating);
    const safeComment = (comment || '').toString().trim();

    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาให้คะแนน 1 ถึง 5 ดาว'
      });
    }

    const [rows] = await db.promise().query(
      `SELECT id, status, can_rate, rating
       FROM requests
       WHERE id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบคำร้องนี้'
      });
    }

    const reqItem = rows[0];

    if (reqItem.status !== 'เสร็จสิ้น') {
      return res.status(400).json({
        success: false,
        message: 'คำร้องนี้ยังไม่สามารถให้คะแนนได้'
      });
    }

    if (Number(reqItem.can_rate) !== 1) {
      return res.status(400).json({
        success: false,
        message: 'คำร้องนี้ยังไม่เปิดให้ประเมิน'
      });
    }

    if (reqItem.rating !== null && reqItem.rating !== undefined) {
      return res.status(400).json({
        success: false,
        message: 'คำร้องนี้ถูกประเมินแล้ว'
      });
    }

    await db.promise().query(
      `UPDATE requests
       SET rating = ?, rating_comment = ?, rating_created_at = NOW()
       WHERE id = ?`,
      [score, safeComment || null, id]
    );

    return res.json({
      success: true,
      message: 'บันทึกคะแนนเรียบร้อยแล้ว'
    });
  } catch (error) {
    console.error('rate-request error:', error);
    return res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการบันทึกคะแนน'
    });
  }
});




app.get('/completed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'completed.html'));
});

// ✅ กันคนพิมพ์ /submit ใน URL (GET) ให้เด้งกลับหน้าฟอร์ม
app.get('/submit', (req, res) => {
  res.redirect('/'); // หรือ '/index.html' ถ้าคุณใช้ชื่อนั้น
});

app.use((req, res) => {
  res.status(404).send('ไม่พบหน้าเว็บที่คุณเรียก');
});

app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err);
  res.status(500).send('เกิดข้อผิดพลาดในเซิร์ฟเวอร์');
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
