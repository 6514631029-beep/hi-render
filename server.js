require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mysql = require('mysql2');

const session = require('express-session');
const fs = require('fs');
const path = require('path');

const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;
// ✅ สร้างโฟลเดอร์ uploads อัตโนมัติ (กัน Render ไม่มีโฟลเดอร์)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir); // ✅ ใช้ตัวนี้แทน 'uploads/'
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});


const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


app.use(session({
  secret: process.env.SESSION_SECRET || 'hi-form-secret',
  resave: false,
  saveUninitialized: false
}));

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


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
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
      console.error('❌ ส่งอีเมลไม่สำเร็จ:', error.message);
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
app.post('/submit', upload.array('mediaFiles'), async (req, res) => {
  try {
    console.log('📨 รับข้อมูลใหม่:', JSON.stringify(req.body, null, 2));
    console.log('🖼️ req.files:', req.files);

    const files = req.files || [];
    const { name, phone, address, message } = req.body;
    const latitude = req.body.latitude ? parseFloat(req.body.latitude) : null;
    const longitude = req.body.longitude ? parseFloat(req.body.longitude) : null;

    const category = '';

    if (!name || !phone || !address || !message) {
      return res.status(400).send('❌ ข้อมูลไม่ครบ');
    }

    const photoUrls = files.map(f => {
      let type = 'other';
      if (f.mimetype.startsWith('image')) {
        type = 'image';
      } else if (f.mimetype.startsWith('video')) {
        type = 'video';
      }
      return {
        url: `/uploads/${f.filename}`, // จากเดิมเคยใช้ f.path
        type
      };
    });
    const photoUrl = JSON.stringify(photoUrls);
    

   

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

      // ✅ เพิ่มตรงนี้: ส่งอีเมลแจ้งเตือน
      sendEmail(
        '📬 แจ้งเตือนคำร้องใหม่',
        `ชื่อ: ${name}\nเบอร์โทร: ${phone}\nที่อยู่: ${address}\nข้อความ: ${message}`
      );

      console.log('✅ บันทึกคำร้อง:', JSON.stringify(result, null, 2));
      return res.redirect('/submit-success.html');

        
    });


  } catch (error) {
    console.error('💥 เกิดข้อผิดพลาดไม่คาดคิด:', error);
    res.status(500).send('💥 เกิดข้อผิดพลาดไม่คาดคิด');
  }
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

