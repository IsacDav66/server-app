// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inicializamos Gemini con la clave del .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo (Aiko) activo.");

    const runPostCycle = async () => {
        try {
            // 1. Obtener datos del bot desde la base de datos
            const botResult = await pool.query("SELECT id, username, bio, profile_pic_url FROM usersapp WHERE is_bot = TRUE LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                console.warn("⚠️ No se encontró ningún bot en la DB. Reintentando en 1 minuto...");
                setTimeout(runPostCycle, 60000);
                return;
            }

            // 2. Configurar el modelo de IA
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                apiVersion: 'v1' 
            });

            const prompt = `
                Tu nombre es ${bot.username}. Tu personalidad es: ${bot.bio}.
                Escribe una publicación muy corta (máximo 12 palabras) para tu muro de red social.
                Habla sobre juegos, anime o tecnología. Usa emojis.
                Responde SOLO con el texto del post, sin comillas.
            `;

            // 3. Generar contenido con la IA
            try {
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const content = response.text().trim().replace(/"/g, '');
                
                if (content && content.length > 0) {
                    // 4. Guardar el post en la base de datos
                    const insertQuery = `
                        INSERT INTO postapp (user_id, content, created_at) 
                        VALUES ($1, $2, CURRENT_TIMESTAMP) 
                        RETURNING *;
                    `;
                    const postResult = await pool.query(insertQuery, [bot.id, content]);
                    const newPost = postResult.rows[0];

                    // 5. Emitir el post por Socket.io para que aparezca en la app sin recargar
                    if (io) {
                        io.emit('new_post', {
                            ...newPost,
                            username: bot.username,
                            profile_pic_url: bot.profile_pic_url,
                            total_likes: 0,
                            total_comments: 0,
                            is_liked_by_user: false,
                            is_saved_by_user: false
                        });
                    }
                    console.log(`🚀 [${bot.username}] Publicó: "${content}"`);
                }
            } catch (apiError) {
                console.error(`⚠️ Error en la API de Gemini: ${apiError.message}`);
            }

        } catch (error) {
            console.error("❌ Error crítico en el ciclo del bot:", error.message);
        }

        // Programar el siguiente post (tiempo aleatorio entre 20 y 40 minutos)
        const nextTime = (Math.floor(Math.random() * 20) + 20) * 60 * 1000;
        console.log(`⏳ Siguiente intento de publicación en ${nextTime / 60000} minutos.`);
        setTimeout(runPostCycle, nextTime);
    };

    // Iniciar el ciclo
    runPostCycle();
};

module.exports = { startAutonomousBot };