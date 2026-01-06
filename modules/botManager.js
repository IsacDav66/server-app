// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo (Aiko) activo.");

    const runPostCycle = async () => {
        try {
            // 1. Obtener datos del bot
            const botResult = await pool.query("SELECT id, username, bio, profile_pic_url FROM usersapp WHERE is_bot = TRUE LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                setTimeout(runPostCycle, 60000);
                return;
            }

            // 2. Configurar IA
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                apiVersion: 'v1' 
            });

            const prompt = `
                Tu nombre es ${bot.username}. Personalidad: ${bot.bio}.
                Escribe un post de red social gamer muy corto (máximo 12 palabras).
                Usa emojis. Responde SOLO con el texto del post.
            `;

            // 3. Intentar generar contenido
            let content = "";
            try {
                    // 1. Usamos API_BASE_URL (la que importaste arriba)
                    const response = await fetch(`${API_BASE_URL}/api/admin/bots/upload-pic/${id}`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                        },
                        body: formData
                    });

                    const result = await response.json();

                    if (result.success) {
                        // 2. Usamos getFullImageUrl (tu helper) para evitar el "undefined"
                        imgElement.src = `${getFullImageUrl(result.profilePicUrl)}?t=${Date.now()}`;
                    } else {
                        alert("Error al subir: " + result.message);
                    }
                } catch (err) {
                    console.error("Error en subida:", err);
                    alert("Error de conexión al subir la imagen.");
                } finally {
                    imgElement.style.filter = "";
                    imgElement.style.opacity = "1";
                }

        } catch (error) {
            console.error("❌ Error crítico en el ciclo del bot:", error.message);
        }

        // 4. Programar siguiente intento SIEMPRE (para que el bot no muera)
        const nextTime = (Math.floor(Math.random() * 20) + 20) * 60 * 1000;
        console.log(`⏳ Próximo intento de publicación en ${nextTime / 60000} minutos.`);
        setTimeout(runPostCycle, nextTime);
    };

    runPostCycle();
};

module.exports = { startAutonomousBot };