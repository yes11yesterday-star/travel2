// ==========================================================
// 🌍 خبير الهجرة - Server (Fixed & Clean)
// ==========================================================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===============================================
// 🛡️ 1. إعدادات الأمان
// ===============================================
app.set('trust proxy', 1); // هام جداً لعمل rateLimit على Render

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { error: "تم تجاوز الحد المسموح من الطلبات، يرجى المحاولة لاحقاً." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // زيادة الحد قليلاً لتجنب المشاكل أثناء الاختبار
  message: { error: "محاولات دخول كثيرة جداً، يرجى الانتظار 15 دقيقة." }
});

// ===============================================
// 🔒 2. إعدادات CORS
// ===============================================

const allowedOrigins = [
  "http://localhost:3000", 
  "http://localhost:5173", 
  "https://travel2-3sms.onrender.com" // ✅ رابط موقعك على Render
];

app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(null, true); // السماح مؤقتاً لتجنب مشاكل الحظر أثناء الإصلاح
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

app.use(express.json({ limit: "10mb" }));

// 🧠 مفاتيح البيئة
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ملف .env ناقص: تأكد من وجود جميع المفاتيح في إعدادات Render");
  // لن نوقف السيرفر هنا لكي لا ينهار، لكن سنطبع تحذيراً
}

// 🔗 Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===============================================
// 🛡️ Middleware: التحقق من صحة المستخدم
// ===============================================
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "مطلوب تسجيل الدخول (No Token)" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "جلسة غير صالحة أو منتهية" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth Error:", err);
    res.status(500).json({ error: "خطأ في التحقق من الهوية" });
  }
};

// ===============================================
// 🔐 Auth Endpoints
// ===============================================

app.post("/api/signup", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !email.includes("@")) return res.status(400).json({ error: "البريد غير صالح" });
    if (!password || password.length < 6) return res.status(400).json({ error: "كلمة المرور قصيرة" });

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) throw error;

    await supabase.from("profiles").insert([{ user_id: data.user.id, display_name: email.split('@')[0] }]);

    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    res.status(400).json({ error: "فشل الدخول" });
  }
});

// ===============================================
// 💳 Subscription
// ===============================================
app.get("/api/subscription", authenticateUser, async (req, res) => {
  try {
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    return res.json({ subscription });
  } catch (err) {
    res.status(500).json({ error: "خطأ في فحص الاشتراك" });
  }
});

// ===============================================
// 🧠 توليد الخطة (Gemini 2.5 Flash)
// ===============================================
app.post("/api/generate-plan", authenticateUser, async (req, res) => {
  try {
    const { conversationId, country, qaList } = req.body;
    const userId = req.user.id;

    if (!qaList || !country) return res.status(400).json({ error: "بيانات ناقصة" });

    let interviewText = qaList.map(item => `- س: ${item.question}\n- ج: ${item.answer}`).join("\n");

    const planPrompt = `
    انت خبير هجرة. أنشئ خطة هجرة مفصلة لدولة (${country}) بناءً على:
    ${interviewText}
    
    التقرير يجب أن يحتوي: تحليل الملف، الفيزا، التكاليف، المستندات، الجدول الزمني.
    التنسيق: Markdown.
    `;

    // ✅ استخدام Gemini 2.5 Flash كما طلبت
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: planPrompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const planText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "عذراً، لم أتمكن من توليد الخطة.";

    await supabase.from("chat_history").insert([
      {
        user_id: userId,
        conversation_id: conversationId,
        role: "assistant",
        message: planText,
        country: country,
        is_plan: true
      }
    ]);

    res.json({ plan: planText });

  } catch (err) {
    console.error("AI Error:", err?.response?.data || err.message);
    // في حال فشل 2.5 نرجع رسالة خطأ واضحة
    res.status(500).json({ error: "فشل الاتصال بالذكاء الاصطناعي" });
  }
});

// ===============================================
// 💬 إدارة المحادثات (History) - تم تصحيحها لتعمل كـ POST
// ===============================================
app.post("/api/chat/history", authenticateUser, async (req, res) => {
    try {
        const { conversationId } = req.body; // ✅ قراءة من Body
        const userId = req.user.id;

        const { data } = await supabase
            .from("chat_history")
            .select("role, message, created_at, is_plan") 
            .eq("user_id", userId)
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: true })
            .limit(100); 

        res.json({ history: data || [] });

    } catch (err) {
        res.status(500).json({ error: "فشل جلب الرسائل" });
    }
});

app.post("/api/chat/clear", authenticateUser, async (req, res) => {
    try {
        const { conversationId } = req.body;
        const userId = req.user.id;
        await supabase.from("chat_history").delete().eq("user_id", userId).eq("conversation_id", conversationId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===============================================
// 📂 تشغيل السيرفر
// ===============================================
app.use(express.static(path.join(__dirname, "public")));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
