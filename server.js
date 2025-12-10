// ==========================================================
// 🌍 خبير الهجرة - Server (Secured & Optimized)
// ==========================================================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit"); // مكتبة الحماية من الإغراق
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();

// إعدادات CORS للسماح بالاتصال من الواجهة الأمامية
app.use(cors());

// زيادة حجم البيانات المسموح بها (للصور أو النصوص الطويلة)
app.use(express.json({ limit: "10mb" }));

// 🧠 التحقق من مفاتيح البيئة
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ خطأ: ملف .env ناقص، تأكد من وجود جميع المفاتيح.");
  process.exit(1);
}

// 🔗 الاتصال بـ Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===============================================
// 🛡️ إعدادات الحماية (Rate Limiting)
// ===============================================
// حماية رابط توليد الخطة: يسمح بـ 5 طلبات فقط كل 15 دقيقة لكل IP
const planLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 5, // الحد الأقصى للطلبات
  message: { error: "⛔ تجاوزت الحد المسموح لتوليد الخطط. يرجى المحاولة بعد 15 دقيقة." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===============================================
// 🔐 نقاط النهاية (Auth & Subscription)
// ===============================================

// إنشاء حساب
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    await supabase.from("profiles").insert([{ user_id: data.user.id, display_name: email }]);
    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// تسجيل دخول
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// التحقق من الاشتراك
app.get("/api/subscription", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Missing token" });

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: "Invalid token" });

    const { data: subscription, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    return res.json({ subscription });
  } catch (err) {
    console.error("Subscription Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================================
// 🧠 توليد الخطة (محمي بـ Rate Limit)
// ===============================================
app.post("/api/generate-plan", planLimiter, async (req, res) => {
  try {
    const { userId, conversationId, country, qaList } = req.body;

    // تحويل الأسئلة والأجوبة لنص
    let interviewText = "";
    if (qaList && Array.isArray(qaList)) {
        interviewText = qaList.map(item => `❓ السؤال: ${item.question}\n🗣️ الإجابة: ${item.answer}`).join("\n\n");
    }

    const planPrompt = `
    بصفتك مستشار هجرة خبير، قم بإنشاء "خطة هجرة استراتيجية وشاملة" لدولة (${country}) بناءً على مقابلة المستفيد التالية:

    ${interviewText}

    المطلوب منك كتابة تقرير مفصل جداً واحترافي يحتوي على الأقسام التالية بوضوح:
    1. 📊 **تحليل الملف الشخصي**: تقييم صريح لنقاط القوة والضعف بناءً على الإجابات.
    2. ✈️ **أفضل مسار للهجرة**: حدد اسم الفيزا أو البرنامج الأنسب لهذا الشخص تحديداً.
    3. 💰 **التكاليف المالية**: تقدير دقيق للرسوم الحكومية، تذاكر الطيران، وتكاليف المعيشة.
    4. 📝 **قائمة المستندات**: الأوراق المطلوبة خطوة بخطوة.
    5. ⏳ **الجدول الزمني**: كم تستغرق العملية.
    6. 💡 **نصائح ذهبية**: حيل قانونية لزيادة فرص القبول.

    اجعل النص طويلاً، مفصلاً، منسقاً بعناية، واستخدم الرموز التعبيرية (Emojis).
    `;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: planPrompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const planText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "عذراً، لم نتمكن من توليد الخطة حالياً.";

    // حفظ الخطة في Supabase
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

    // معالجة خطأ قاعدة البيانات بشكل آمن (لا نفضح التفاصيل للمستخدم)
    if (insertError) {
        console.error("❌ Database Error (Secure Log):", insertError.message);
        return res.status(500).json({ error: "تم توليد الخطة ولكن حدث خطأ أثناء حفظها في السجل." });
    }

    res.json({ plan: planText });

  } catch (err) {
    console.error("Generation Error:", err.message);
    res.status(500).json({ error: "فشل توليد الخطة، يرجى المحاولة لاحقاً." });
  }
});

// ===============================================
// 📥 استرجاع وحذف السجلات
// ===============================================

// استرجاع السجل
app.post("/api/chat/history", async (req, res) => {
  try {
    const { userId, conversationId } = req.body;
    const { data, error } = await supabase
      .from("chat_history")
      .select("*")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    console.error("History Error:", err.message);
    res.status(500).json({ error: "فشل استرجاع السجل" });
  }
});

// حذف السجل (البدء من جديد)
app.post("/api/chat/clear", async (req, res) => {
    try {
        const { userId, conversationId } = req.body;
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
// 🚀 إعدادات الملفات الثابتة (Public Folder) - الحماية النهائية
// ===============================================

// 1. تحديد مجلد 'public' كمجلد للملفات الثابتة
app.use(express.static(path.join(__dirname, "public")));

// 2. إعادة توجيه أي رابط غير معروف إلى index.html (لدعم Single Page Application)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running securely on port ${PORT}`);
});