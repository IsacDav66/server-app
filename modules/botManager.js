// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Verificar que la clave existe
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ CRÍTICO: GEMINI_API_KEY no definida en .env");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Intentando iniciar Sistema de Bot Autónomo...");

    const runPostCycle = async () => {
        try {
            // 1. Buscamos cualquier usuario marcado como bot
            const botResult = await pool.query("SELECT id, username, bio FROM usersapp WHERE is_bot = TRUE LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                console.error("⚠️ Aviso: No hay ningún usuario con is_bot = TRUE en la DB. Esperando 1 minuto...");
                setTimeout(runPostCycle, 60000); // Reintentar en 1 minuto
                return;
            }

            console.log(`🤖 Bot detectado: ${bot.username}. Generando contenido...`);

            // 2. Gemini
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `
                Tu nombre es ${bot.username}. Personalidad: ${bot.bio}.
                Escribe una publicación de red social para gamers muy corta (máximo 12 palabras).
                Usa emojis. Devuelve SOLO el texto.
            `;

            const result = await model.generateContent(prompt);
            const content = result.response.text().trim().replace(/"/g, '');

            // 3. Guardar en DB
            const insertQuery = `
                INSERT INTO postapp (user_id, content, created_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP) 
                RETURNING *;
            `;
            const postResult = await pool.query(insertQuery, [bot.id, content]);
            const newPost = postResult.rows[0];

            // 4. Emitir (Enriquecido para el frontend)
            if (io) {
                io.emit('new_post', {
                    ...newPost,
                    username: bot.username,
                    profile_pic_url: '/assets/img/default-avatar.png',
                    total_likes: 0,
                    total_comments: 0,
                    is_liked_by_user: false,
                    is_saved_by_user: false
                });
                console.log(`🚀 Post creado exitosamente por ${bot.username}: "${content}"`);
            }

        } catch (error) {
            console.error("❌ Error en el ciclo del bot:", error.message);
        }

        // Programar siguiente post (Entre 15 y 30 minutos para probar rápido)
        const nextMinutes = Math.floor(Math.random() * (30 - 15) + 15);
        console.log(`⏳ Próximo post en ${nextMinutes} minutos.`);
        setTimeout(runPostCycle, nextMinutes * 60 * 1000);
    };

    runPostCycle();
};

module.exports = { startAutonomousBot };