// ✅ เพิ่มฟังก์ชันเปลี่ยนสถานะ
// ✅ เปลี่ยนสถานะ + ถ้าเป็น "กำลังดำเนินการ" ให้คัดลอกไป inprogress
// เปลี่ยนสถานะ + คัดลอกเข้า bucket ที่ตรงสถานะ + ลบออกจาก bucket อื่น
app.post('/set-status/:id', (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  if (!status) return res.status(400).json({ success: false, message: '❌ ต้องระบุสถานะ' });

  // 1) อัปเดตสถานะในตารางหลัก
  db.query('UPDATE requests SET status = ? WHERE id = ?', [status, id], (updErr, updRes) => {
    if (updErr) {
      console.error('❌ เปลี่ยนสถานะไม่สำเร็จ:', updErr);
      return res.status(500).json({ success: false, message: '❌ เกิดข้อผิดพลาดในฐานข้อมูล' });
    }
    if (updRes.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
    }

    // 2) ดึงข้อมูลแถวนั้นมา
    db.query('SELECT * FROM requests WHERE id = ?', [id], (selErr, rows) => {
      if (selErr) {
        console.error('❌ ดึงข้อมูลไม่สำเร็จ:', selErr);
        return res.status(500).json({ success: false, message: '❌ ดึงข้อมูลไม่สำเร็จ' });
      }
      if (!rows || rows.length === 0) {
        return res.status(404).json({ success: false, message: '❌ ไม่พบข้อมูลต้นทาง' });
      }

      const r = rows[0];

      // 3) เลือก bucket เป้าหมายตามสถานะ
      let bucket = null;
      if (status === 'รอดำเนินการ') bucket = 'pending';
      else if (status === 'กำลังดำเนินการ') bucket = 'inprogress';
      else if (status === 'เสร็จสิ้น') bucket = 'completed';

      if (!bucket) {
        console.log(`✅ อัปเดตสถานะ id=${id} -> ${status} (ไม่คัดลอก)`);
        return res.json({ success: true, message: '✅ เปลี่ยนสถานะสำเร็จ' });
      }

      // 4) upsert เข้า bucket
      upsertToBucket(bucket, r, (insErr) => {
        if (insErr) {
          console.error(`❌ upsert เข้า ${bucket} ไม่สำเร็จ:`, insErr);
          return res.status(500).json({ success: false, message: `❌ บันทึกเข้า ${bucket} ไม่สำเร็จ` });
        }

        // 5) ลบออกจาก bucket อื่น ๆ กันค้างสองที่
        removeFromOtherBuckets(r.id, bucket, () => {
          console.log(`✅ ย้าย id=${id} -> ${bucket} แล้ว`);
          res.json({ success: true, message: `✅ ย้ายเข้า ${bucket} แล้ว`, movedTo: bucket });
        });
      });
    });
  });
});
// ✅ แนบไฟล์ + เปลี่ยนสถานะเป็น "เสร็จสิ้น"
app.post('/complete-with-media/:id', upload.array('extraFiles'), (req, res) => {
  const id = req.params.id;
  const files = req.files || [];

  // 1) ดึงแถวเดิม
  db.query('SELECT * FROM requests WHERE id = ?', [id], (selErr, rows) => {
    if (selErr) return res.status(500).json({ success:false, message:'❌ ดึงข้อมูลไม่สำเร็จ' });
    if (!rows || rows.length === 0) return res.status(404).json({ success:false, message:'❌ ไม่พบคำร้องนี้' });

    // 2) รวมรูปเดิม + ไฟล์ใหม่ (ติด tag completed)
    const r = rows[0];
    let list = [];
    try { list = Array.isArray(r.photo) ? r.photo : JSON.parse(r.photo || '[]'); } catch { list = []; }

    const newItems = files.map(f => ({
      url: `/uploads/${f.filename}`,
      type: f.mimetype?.startsWith('video') ? 'video' : (f.mimetype?.startsWith('image') ? 'image' : 'other'),
      from: 'completed',
      tag:  'completed'
    }));

    const merged = [...list, ...newItems];

    // 3) อัปเดตตารางหลัก
    const sqlUpd = `
      UPDATE requests
      SET status='เสร็จสิ้น', photo=?, completed_at=NOW()
      WHERE id=?`;
    db.query(sqlUpd, [JSON.stringify(merged), id], (updErr, updRes) => {
      if (updErr) return res.status(500).json({ success:false, message:'❌ อัปเดตคำร้องไม่สำเร็จ' });
      if (updRes.affectedRows === 0) return res.status(404).json({ success:false, message:'❌ ไม่พบคำร้องนี้' });

      // 4) ดึงซ้ำแล้ว upsert ไป bucket completed และลบจาก bucket อื่น
      db.query('SELECT * FROM requests WHERE id = ?', [id], (sel2Err, rows2) => {
        if (sel2Err || !rows2 || rows2.length === 0) return res.json({ success:true, message:'✅ อัปเดตแล้ว' });
        const r2 = rows2[0];
        upsertToBucket('completed', r2, (insErr) => {
          if (insErr) return res.json({ success:true, message:'✅ อัปเดตแล้ว (ซิงก์ completed ล้มเหลวบ้าง)' });
          removeFromOtherBuckets(r2.id, 'completed', () =>
            res.json({ success:true, message:'✅ อัปเดตเป็น "เสร็จสิ้น" และแนบไฟล์เรียบร้อย' })
          );
        });
      });
    });
  });
});

