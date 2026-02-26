require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mysql = require('mysql2');

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
    const resource_type = mimetype.startsWith('video')
      ? 'video'
      : mimetype.startsWith('image')
      ? 'image'
      : 'raw';

    const stream = cloudinary.uploader.upload_stream(
      { resource_type, folder: 'hi-form' },
      (err, result) => (err ? reject(err) : resolve(result))
    );

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

  // Videos
  'video/mp4',
  'video/quicktime', // .mov
  'video/webm'
  // ถ้าคุณอยากรับ mkv เพิ่มค่อยใส่ 'video/x-matroska'
];

const memoryStorage = multer.memoryStorage();

// กรองชนิดไฟล์
function commonFileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`ไม่รองรับไฟล์ประเภท ${file.mimetype}`));
  }
  cb(null, true);
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

    const isImage = f.mimetype && f.mimetype.startsWith('image/');
    const isVideo = f.mimetype && f.mimetype.startsWith('video/');

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
app.get('/line/is-linked', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
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

const crypto = require('crypto');

function normalizeThaiPhone(input = '') {
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('66') && digits.length >= 11) return '0' + digits.slice(2);
  return digits;
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
async function pushLineImage(to, imageUrl) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE MOCK push image]', to, imageUrl);
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
      messages: [
        {
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl
        }
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

// ✅ ต้องอยู่ก่อน app.use(express.json())
app.post('/line/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.LINE_CHANNEL_SECRET;
    const signature = req.headers['x-line-signature'];

    // ✅ req.body ต้องเป็น Buffer
    const rawBody = req.body; // Buffer
    const bodyText = rawBody.toString('utf8');

    // Verify signature
    if (secret) {
      const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      if (hash !== signature) return res.status(401).send('Invalid signature');
    }

    const payload = JSON.parse(bodyText);
    const events = payload.events || [];

    for (const ev of events) {
      if (ev.type !== 'message') continue;
      if (ev.message?.type !== 'text') continue;

      const text = (ev.message.text || '').trim();
      const replyToken = ev.replyToken;
      const userId = ev.source?.userId;

      const m = text.match(/ผูกเบอร์\s*([0-9+ -]{8,20})/i);
      if (m && userId) {
        const phone = normalizeThaiPhone(m[1]);

        if (!/^0\d{8,9}$/.test(phone)) {
          await replyLineMessage(replyToken, '❌ เบอร์ไม่ถูกต้อง กรุณาส่ง: ผูกเบอร์ 08xxxxxxxx');
          continue;
        }

        await db.promise().query(
          `INSERT INTO line_links (phone, line_user_id)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE line_user_id=VALUES(line_user_id), updated_at=NOW()`,
          [phone, userId]
        );

        await replyLineMessage(replyToken, `✅ ผูกเบอร์ ${phone} สำเร็จ`);
      } else {
        await replyLineMessage(replyToken, 'พิมพ์: ผูกเบอร์ 08xxxxxxxx เพื่อรับแจ้งเตือน');
      }
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('LINE webhook error:', e);
    return res.status(500).send('Server error');
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));



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

      const category = '';

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
            type: f.mimetype.startsWith('video') ? 'video' :
                  f.mimetype.startsWith('image') ? 'image' : 'raw'
          };
        })
      );

      const photoUrl = JSON.stringify(uploaded);

      const sql = `
        INSERT INTO requests 
        (name, phone, address, category, message, latitude, longitude, photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const values = [name, phone, address, category, message, latitude, longitude, photoUrl];

      db.query(sql, values, (err, result) => {
        if (err) {
          console.error('❌ บันทึกข้อมูลล้มเหลว:', err);
          return res.status(500).send('❌ บันทึกไม่สำเร็จ');
        }

        sendEmail(
          '📬 แจ้งเตือนคำร้องใหม่',
          `ชื่อ: ${name}\nเบอร์โทร: ${phone}\nที่อยู่: ${address}\nข้อความ: ${message}\nจำนวนไฟล์แนบ: ${files.length} ไฟล์`
        );

        const requestId = result.insertId; // ✅ เลขคำร้องที่เพิ่ง insert

        console.log('✅ บันทึกคำร้อง:', JSON.stringify(result, null, 2));

        // ✅ ส่งเลขคำร้อง + เบอร์ ไปหน้า success
        return res.redirect(`/submit-success.html?rid=${requestId}&phone=${encodeURIComponent(phone)}`);
      });

    } catch (error) {
      console.error('💥 เกิดข้อผิดพลาดไม่คาดคิด:', error);
      return res.status(400).send(error.message || '💥 เกิดข้อผิดพลาดไม่คาดคิด');
    }
  });
});
app.get('/data-today', (req, res) => {
  // 🔒 ป้องกันคนไม่ได้ล็อกอินเข้ามาเรียก API นี้ (แนะนำ)
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  }

  const department = req.query.department;
  let sql = `
    SELECT * FROM requests
    WHERE processed = false
      AND DATE(created_at) = CURDATE()
  `;
  const params = [];

  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }

  sql += ' ORDER BY id DESC';

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error('❌ /data-today error:', err);
      return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลคำร้องวันนี้' });
    }
    res.json(results);
  });
});
app.get('/data', (req, res) => {
  const department = req.query.department;
  let sql = 'SELECT * FROM requests WHERE processed = false';
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

app.post('/approve/:id', (req, res) => {
  const id = req.params.id;
  db.query('UPDATE requests SET approved = 1, processed = true WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('❌ อนุมัติไม่สำเร็จ');
    res.send('✅ อนุมัติสำเร็จ');
  });
});

app.post('/reject/:id', (req, res) => {
  const id = req.params.id;
  const { reason } = req.body;

  const sql = 'UPDATE requests SET status = ?, reject_reason = ?, approved = 0, processed = true WHERE id = ?';
  db.query(sql, ['ไม่อนุมัติ', reason, id], (err, result) => {
    if (err) return res.status(500).send('เกิดข้อผิดพลาด');
    
    res.send('ไม่อนุมัติคำร้องเรียบร้อยแล้ว'); // ✅ ใช้ข้อความตอบกลับแทน redirect
  });
});




app.post('/set-department/:id', (req, res) => {
  const { department } = req.body;
  const id = req.params.id;

  console.log(`📌 รับข้อมูลเปลี่ยนแผนก id=${id}, department=${department}`);

  if (!department) {
    return res.status(400).json({ message: '❌ ต้องระบุแผนก' });
  }

  db.query('UPDATE requests SET department = ? WHERE id = ?', [department, id], (err, result) => {
    if (err) {
      console.error('❌ SQL error:', err);
      return res.status(500).json({ message: '❌ เปลี่ยนแผนกไม่สำเร็จ' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '❌ ไม่พบคำร้องนี้' });
    }

    console.log(`✅ อัปเดตแผนก id=${id} -> ${department}`);
    res.json({ message: '✅ เปลี่ยนแผนกแล้ว' });
  });
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
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: '❌ ต้องระบุ status' });
    }

    // กันพลาด: "เสร็จสิ้น" ต้องใช้ /complete-with-media/:id
    if (status === 'เสร็จสิ้น') {
      return res.status(400).json({
        success: false,
        message: '❌ สถานะ "เสร็จสิ้น" กรุณาใช้ /complete-with-media/:id'
      });
    }

    // 1) update ใน requests
    await db.promise().query(
      'UPDATE requests SET status = ? WHERE id = ?',
      [status, id]
    );

    // 2) ดึงแถวล่าสุด
    const [rows] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
    }
    const r = rows[0];

    // 3) map status -> bucket table
    let bucket = null;
    if (status === 'รอดำเนินการ') bucket = 'pending';
    if (status === 'กำลังดำเนินการ') bucket = 'inprogress';

    // 4) upsert เข้า bucket + ลบออกจาก bucket อื่น
    if (bucket) {
      await new Promise((resolve, reject) => {
        upsertToBucket(bucket, r, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise((resolve) => removeFromOtherBuckets(r.id, bucket, resolve));
    }

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

      // ✅ ถ้าต้องการบังคับให้ต้องแนบไฟล์อย่างน้อย 1 ไฟล์
      if (!files.length) {
        return res.status(400).json({ success: false, message: '❌ กรุณาเลือกไฟล์อย่างน้อย 1 ไฟล์' });
      }

      // ✅ ตรวจขนาดรวม + แยกรูป/วิดีโอ
      validateFiles(files, {
        maxTotalSize: MAX_TOTAL_SIZE_COMPLETE,
        maxImageSize: MAX_IMAGE_SIZE,
        maxVideoSize: MAX_VIDEO_SIZE
      });

      // 1) ดึงแถวเดิม
      const [rows] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
      if (!rows || rows.length === 0) {
        return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
      }
      const r = rows[0];

      // 2) แปลง photo เดิม -> array
      let list = [];
      try { list = Array.isArray(r.photo) ? r.photo : JSON.parse(r.photo || '[]'); } catch { list = []; }

      // 3) อัปโหลดไฟล์ใหม่ขึ้น Cloudinary
      const uploadedExtra = await Promise.all(
        files.map(async (f) => {
          const result = await uploadBufferToCloudinary(f.buffer, f.mimetype);
          return {
            url: result.secure_url,
            public_id: result.public_id,
            type: f.mimetype?.startsWith('video') ? 'video'
                : f.mimetype?.startsWith('image') ? 'image'
                : 'raw',
            from: 'completed',
            tag: 'completed'
          };
        })
      );

      // 4) รวมของเดิม + ของใหม่
      const merged = [...list, ...uploadedExtra];

      // 5) อัปเดตตารางหลัก
      await db.promise().query(
        `UPDATE requests SET status='เสร็จสิ้น', photo=?, completed_at=NOW() WHERE id=?`,
        [JSON.stringify(merged), id]
      );

      // 6) ดึงข้อมูลล่าสุด แล้ว upsert ไป completed + ลบจาก bucket อื่น
      const [rows2] = await db.promise().query('SELECT * FROM requests WHERE id = ?', [id]);
      if (rows2 && rows2.length > 0) {
        const r2 = rows2[0];

        await new Promise((resolve, reject) => {
          upsertToBucket('completed', r2, (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve) => removeFromOtherBuckets(r2.id, 'completed', resolve));
      }
      
      // ✅ 7) ส่งแจ้งเตือน LINE (กันส่งซ้ำด้วย notified_completed_at)
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
              [rq.phone]
            );

            if (linkRows?.length) {
              const lineUserId = linkRows[0].line_user_id;

              const msg =
                `✅ คำร้องเลขที่ ${rq.id} ดำเนินการ "เสร็จสิ้น" แล้ว\n` +
                `ขอบคุณที่แจ้งเรื่องครับ`;

              await pushLineMessage(lineUserId, msg);
              // ส่งรูปทั้งหมดที่แนบตอนเสร็จสิ้น (เฉพาะ type=image)
              for (const f of uploadedExtra) {
                if (f.type === 'image') {
                  await pushLineImage(lineUserId, f.url);
                }
              }

              // วิดีโอ: แนะนำส่งเป็นลิงก์ข้อความก่อน (ง่ายสุด)
              const videos = uploadedExtra.filter(x => x.type === 'video');
              if (videos.length) {
                const list = videos.map((v,i)=>`${i+1}) ${v.url}`).join('\n');
                await pushLineMessage(lineUserId, `🎥 ไฟล์วิดีโอแนบตอนเสร็จสิ้น:\n${list}`);
              }
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
      return res.json({ success: true, message: '✅ อัปเดตเป็น "เสร็จสิ้น" และแนบไฟล์เรียบร้อย' });

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

app.get('/data-engineer-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['กองช่าง'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

app.get('/data-health-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['สาธารณสุข'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

app.get('/data-electric-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['ไฟฟ้า'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
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
  const sql = 'SELECT * FROM requests WHERE approved = 1 ORDER BY id DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
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
      id, message, status, reject_reason, photo,
      DATE_FORMAT(created_at,  '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(completed_at,'%Y-%m-%d %H:%i:%s') AS completed_at
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
      id, message, status, reject_reason, photo,
      DATE_FORMAT(created_at,  '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(completed_at,'%Y-%m-%d %H:%i:%s') AS completed_at
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
  res.sendFile(__dirname + '/public/track.html');
});
// ✅ endpoint ใหม่สำหรับดึงข้อมูล "กำลังดำเนินการ"
// ดึงจากตาราง inprogress (แนะนำ)

app.get('/data-in-progress', (req, res) => {
  const department = req.query.department;

  let sql = 'SELECT * FROM inprogress';
  const params = [];

  if (department) {
    sql += ' WHERE department = ?';
    params.push(department);
  }

  sql += ' ORDER BY created_at DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// ดึงข้อมูลจาก pending
app.get('/data-pending', (req, res) => {
  const department = req.query.department;

  let sql = 'SELECT * FROM pending';
  const params = [];

  if (department) {
    sql += ' WHERE department = ?';
    params.push(department);
  }

  sql += ' ORDER BY created_at DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});


// Completed
app.get('/data-completed', (req, res) => {
  const department = req.query.department;

  let sql = 'SELECT * FROM completed';
  const params = [];

  if (department) {
    sql += ' WHERE department = ?';
    params.push(department);
  }

  sql += ' ORDER BY created_at DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
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

