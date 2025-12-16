// ==========================================================
// 🌍 خبير الهجرة - Server (Secure & Optimized)
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
  max: 5, 
  message: { error: "محاولات دخول كثيرة جداً، يرجى الانتظار 15 دقيقة." }
});

// ===============================================
// 🔒 2. إعدادات CORS
// ===============================================

const allowedOrigins = [
  "http://localhost:3000", 
  "http://localhost:5173", 
  "https://travel2-3sms.onrender.com" // ✅ رابط موقعك
];

app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(new Error('غير مسموح لهذا النطاق بالوصول للسيرفر (CORS policy)'), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));

// 🧠 مفاتيح البيئة
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ملف .env ناقص: تأكد من وجود جميع المفاتيح");
  process.exit(1);
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

    if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "البريد الإلكتروني غير صالح" });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) throw error;

    await supabase.from("profiles").insert([{ 
        user_id: data.user.id, 
        display_name: email.split('@')[0] 
    }]);

    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: "يرجى إدخال البريد وكلمة المرور" });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    res.status(400).json({ error: "فشل تسجيل الدخول، تحقق من البيانات." });
  }
});

// ===============================================
// 💳 Subscription
// ===============================================
app.get("/api/subscription", authenticateUser, async (req, res) => {
  try {
    const { data: subscription, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (error) throw error;
    return res.json({ subscription });
  } catch (err) {
    res.status(500).json({ error: "Server error checking subscription" });
  }
});

// ===============================================
// 🧠 توليد الخطة (AI) - باستخدام Gemini 2.5 Flash
// ===============================================
app.post("/api/generate-plan", authenticateUser, async (req, res) => {
  try {
    const { conversationId, country, qaList } = req.body;
    const userId = req.user.id;

    if (!qaList || !country) {
        return res.status(400).json({ error: "بيانات ناقصة" });
    }

    let interviewText = qaList.map(item => {
        const safeQuestion = item.question ? item.question.substring(0, 200) : "";
        const safeAnswer = item.answer ? item.answer.substring(0, 1000) : ""; 
        return `- س: ${safeQuestion}\n- ج: ${safeAnswer}`;
    }).join("\n");

    const planPrompt = `
    انت خبير هجرة ومستشار قانوني دولي.
    مهمتك: إنشاء خطة هجرة مفصلة لدولة (${country}).
    
    البيانات التالية هي إجابات المستخدم في مقابلة:
    --- بداية البيانات ---
    ${interviewText}
    --- نهاية البيانات ---

    اكتب تقرير مفصل يحتوي على:
    1. 📊 تحليل الملف الشخصي.
    2. ✈️ الفيزا المقترحة.
    3. 💰 التكاليف المتوقعة.
    4. 📝 المستندات المطلوبة.
    5. ⏳ الجدول الزمني.
    6. 💡 نصائح لزيادة القبول.

    التنسيق: Markdown، عناوين واضحة، وإيموجي.
    `;

    // 🔥 هنا تم التحديث لاستخدام Gemini 2.5 Flash كما طلبت
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: planPrompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const planText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "حدث خطأ أثناء توليد الخطة.";

    const { error: insertError } = await supabase.from("chat_history").insert([
      {
        user_id: userId,
        conversation_id: conversationId,
        role: "assistant",
        message: planText,
        country: country,
        is_plan: true
      }
    ]);

    if (insertError) {
        console.error("❌ Database Insert Error:", insertError.message);
        return res.status(500).json({ error: "تم التوليد ولكن فشل الحفظ" });
    }

    res.json({ plan: planText });

  } catch (err) {
    console.error("AI Generation Error:", err?.response?.data || err.message);
    res.status(500).json({ error: "فشل توليد الخطة" });
  }
});

// ===============================================
// 💬 إدارة المحادثات
// ===============================================

app.post("/api/chat/history", authenticateUser, async (req, res) => {
    try {
        const { conversationId } = req.body;
        const userId = req.user.id;

        if (!conversationId) {
            return res.status(400).json({ error: "Conversation ID required" });
        }

        const { data, error } = await supabase
            .from("chat_history")
            .select("role, message, created_at, is_plan") 
            .eq("user_id", userId)
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: true })
            .limit(100); 

        if (error) throw error;
        res.json({ history: data });

    } catch (err) {
        console.error("Fetch History Error:", err.message);
        res.status(500).json({ error: "فشل جلب الرسائل" });
    }
});

app.post("/api/chat/clear", authenticateUser, async (req, res) => {
    try {
        const { conversationId } = req.body;
        const userId = req.user.id;

        const { error } = await supabase
            .from("chat_history")
            .delete()
            .eq("user_id", userId)
            .eq("conversation_id", conversationId);
            
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===============================================
// 📂 Static Files
// ===============================================
app.use(express.static(path.join(__dirname, "public")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running securely on port ${PORT}`);
});