// ✅ ลบเฉพาะไฟล์ที่แนบตอน "เสร็จสิ้น"
// ✅ ลบ “เฉพาะไฟล์ที่แนบตอนเสร็จสิ้น” + ซิงก์ตาราง completed
app.post('/delete-completed-file/:id', (req, res) => {
  const id = req.params.id;
  let { fileUrl } = req.body || {};

  if (!fileUrl) {
    return res.status(400).json({ success: false, message: '❌ ต้องระบุ URL ของไฟล์ที่จะลบ' });
  }

  // ช่วยให้เทียบ URL ได้แม่นยำ (ตัดโดเมน, ตัด / นำหน้า)
  const norm = (u) => (u || '')
    .replace(/^https?:\/\/[^/]+/i, '')  // ตัดโดเมนออก
    .replace(/^\/+/, '');               // ตัด "/" หน้า URL ออก

  const target = norm(fileUrl);

  // 1) ดึงรายการภาพ/คลิปจาก requests
  db.query('SELECT * FROM requests WHERE id = ?', [id], (selErr, rows) => {
    if (selErr) {
      console.error('❌ ดึงข้อมูลไม่สำเร็จ:', selErr);
      return res.status(500).json({ success: false, message: '❌ ดึงข้อมูลไม่สำเร็จ' });
    }
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: '❌ ไม่พบคำร้องนี้' });
    }

    const r = rows[0];

    // แปลง photo -> array ให้ได้เสมอ
    let list = [];
    try {
      list = Array.isArray(r.photo) ? r.photo : JSON.parse(r.photo || '[]');
    } catch {
      list = [];
    }

    // 2) เก็บ “เฉพาะไฟล์ที่ไม่ใช่ตัวที่จะลบ” หรือ “เป็นตัวที่จะลบแต่ไม่ใช่ completed”
    const filtered = list.filter(item => {
      // รองรับทั้ง string และ object
      const url = typeof item === 'string' ? item : (item?.url || '');
      const urlNorm = norm(url);
      const isCompleted = (typeof item === 'object') && (item.from === 'completed' || item.tag === 'completed');

      // เก็บไว้ถ้า:
      // - URL ไม่ตรงกับเป้าหมาย
      // - หรือ URL ตรง แต่ไฟล์นั้นไม่ใช่ completed (กันเผลอลบไฟล์หลัก)
      return urlNorm !== target || !isCompleted;
    });

    // 3) อัปเดตกลับเข้า requests
    db.query('UPDATE requests SET photo = ? WHERE id = ?', [JSON.stringify(filtered), id], (updErr) => {
      if (updErr) {
        console.error('❌ อัปเดต photo ไม่สำเร็จ:', updErr);
        return res.status(500).json({ success: false, message: '❌ ลบไฟล์ไม่สำเร็จ' });
      }

      // 4) ดึงแถวล่าสุดหลังอัปเดต เพื่อ upsert เข้า bucket "completed"
      db.query('SELECT * FROM requests WHERE id = ?', [id], (sel2Err, rows2) => {
        if (sel2Err || !rows2 || rows2.length === 0) {
          // กรณีดึงไม่สำเร็จ ก็ถือว่าลบใน requests แล้ว
          return res.json({ success: true, message: '✅ ลบไฟล์ (completed) เรียบร้อย' });
        }

        const r2 = rows2[0];
        upsertToBucket('completed', r2, (insErr) => {
          if (insErr) {
            console.error('⚠️ upsert เข้า completed ไม่สำเร็จ (แต่ลบใน requests แล้ว):', insErr);
            // ยังตอบ success ได้ เพราะจุดประสงค์หลักคือ “ลบไฟล์ completed ในแถวหลัก”
            return res.json({ success: true, message: '✅ ลบไฟล์ (completed) แล้ว (ซิงก์ completed ล้มเหลวบ้าง)' });
          }
          // ไม่ต้องลบ bucket อื่น เพราะสถานะยังเป็น "เสร็จสิ้น"
          return res.json({ success: true, message: '✅ ลบไฟล์ (completed) แล้ว และซิงก์รายการเสร็จสิ้น' });
        });
      });
    });
  });
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
  const sql = 'SELECT * FROM inprogress ORDER BY created_at DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});
// ดึงข้อมูลจาก pending
app.get('/data-pending', (req, res) => {
  db.query('SELECT * FROM pending ORDER BY id DESC', (err, results) => {
    if (err) {
      console.error(err);
      res.status(500).send('Database error');
    } else {
      res.json(results);
    }
  });
});

// Completed
app.get('/data-completed', (req, res) => {
  db.query('SELECT * FROM completed ORDER BY created_at DESC', (err, results) => {

    if (err) {
      console.error("DB ERROR:", err); // 👈 จะได้เห็น error ใน terminal
      res.status(500).send('Database error');
    } else {
      res.json(results);
    }
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

