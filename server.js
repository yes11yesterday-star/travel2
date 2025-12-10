// ==========================================================
// 🌍 خبير الهجرة - Server (Fixed & Forgiving)
// ==========================================================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();

// إعدادات CORS
app.use(cors());

// زيادة حجم البيانات المسموح بها
app.use(express.json({ limit: "10mb" }));

// 🧠 التحقق من مفاتيح البيئة
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ تحذير: بعض مفاتيح .env ناقصة، السيرفر قد لا يعمل بشكل كامل.");
}

// 🔗 الاتصال بـ Supabase
// نستخدم try-catch هنا لمنع توقف السيرفر إذا كان الاتصال خاطئاً
let supabase;
try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} catch (err) {
    console.error("Supabase Connection Error:", err.message);
}

// ===============================================
// 🛡️ إعدادات الحماية (Rate Limiting)
// ===============================================
const planLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 10, // رفعنا الحد قليلاً للتجارب
  message: { error: "تجاوزت الحد المسموح. انتظر قليلاً." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===============================================
// 🔐 نقاط النهاية (Auth & Subscription)
// ===============================================

app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    // محاولة إنشاء بروفايل، إذا فشلت لا نوقف العملية
    try { await supabase.from("profiles").insert([{ user_id: data.user.id, display_name: email }]); } catch (e) {}
    
    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

app.get("/api/subscription", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return res.json({ subscription: null });

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return res.json({ subscription: null });

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    return res.json({ subscription });
  } catch (err) {
    console.error("Sub Error:", err.message);
    res.json({ subscription: null }); // لا نرسل خطأ، نرسل عدم وجود اشتراك فقط
  }
});

// ===============================================
// 🧠 توليد الخطة (الكود المعدل جذرياً)
// ===============================================
app.post("/api/generate-plan", planLimiter, async (req, res) => {
  try {
    const { userId, conversationId, country, qaList } = req.body;

    console.log("🚀 جاري بدء توليد الخطة...");

    let interviewText = "";
    if (qaList && Array.isArray(qaList)) {
        interviewText = qaList.map(item => `❓ السؤال: ${item.question}\n🗣️ الإجابة: ${item.answer}`).join("\n\n");
    }

    const planPrompt = `
    بصفتك مستشار هجرة خبير، قم بإنشاء "خطة هجرة استراتيجية وشاملة" لدولة (${country}) بناءً على بيانات المستفيد:
    ${interviewText}
    
    المطلوب تقرير مفصل جداً واحترافي:
    1. تحليل الملف الشخصي.
    2. أفضل مسار للهجرة (اسم الفيزا).
    3. التكاليف المالية (تقدير).
    4. قائمة المستندات.
    5. الجدول الزمني.
    6. نصائح ذهبية.
    
    استخدم الرموز التعبيرية ونسق النص بشكل ممتاز.
    `;

    // 1. طلب الخطة من Gemini
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: planPrompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const planText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!planText) {
        throw new Error("لم يرجع Gemini أي نص.");
    }

    console.log("✅ تم توليد الخطة بنجاح!");

    // 2. محاولة الحفظ في قاعدة البيانات (بشكل منفصل)
    // 🔥 التعديل هنا: إذا فشل الحفظ، سنطبع الخطأ في الكونسول ولكن لن نوقف الرد للمستخدم 🔥
    try {
        const { error: insertError } = await supabase.from("chat_history").insert([
          {
            user_id: userId,
            conversation_id: conversationId,
            role: "assistant",
            message: planText,
            // لقد حذفت الأعمدة الإضافية (country, is_plan) مؤقتاً لتجنب الأخطاء إذا لم تكن موجودة في جدولك
            // إذا كنت متأكداً أنها موجودة في Supabase، يمكنك إعادتها
          }
        ]);

        if (insertError) {
            console.error("⚠️ فشل حفظ الخطة في القاعدة (لكن سيتم عرضها للمستخدم):", insertError.message);
        } else {
            console.log("💾 تم حفظ الخطة في القاعدة بنجاح.");
        }
    } catch (dbError) {
        console.error("⚠️ خطأ غير متوقع أثناء الحفظ:", dbError.message);
    }

    // 3. إرسال الخطة للمستخدم (الأهم)
    res.json({ plan: planText });

  } catch (err) {
    console.error("❌ خطأ كارثي في التوليد:", err.response?.data || err.message);
    res.status(500).json({ error: "فشل توليد الخطة. يرجى المحاولة مرة أخرى." });
  }
});

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

    if (error) res.json({ history: [] }); // إذا حدث خطأ نرجع مصفوفة فارغة بدلاً من الخطأ
    else res.json({ history: data });
  } catch (err) {
    res.json({ history: [] });
  }
});

app.post("/api/chat/clear", async (req, res) => {
    try {
        const { userId, conversationId } = req.body;
        await supabase.from("chat_history").delete().eq("user_id", userId).eq("conversation_id", conversationId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// الملفات الثابتة
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running (Forgiving Mode) on port ${PORT}`);
});
